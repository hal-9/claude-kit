#!/usr/bin/env node
// Mutation testing on the lines a story changed, with nothing to install.
//   node mutate.mjs --test '<command that runs the covering tests>' [--base origin/main] [--max 25] [--timeout 300] [--link <path>]... <file>...
// Runs in a throwaway git worktree of HEAD, so the checkout is never touched,
// whatever happens to this process. For every changed line it applies one small
// break at a time (flip a comparison, move a boundary, swap and/or, ...), checks
// the mutant still parses, runs the test command and records the outcome.
// --link symlinks an untracked path the tests need (node_modules is linked by default).
// The scope is every changed source file of a mutable type; a file left out of the
// call, and every mutant that did not die, blocks test review until it has a
// recorded reason (loop.mjs mutant accept). Each mutant has a stable id, so a
// second run on the same code replaces its earlier outcome instead of adding to it.
// ponytail: mutants are textual, one operator per line, at most --max per call.
// A mutant counts as killed only when it was checked to still be valid code
// (node --check, ruby -c, the project's own typescript for ts/tsx/jsx); without
// a checker a failing mutant is "unverified". Some survivors are equivalent.
// Swap in Stryker/mutant if a budget appears.
import { readFileSync, writeFileSync, existsSync, mkdirSync, symlinkSync, rmSync, readdirSync, realpathSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, extname, join, resolve, sep } from 'node:path'
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
const TS_CHECKED = ['.ts', '.tsx', '.jsx']
const IS_TEST = /(^|\/)(spec|tests?|__tests__)\/|[._](spec|test)\.[a-z]+$/
export const mutable = file => Boolean(OPERATORS[extname(file)]) && !IS_TEST.test(file)
export const mutantId = (file, line, to) => `${file}:${line}:${createHash('sha1').update(to).digest('hex').slice(0, 6)}`

// Is the mutated file still valid code? true / false, or null when nothing here can tell.
let typescript // the project's own compiler, looked up once
function parses(root, file, path) {
  const ext = extname(file)
  if (SYNTAX[ext]) {
    const check = spawnSync(SYNTAX[ext][0], [...SYNTAX[ext].slice(1), path], { stdio: 'ignore' })
    return check.error ? null : check.status === 0
  }
  if (!TS_CHECKED.includes(ext)) return null
  if (typescript === undefined) try { typescript = createRequire(join(root, file))('typescript') } catch { typescript = null }
  if (!typescript) return null
  const out = typescript.transpileModule(readFileSync(path, 'utf8'), { fileName: file, reportDiagnostics: true, compilerOptions: { jsx: 'preserve', allowJs: true } })
  return !out.diagnostics.some(d => d.category === typescript.DiagnosticCategory.Error)
}
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
  // Killed by a signal we did not send. Through a shell that arrives as 128 + the signal number.
  if (code === null || code > 128) return 'inconclusive'
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

  // Scope: every changed file this runner can mutate. Changed files it cannot are named, not hidden.
  const changed = git('diff', '--name-only', '--diff-filter=AMR', '-z', base, 'HEAD').split('\0').filter(Boolean)
  const scope = changed.filter(mutable)
  const outside = changed.filter(f => !mutable(f) && !IS_TEST.test(f))
  const results = []
  const covered = []
  const unsupported = []
  const inside = realpathSync(worktree) + sep
  try {
    const baseline = await runTests(opt.test, worktree, Number(opt.timeout))
    if (baseline.code !== 0)
      throw new Error(`the test command fails on unmutated code in the disposable copy (${classify(baseline)}); fix that first, or --link the untracked files it needs.\n${baseline.out.slice(-1500)}`)
    for (const file of opt.files) {
      const ext = extname(file)
      if (!mutable(file)) { unsupported.push(file); console.log(`skip ${file} (test file or unsupported type)`); continue }
      const path = join(worktree, file)
      // A symlink (the file itself, a parent, or anything under --link) would write through into the real checkout.
      if (!realpathSync(path).startsWith(inside)) { unsupported.push(file); console.log(`skip ${file} (it resolves outside the disposable copy; mutating it would change the real file)`); continue }
      covered.push(file)
      const original = readFileSync(path, 'utf8')
      const lines = original.split('\n')
      for (const n of changedLines(git('diff', '-U0', base, 'HEAD', '--', file))) {
        for (const mutated of mutantsFor(lines[n - 1] ?? '', ext)) {
          const row = { id: mutantId(file, n, mutated.trim()), file, line: n, from: lines[n - 1].trim(), to: mutated.trim() }
          if (results.filter(r => r.outcome !== 'skipped').length >= Number(opt.max)) { results.push({ ...row, outcome: 'skipped' }); continue }
          writeFileSync(path, lines.with(n - 1, mutated).join('\n'))
          const valid = parses(root, file, path)
          if (valid === false) results.push({ ...row, outcome: 'invalid' })
          else {
            const run = await runTests(opt.test, worktree, Number(opt.timeout))
            const outcome = classify(run)
            // A failing run of code nobody could check may be a parse error, not a test catching the change.
            results.push({ ...row, outcome: outcome === 'killed' && valid === null ? 'unverified' : outcome, log: run.out.slice(-1500) })
          }
          writeFileSync(path, original)
        }
      }
    }
  } finally {
    cleanup()
  }

  const outcomes = Object.fromEntries(results.map(r => [r.id, r.outcome]))
  const summary = { ...tally(outcomes), unsupported, tree }
  const label = { killed: 'killed  ', survived: 'SURVIVED', invalid: 'invalid ', timeout: 'timeout ', infra: 'infra   ', inconclusive: 'unclear ', unverified: 'UNVERIFIED', skipped: 'not run ' }
  for (const r of results) console.log(`${label[r.outcome]} ${r.file}:${r.line}  ${r.from}  ->  ${r.to}${['survived', 'timeout', 'unverified', 'skipped'].includes(r.outcome) ? `  [${r.id}]` : ''}`)
  const notCovered = scope.filter(f => !covered.includes(f))
  console.log(`\n${summary.killed} of ${summary.valid} valid mutants killed` +
    [summary.invalid && `${summary.invalid} did not parse (not counted)`, summary.unverified && `${summary.unverified} failed but could not be checked for valid syntax (not counted)`,
      summary.timeout && `${summary.timeout} timed out`,
      (summary.infra + summary.inconclusive) && `${summary.infra + summary.inconclusive} inconclusive`,
      summary.skipped && `${summary.skipped} not run (over --max ${opt.max})`, unsupported.length && `${unsupported.length} file(s) not mutated`].filter(Boolean).map(s => `, ${s}`).join(''))
  if (summary.survived) console.log('Each SURVIVED line is behaviour no test checks: add a test, or say why the mutant changes nothing observable (loop.mjs mutant accept <id> "<why>").')
  if (summary.unverified) console.log('UNVERIFIED: the tests failed, but no syntax checker for this file type is installed (typescript in the project), so it may be a parse error.')
  if (summary.timeout + summary.infra + summary.inconclusive) console.log('Timeouts and inconclusive runs say nothing about the tests; look at them before counting anything.')
  if (notCovered.length) console.log(`Changed source files not mutated in this call: ${notCovered.join(', ')}`)
  if (outside.length) console.log(`Changed files of a type this runner cannot mutate (name them in the report): ${outside.join(', ')}`)
  console.log(`RESULT ${JSON.stringify(summary)}`)

  // Inside a run the result is evidence for test review, with the per-mutant log next to it.
  const runRoot = findRoot(root)
  if (runRoot) {
    const run = load(runRoot)
    mkdirSync(runDir(runRoot, run), { recursive: true })
    const log = join(runDir(runRoot, run), `mutants-${Date.now()}.json`)
    writeFileSync(log, JSON.stringify({ base, ...summary, results }, null, 2) + '\n')
    update(runRoot, r => {
      // Several calls on one tree (one per file group, or a retry) merge by mutant id:
      // a retry replaces the earlier outcome, the earlier log stays as history.
      const prev = r.evidence?.mutants?.tree === tree ? r.evidence.mutants : {}
      const merged = { ...prev.outcomes, ...outcomes }
      const mutants = {
        ...tally(merged), tree, base, scope, outside, outcomes: merged,
        covered: [...new Set([...(prev.covered ?? []), ...covered])],
        unsupported: [...new Set([...(prev.unsupported ?? []), ...unsupported])],
        dispositions: prev.dispositions ?? {}, logs: [...(prev.logs ?? []), log],
      }
      return { ...r, evidence: { ...r.evidence, mutants } }
    })
    emit(runRoot, { kind: 'note', text: `mutants: ${summary.killed} of ${summary.valid} valid killed` })
  }
}

// Counts per outcome; "valid" are the mutants that say something about the tests.
export function tally(outcomes) {
  const all = Object.values(outcomes)
  const count = outcome => all.filter(o => o === outcome).length
  const t = Object.fromEntries(['killed', 'survived', 'invalid', 'timeout', 'infra', 'inconclusive', 'unverified', 'skipped'].map(o => [o, count(o)]))
  return { ...t, valid: t.killed + t.survived, total: all.length - t.skipped }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { cleanup(); console.error(`mutate: ${error.message}`); process.exit(1) })
}
