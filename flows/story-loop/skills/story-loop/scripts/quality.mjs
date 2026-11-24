#!/usr/bin/env node
// The quality gate: what a machine can say about the diff before any reviewer
// reads it. Lint on the changed files must be clean, and every slop signal in
// the added lines is removed or stands with a recorded reason.
//   node quality.mjs [--base <base>] --lint '<command>' [--lint '<command>']...
//   node quality.mjs [--base <base>] --no-lint "<why this repo has no linter for these files>"
// Signals, read from the added lines only (what was there before is not this change's):
//   lint-disable        a linter or type checker switched off in place
//   skipped-test        a test skipped, pending or focused
//   workaround-comment  a comment that explains a shortcut instead of removing it
//   size                the diff is larger than the lane the human signed off
// The result is this attempt's evidence for the code tree it ran on.
// ponytail: textual signals, one regex per kind. Structural measures (complexity,
// duplication) are the repo's linter's job: pass it with --lint.
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { GRAPH, findRoot, load, emit, gitIn, dirty, headTree, headCommit, baseName, diffBase, opStart, opUpdate, opEnd, qualityProblem } from './loop.mjs'
import { changedLines } from './mutate.mjs'

const fail = message => { throw new Error(message) }
const IS_TEST = /(^|\/)(spec|specs|test|tests|__tests__)\/|[._-](spec|test)\.[a-z]+$/i
const GENERATED = /(^|\/)(package-lock\.json|yarn\.lock|bun\.lockb?|Gemfile\.lock|pnpm-lock\.yaml|schema\.rb|structure\.sql)$|\.snap$|\.min\.(js|css)$/
const COMMENT = String.raw`(?:#|//|/\*|\*|<!--|-#|--)`
const SIGNALS = [
  ['lint-disable', /rubocop:(?:disable|todo)|eslint-disable|@ts-(?:ignore|expect-error|nocheck)|stylelint-disable|haml-lint:disable|#\s*noqa\b|#\s*type:\s*ignore/, () => true],
  ['skipped-test', /\b(?:xit|xdescribe|xcontext|fit|fdescribe|fcontext)\b|\b(?:it|describe|context|test)\.(?:skip|only|todo)\b|^\s*(?:skip|pending)\b/, file => IS_TEST.test(file)],
  ['workaround-comment', new RegExp(`${COMMENT}.*\\b(?:workaround|hack|for now|temporar(?:y|ily)|quick fix|TODO|FIXME|XXX)\\b`, 'i'), () => true],
]

// The signals in one file's added lines: { "<file>:<line>:<kind>": { kind, file, line, text } }.
export function signalsFor(file, lines) {
  const flags = {}
  for (const [line, text] of lines) for (const [kind, pattern, applies] of SIGNALS) {
    if (applies(file) && pattern.test(text)) flags[`${file}:${line}:${kind}`] = { kind, file, line, text: text.trim().slice(0, 200) }
  }
  return flags
}

function main(argv) {
  const opt = { lint: [] }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--lint') opt.lint.push(argv[++i])
    else if (argv[i] === '--no-lint') opt.noLint = argv[++i]
    else if (argv[i] === '--base') opt.base = argv[++i]
    else fail('usage: quality.mjs [--base <base>] --lint \'<command>\'... | --no-lint "<reason>"')
  }
  opt.lint.length || opt.noLint?.trim() || fail('name the lint command(s) for the changed files (--lint \'bundle exec rubocop app/x.rb\'), or say why there is none: --no-lint "<reason>"')
  const root = findRoot() ?? fail('no active story-loop run here')
  const run = load(root)
  const base = opt.base ?? run.base ?? fail('record the base branch first (loop.mjs put base <branch>), or pass --base')
  dirty(root) && fail('the checkout has uncommitted changes; the gate covers committed code')
  const git = gitIn(root)
  const ctx = opStart(root, 'quality', 'quality', { base, lint: opt.lint })
  try {
    const range = `${diffBase(git, base)}...HEAD`
    const files = git('diff', '--name-only', '--diff-filter=AMR', range).split('\n').filter(Boolean)
    let flags = {}
    for (const file of files) {
      if (GENERATED.test(file)) continue
      const wanted = new Set(changedLines(git('diff', '-U0', range, '--', file)))
      if (!wanted.size) continue
      let source = ''
      try { source = git('show', `HEAD:${file}`) } catch { continue }
      if (source.includes('\0')) continue // a binary file has no lines to read
      const lines = source.split('\n').map((text, i) => [i + 1, text]).filter(([n]) => wanted.has(n))
      flags = { ...flags, ...signalsFor(file, lines) }
    }
    const size = { files: 0, added: 0, removed: 0 }
    for (const row of git('diff', '--numstat', range).split('\n').filter(Boolean)) {
      const [added, removed, file] = row.split('\t')
      if (GENERATED.test(file)) continue
      size.files += 1; size.added += Number(added) || 0; size.removed += Number(removed) || 0
    }
    const lane = run.lane?.lane ?? null
    const budget = GRAPH.lanes[lane]?.diff_lines ?? null
    if (budget !== null && size.added + size.removed > budget)
      flags.size = { kind: 'size', text: `${size.added + size.removed} changed lines; the ${lane} lane was signed off for ${budget}. Split the story, or have the human accept the size` }
    const lint = opt.lint.map(command => {
      // ponytail: the command is the conductor's, run as written in the repo root.
      const r = spawnSync('sh', ['-c', command], { cwd: root, encoding: 'utf8', timeout: 10 * 60_000, maxBuffer: 32 << 20 })
      return { command, exit: r.status ?? (r.signal ? `signal ${r.signal}` : 'did not run'), output: `${r.stdout ?? ''}${r.stderr ?? ''}`.slice(-2000) }
    })
    const tree = headTree(root)
    const next = opUpdate(root, ctx, r => {
      const earlier = r.evidence?.quality
      // A reason was given for one line of one tree; on other code it has to be given again.
      const kept = earlier?.tree === tree ? Object.fromEntries(Object.entries(earlier.dispositions ?? {}).filter(([id]) => id in flags)) : {}
      const quality = { tree, commit: headCommit(root), base: baseName(base), lint, no_lint: opt.noLint ?? null, flags, dispositions: kept, size: { ...size, lane, budget }, at: new Date().toISOString() }
      return { ...r, evidence: { ...r.evidence, quality } }
    }, { flags, lint, size })
    const q = next.evidence.quality
    for (const l of lint) console.log(`lint ${l.exit === 0 ? 'clean ' : 'FAILED'}  ${l.command}${l.exit === 0 ? '' : `\n${l.output}`}`)
    if (opt.noLint) console.log(`no lint: ${opt.noLint}`)
    console.log(`${size.files} files, +${size.added} −${size.removed}${budget === null ? '' : ` (${lane} lane: ${budget})`}`)
    for (const [id, f] of Object.entries(flags)) console.log(`${q.dispositions[id] ? 'accepted' : 'SIGNAL  '}  ${id}  ${f.text}`)
    const problem = qualityProblem(q)
    console.log(problem ? `quality gate: ${problem}` : 'quality gate: clean')
    emit(root, { kind: 'note', text: `quality gate: ${Object.keys(flags).length} signal${Object.keys(flags).length === 1 ? '' : 's'}, lint ${lint.every(l => l.exit === 0) ? 'clean' : 'failed'}` })
    opEnd(root, ctx, 'ok', problem ?? 'clean')
    if (problem) process.exitCode = 1
  } catch (error) {
    opEnd(root, ctx, error.kind === 'stale' ? 'stale' : 'failed', error.message)
    throw error
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)) } catch (error) { console.error(`quality: ${error.message}`); process.exit(error.kind === 'stale' ? 4 : 1) }
}
