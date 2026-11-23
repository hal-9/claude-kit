#!/usr/bin/env node
// Mutation testing on the lines a story changed, with nothing to install.
//   node mutate.mjs --test '<command that runs the covering tests>' [--base origin/main] [--max 25] [--timeout 300] [--link <path>]... <file>...
// Runs in a throwaway git worktree of HEAD, so the checkout is never touched,
// whatever happens to this process. For every changed line it applies one small
// break at a time (flip a comparison, move a boundary, swap and/or, ...), checks
// the mutant still parses, runs the test command and records the outcome.
// --link symlinks an untracked path the tests need (node_modules is linked by default).
// ponytail: mutants are textual, one operator per line; a syntax check drops
// unparsable ones, but some survivors are equivalent. Swap in Stryker/mutant if
// a budget appears.
import { readFileSync, writeFileSync, existsSync, mkdirSync, symlinkSync, rmSync, readdirSync } from 'node:fs'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findRoot, update, emit, headTree, runDir, load } from './loop.mjs'

const COMMON = [
  [/===/, '!=='], [/!==/, '==='], [/(?<![=!])==(?!=)/, '!='], [/!=(?!=)/, '=='],
  [/>=/, '>'], [/<=/, '<'], [/ > /, ' >= '], [/ < /, ' <= '],
  [/&&/, '||'], [/\|\|/, '&&'], [/\btrue\b/, 'false'], [/\bfalse\b/, 'true'],
  [/\b(\d+)\b/, (_, n) => String(Number(n) + 1)],
]
const RUBY = [
  [/\bif\b/, 'unless'], [/\bunless\b/, 'if'], [/\.present\?/, '.blank?'], [/\.blank\?/, '.present?'],
  [/\.any\?/, '.none?'], [/\.none\?/, '.any?'], [/\.empty\?/, '.any?'],
]
const OPERATORS = { '.rb': [...COMMON, ...RUBY], '.js': COMMON, '.jsx': COMMON, '.ts': COMMON, '.tsx': COMMON, '.mjs': COMMON, '.cjs': COMMON }
// How a mutant is checked to still be valid code. Types without one are run, and say so.
const SYNTAX = { '.js': ['node', '--check'], '.mjs': ['node', '--check'], '.cjs': ['node', '--check'], '.rb': ['ruby', '-c'] }
const IS_TEST = /(^|\/)(spec|tests?|__tests__)\/|[._](spec|test)\.[a-z]+$/
const WORKTREE_PREFIX = 'story-loop-mut-'

// Every single-operator variant of one source line.
export function mutantsFor(line, ext) {
  if (/^\s*(#|\/\/|\*|$)/.test(line)) return []
  const out = []
  for (const [pattern, replacement] of OPERATORS[ext] ?? []) {
    const mutated = line.replace(pattern, replacement)
    if (mutated !== line && !out.includes(mutated)) out.push(mutated)
  }
  return out
}

// Line numbers (1-based, in the new file) that a unified -U0 diff added or changed.
export function changedLines(diff) {
  const lines = []
  for (const [, start, count = '1'] of diff.matchAll(/^@@ -\S+ \+(\d+)(?:,(\d+))? @@/gm))
    for (let i = 0; i < Number(count); i++) lines.push(Number(start) + i)
  return lines
}

// What one test run says about a valid mutant. Only a real test failure is a kill.
export function classify({ code, signal, timedOut, error }) {
  if (error) return 'infra'
  if (timedOut) return 'timeout'
  if (code === 0) return 'survived'
  if (code === 126 || code === 127) return 'infra' // the command itself could not run
  if (code === null) return 'inconclusive' // killed by a signal we did not send
  return 'killed'
}

let active = null // { child, worktree, root } for the signal handlers
function cleanup() {
  if (!active) return
  try { if (active.child?.pid) process.kill(-active.child.pid, 'SIGKILL') } catch {}
  try { execFileSync('git', ['worktree', 'remove', '--force', active.worktree], { cwd: active.root, stdio: 'ignore' }) } catch {}
  rmSync(active.worktree, { recursive: true, force: true })
  active = null
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { cleanup(); process.exit(128 + ({ SIGINT: 2, SIGTERM: 15, SIGHUP: 1 })[sig]) })

// Worktrees left by a run that was killed hard (SIGKILL) are removed on the next run.
function pruneAbandoned(root) {
  for (const name of readdirSync(tmpdir()).filter(n => n.startsWith(WORKTREE_PREFIX))) {
    const pid = Number(name.slice(WORKTREE_PREFIX.length).split('-')[0])
    let alive = true
    try { process.kill(pid, 0) } catch (error) { alive = error.code !== 'ESRCH' }
    if (!alive) rmSync(join(tmpdir(), name), { recursive: true, force: true })
  }
  try { execFileSync('git', ['worktree', 'prune'], { cwd: root, stdio: 'ignore' }) } catch {}
}

function runTests(command, cwd, seconds) {
  return new Promise(done => {
    let out = '', timedOut = false
    const child = spawn(command, { shell: true, cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    if (active) active.child = child
    const keep = chunk => { out = (out + chunk).slice(-4000) }
    child.stdout.on('data', keep); child.stderr.on('data', keep)
    const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, 'SIGKILL') } catch {} }, seconds * 1000)
    child.on('error', error => { clearTimeout(timer); done({ error, out }) })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      try { process.kill(-child.pid, 'SIGKILL') } catch {} // stragglers of the group
      done({ code, signal, timedOut, out })
    })
  })
}

async function main(argv) {
  const opt = { base: 'origin/main', max: 25, timeout: 300, files: [], link: ['node_modules'] }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--link') opt.link.push(argv[++i])
    else if (argv[i].startsWith('--')) opt[argv[i].slice(2)] = argv[++i]
    else opt.files.push(argv[i])
  }
  if (!opt.test || !opt.files.length) throw new Error("usage: mutate.mjs --test '<command>' [--base ref] [--max n] [--timeout s] [--link path] <file>...")
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' })
  for (const file of opt.files)
    if (git('status', '--porcelain', '--', file).trim()) throw new Error(`${file} has uncommitted changes; commit first, mutants are judged on committed code`)
  const base = git('merge-base', opt.base, 'HEAD').trim()
  const tree = headTree(root)

  pruneAbandoned(root)
  const worktree = join(tmpdir(), `${WORKTREE_PREFIX}${process.pid}-${Date.now()}`)
  git('worktree', 'add', '--detach', '--quiet', worktree, 'HEAD')
  active = { worktree, root }
  for (const path of opt.link) {
    const from = resolve(root, path)
    if (!existsSync(from) || existsSync(join(worktree, path))) continue
    mkdirSync(dirname(join(worktree, path)), { recursive: true })
    symlinkSync(from, join(worktree, path))
  }

  const results = []
  let skipped = 0
  const unsupported = []
  try {
    const baseline = await runTests(opt.test, worktree, Number(opt.timeout))
    if (baseline.code !== 0)
      throw new Error(`the test command fails on unmutated code in the disposable copy (${classify(baseline)}); fix that first, or --link the untracked files it needs.\n${baseline.out.slice(-1500)}`)
    for (const file of opt.files) {
      const ext = extname(file)
      if (IS_TEST.test(file) || !OPERATORS[ext]) { unsupported.push(file); console.log(`skip ${file} (test file or unsupported type)`); continue }
      const path = join(worktree, file)
      const original = readFileSync(path, 'utf8')
      const lines = original.split('\n')
      for (const n of changedLines(git('diff', '-U0', base, 'HEAD', '--', file))) {
        for (const mutated of mutantsFor(lines[n - 1] ?? '', ext)) {
          if (results.length >= Number(opt.max)) { skipped++; continue }
          const row = { file, line: n, from: lines[n - 1].trim(), to: mutated.trim() }
          writeFileSync(path, lines.with(n - 1, mutated).join('\n'))
          const syntax = SYNTAX[ext] && spawnSync(SYNTAX[ext][0], [...SYNTAX[ext].slice(1), path], { stdio: 'ignore' })
          if (syntax && syntax.status !== 0 && !syntax.error) results.push({ ...row, outcome: 'invalid' })
          else {
            const run = await runTests(opt.test, worktree, Number(opt.timeout))
            results.push({ ...row, outcome: classify(run), syntax: syntax && !syntax.error ? 'checked' : 'unchecked', log: run.out.slice(-1500) })
          }
          writeFileSync(path, original)
        }
      }
    }
  } finally {
    cleanup()
  }

  const count = outcome => results.filter(r => r.outcome === outcome).length
  const summary = {
    killed: count('killed'), survived: count('survived'), invalid: count('invalid'), timeout: count('timeout'),
    infra: count('infra'), inconclusive: count('inconclusive'), total: results.length, skipped, unsupported, tree,
  }
  summary.valid = summary.killed + summary.survived
  const label = { killed: 'killed  ', survived: 'SURVIVED', invalid: 'invalid ', timeout: 'timeout ', infra: 'infra   ', inconclusive: 'unclear ' }
  for (const r of results) console.log(`${label[r.outcome]} ${r.file}:${r.line}  ${r.from}  ->  ${r.to}${r.syntax === 'unchecked' ? '  (syntax unchecked)' : ''}`)
  console.log(`\n${summary.killed} of ${summary.valid} valid mutants killed` +
    [summary.invalid && `${summary.invalid} did not parse (not counted)`, summary.timeout && `${summary.timeout} timed out`,
      (summary.infra + summary.inconclusive) && `${summary.infra + summary.inconclusive} inconclusive`,
      skipped && `${skipped} not run (over --max ${opt.max})`, unsupported.length && `${unsupported.length} file(s) not mutated`].filter(Boolean).map(s => `, ${s}`).join(''))
  if (summary.survived) console.log('Each SURVIVED line is behaviour no test checks: add a test, or say why the mutant changes nothing observable.')
  if (summary.timeout + summary.infra + summary.inconclusive) console.log('Timeouts and inconclusive runs say nothing about the tests; look at them before counting anything.')
  console.log(`RESULT ${JSON.stringify(summary)}`)

  // Inside a run the result is evidence for test review, with the per-mutant log next to it.
  const runRoot = findRoot(root)
  if (runRoot) {
    const run = load(runRoot)
    mkdirSync(runDir(runRoot, run), { recursive: true })
    const log = join(runDir(runRoot, run), `mutants-${Date.now()}.json`)
    writeFileSync(log, JSON.stringify({ base, ...summary, results }, null, 2) + '\n')
    update(runRoot, r => {
      const prev = r.evidence?.mutants
      // Several invocations on one tree (one per file group) add up.
      const merged = prev?.tree === tree
        ? Object.fromEntries(Object.entries(summary).map(([k, v]) => [k, typeof v === 'number' ? (prev[k] ?? 0) + v : k === 'unsupported' ? [...(prev[k] ?? []), ...v] : v]))
        : summary
      return { ...r, evidence: { ...r.evidence, mutants: { ...merged, logs: [...(prev?.tree === tree ? prev.logs ?? [] : []), log] } } }
    })
    emit(runRoot, { kind: 'note', text: `mutants: ${summary.killed} of ${summary.valid} valid killed` })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { cleanup(); console.error(`mutate: ${error.message}`); process.exit(1) })
}
