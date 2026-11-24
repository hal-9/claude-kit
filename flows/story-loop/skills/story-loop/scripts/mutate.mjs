#!/usr/bin/env node
// Mutation testing on the lines a story changed, with nothing to install.
//   node mutate.mjs --test '<command that runs the covering tests>' [--base origin/main] [--max 25] [--timeout 300] [--jobs 1] [--link <path>]... <file>...
// --jobs runs that many mutants at once, each slot in its own worktree, every slot
// first proving the unmutated suite passes there. Slots share whatever the tests
// share outside the checkout (a test database, a port): only raise it where they
// share nothing, or where the test setup reads TEST_ENV_NUMBER (set per slot).
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
import { GRAPH, findRoot, load, emit, headTree, opStart, opUpdate, opEnd } from './loop.mjs'
import { record } from './diag.mjs'

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
// ponytail: a fixed ceiling; each slot is a worktree and a full test process.
const MAX_JOBS = 8
// A lane's mutation budget: { max, exts } where max is per call (Infinity: no cap) and
// exts the file types it mutates (null: every type). No run or no lane: the standard budget.
export function laneBudget(name) {
  const m = GRAPH.lanes[name]?.mutants ?? GRAPH.lanes.standard.mutants
  return { name: GRAPH.lanes[name] ? name : 'standard', max: m.max ?? Infinity, exts: m.exts ?? null }
}
const laneAllows = (lane, file) => !lane.exts || lane.exts.includes(extname(file))
// The kills an earlier attempt established that still hold for this code: same base,
// the mutated file unchanged since, and no test file edited or deleted (tests that were
// only added can catch more, never less). Survivors, timeouts and anything unclear run
// again. changedSince(tree) lists [{ status, file }] between that tree and this code.
const fileOfId = id => id.split(':').slice(0, -2).join(':')
export function carriedKills(run, { tree, base, changedSince }) {
  const none = why => ({ from: null, ids: new Set(), why })
  const earlier = [run?.evidence?.mutants, ...[...(run?.history ?? [])].reverse().map(h => h.evidence?.mutants)]
    .find(m => m?.tree && m.tree !== tree && m.outcomes)
  if (!earlier) return none(null)
  if (earlier.base !== base) return none('the base moved since the earlier results')
  let changed
  try { changed = changedSince(earlier.tree) } catch { return none('the earlier code is not in this repository') }
  const touched = changed.filter(c => IS_TEST.test(c.file) && c.status !== 'A').map(c => c.file)
  if (touched.length) return none(`tests were changed or removed since (${touched.join(', ')}); every mutant runs again`)
  const files = new Set(changed.map(c => c.file))
  const ids = new Set(Object.entries(earlier.outcomes).filter(([id, o]) => o === 'killed' && !files.has(fileOfId(id))).map(([id]) => id))
  return { from: earlier.tree, ids, why: null }
}
// What a mutant is in the results: where, what was changed, and nothing of the work copy.
const row = ({ id, file, line, from, to }) => ({ id, file, line, from, to })

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

// The slots of this call, each a disposable worktree with at most one test run: { worktree, child }.
let active = null // { root, slots } for the signal handlers
function cleanup() {
  if (!active) return
  for (const slot of active.slots) {
    try { if (slot.child?.pid) process.kill(-slot.child.pid, 'SIGKILL') } catch {}
    try { execFileSync('git', ['worktree', 'remove', '--force', slot.worktree], { cwd: active.root, stdio: 'ignore' }) } catch {}
    rmSync(slot.worktree, { recursive: true, force: true })
  }
  active = null
}
// What a slot's test command sees: its number, and TEST_ENV_NUMBER in the parallel_tests
// convention ("" for the first, "2", "3", … after it), so a repo whose test database is
// named after it gives every slot its own database.
export const slotEnv = n => ({ STORY_LOOP_SLOT: String(n), TEST_ENV_NUMBER: n === 1 ? '' : String(n) })
// The run this call works for, fixed before the first test runs: { runRoot, ctx, base, tree, results }.
// null when no run was active at the start; such a call never attaches itself to a run that appears later.
let live = null
// What this call found, kept next to the run it was started for, also when it ends early
// (a failing baseline, a signal): an interrupted call is a fact about the run, not nothing.
function keepLog(status, extra = {}) {
  if (!live) return null
  const dir = join(live.runRoot, '.start-story', live.ctx.story)
  const file = join(dir, `mutants-${Date.now()}-${live.ctx.op}.json`)
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(file, JSON.stringify({ status, op: live.ctx.op, run: live.ctx.run, attempt: live.ctx.attempt, base: live.base, tree: live.tree, ...extra }, null, 2) + '\n')
  } catch { return null }
  return file
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => {
  if (live) {
    const log = keepLog('interrupted', { signal: sig, results: live.results })
    opEnd(live.runRoot, live.ctx, 'interrupted', `${sig} after ${live.results.length} mutants; partial outcomes are in ${log ?? 'no file (it could not be written)'} and are not evidence`)
  }
  cleanup()
  process.exit(128 + ({ SIGINT: 2, SIGTERM: 15, SIGHUP: 1 })[sig])
})

// Worktrees left by a run that was killed hard (SIGKILL) are removed on the next run.
function pruneAbandoned(root) {
  const removed = []
  for (const name of readdirSync(tmpdir()).filter(n => n.startsWith(WORKTREE_PREFIX))) {
    const pid = Number(name.slice(WORKTREE_PREFIX.length).split('-')[0])
    let alive = true
    try { process.kill(pid, 0) } catch (error) { alive = error.code !== 'ESRCH' }
    if (!alive) { rmSync(join(tmpdir(), name), { recursive: true, force: true }); removed.push(name) }
  }
  try { execFileSync('git', ['worktree', 'prune'], { cwd: root, stdio: 'ignore' }) } catch {}
  return removed
}

function runTests(command, slot, seconds) {
  return new Promise(done => {
    let out = '', timedOut = false
    const child = spawn(command, { shell: true, cwd: slot.worktree, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...slotEnv(slot.n) } })
    slot.child = child
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
  const opt = { base: 'origin/main', timeout: 300, jobs: 1, files: [], link: ['node_modules'] }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--link') opt.link.push(argv[++i])
    else if (argv[i].startsWith('--')) opt[argv[i].slice(2)] = argv[++i]
    else opt.files.push(argv[i])
  }
  if (!opt.test || !opt.files.length) throw new Error("usage: mutate.mjs --test '<command>' [--base ref] [--max n] [--timeout s] [--jobs n] [--link path] <file>...")
  for (const name of ['max', 'timeout', 'jobs'])
    if (opt[name] !== undefined && !(Number.isFinite(Number(opt[name])) && Number(opt[name]) > 0)) throw new Error(`--${name} needs a positive number, got "${opt[name]}"`)
  if (!Number.isInteger(Number(opt.jobs)) || Number(opt.jobs) > MAX_JOBS) throw new Error(`--jobs takes a whole number from 1 to ${MAX_JOBS}, got "${opt.jobs}"`)
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' })
  for (const file of opt.files)
    if (git('status', '--porcelain', '--', file).trim()) throw new Error(`${file} has uncommitted changes; commit first, mutants are judged on committed code`)
  const base = git('merge-base', opt.base, 'HEAD').trim()
  const tree = headTree(root)
  // Whose evidence this will be is settled now, before any test runs, and never again.
  const runRoot = findRoot(root)
  // The lane the human signed off sets how much mutation the story gets: how many
  // mutants per call (no cap on heavy) and which kinds of files. --max overrides the
  // count; every mutant it leaves out still needs a recorded reason before the gate passes.
  const runNow = runRoot ? load(runRoot) : null
  const laneName = runNow?.lane?.lane ?? null
  const lane = laneBudget(laneName)
  // A second attempt re-runs only what can have changed; earlier kills that still hold carry over.
  const carry = carriedKills(runNow, { tree, base, changedSince: from =>
    git('diff', '--name-status', '-z', '--no-renames', from, tree).split('\0').filter(Boolean)
      .reduce((out, part, i, all) => i % 2 ? out : [...out, { status: part, file: all[i + 1] }], []) })
  opt.max = opt.max !== undefined ? Number(opt.max) : lane.max
  const results = []
  if (runRoot) {
    const ctx = opStart(runRoot, 'mutate', 'test_review', { files: opt.files, test: opt.test, requested_base: opt.base, merge_base: base, max: Number(opt.max), timeout_s: Number(opt.timeout) })
    live = { runRoot, ctx, base, tree, results }
  }
  const note = (kind, fields) => { if (live) record(live.runRoot, kind, fields) }

  const abandoned = pruneAbandoned(root)
  if (abandoned.length) note('mutate.abandoned', { removed: abandoned })
  // One disposable worktree per slot. Slots share nothing but the queue of mutants;
  // anything else they share (a test database) is the caller's to separate, by --jobs 1
  // or by a test setup that reads TEST_ENV_NUMBER.
  const jobs = Number(opt.jobs)
  const stamp = `${process.pid}-${Date.now()}`
  active = { root, slots: [] }
  for (let n = 1; n <= jobs; n++) {
    const worktree = join(tmpdir(), `${WORKTREE_PREFIX}${stamp}-${n}`)
    git('worktree', 'add', '--detach', '--quiet', worktree, 'HEAD')
    active.slots.push({ n, worktree, inside: realpathSync(worktree) + sep, child: null })
    for (const path of opt.link) {
      const from = resolve(root, path)
      if (!existsSync(from) || existsSync(join(worktree, path))) continue
      mkdirSync(dirname(join(worktree, path)), { recursive: true })
      symlinkSync(from, join(worktree, path))
    }
  }
  const slots = active.slots
  const [first] = slots

  // Scope: every changed file this runner can mutate. Changed files it cannot are named, not hidden.
  const changed = git('diff', '--name-only', '--diff-filter=AMR', '-z', base, 'HEAD').split('\0').filter(Boolean)
  const scope = changed.filter(f => mutable(f) && laneAllows(lane, f))
  // Mutable, but not in this lane's share: recorded as such, never silently missing.
  const laneSkipped = changed.filter(f => mutable(f) && !laneAllows(lane, f))
  const outside = changed.filter(f => !mutable(f) && !IS_TEST.test(f))
  const covered = []
  const unsupported = []
  try {
    // Every slot proves on unmutated code that it runs green on its own and next to the others:
    // a slot that fails here would turn its failures into fake kills.
    note('mutate.baseline', { outcome: 'started', jobs })
    const began = Date.now()
    const baselines = await Promise.all(slots.map(slot => runTests(opt.test, slot, Number(opt.timeout))))
    const bad = baselines.findIndex(b => b.code !== 0)
    const baseline = baselines[bad] ?? baselines[0]
    // On unmutated code a failing run is a failure of the suite, not a "kill".
    const how = bad < 0 ? 'ok' : classify(baseline) === 'killed' ? 'failed' : classify(baseline)
    note('mutate.baseline', { outcome: how, jobs, slot: bad < 0 ? null : bad + 1, code: baseline.code ?? null, signal: baseline.signal ?? null, timed_out: Boolean(baseline.timedOut), elapsed_ms: Date.now() - began })
    if (bad >= 0) {
      const log = keepLog('baseline_failed', { outcome: how, jobs, slot: bad + 1, code: baseline.code ?? null, signal: baseline.signal ?? null, output: baseline.out.slice(-4000) })
      if (live) opEnd(live.runRoot, live.ctx, 'baseline_failed', `the unmutated baseline did not pass (${how}${jobs > 1 ? ` in slot ${bad + 1} of ${jobs}` : ''}); see ${log}`)
      live = null
      const parallel = jobs > 1 ? ` With --jobs ${jobs} the slots run at the same time: if they share a test database or a port, run again with --jobs 1.` : ''
      throw new Error(`the test command fails on unmutated code in the disposable copy (${how}); fix that first, or --link the untracked files it needs.${parallel}\n${baseline.out.slice(-1500)}`)
    }

    // The queue, in a stable order, with --max decided before anything runs.
    const queue = []
    for (const file of opt.files) {
      const ext = extname(file)
      if (!mutable(file)) { unsupported.push(file); console.log(`skip ${file} (test file or unsupported type)`); continue }
      if (!laneAllows(lane, file)) { console.log(`skip ${file} (the ${lane.name} lane mutates ${lane.exts.join(' ')} only)`); continue }
      // A symlink (the file itself, a parent, or anything under --link) would write through into the real checkout.
      if (slots.some(slot => !realpathSync(join(slot.worktree, file)).startsWith(slot.inside))) { unsupported.push(file); console.log(`skip ${file} (it resolves outside the disposable copy; mutating it would change the real file)`); continue }
      covered.push(file)
      const lines = readFileSync(join(first.worktree, file), 'utf8').split('\n')
      for (const n of changedLines(git('diff', '-U0', base, 'HEAD', '--', file)))
        for (const mutated of mutantsFor(lines[n - 1] ?? '', ext))
          queue.push({ id: mutantId(file, n, mutated.trim()), file, line: n, from: lines[n - 1].trim(), to: mutated.trim(), ext, lines, mutated })
    }
    const outcomes = new Array(queue.length)
    // Kills that still hold are taken over and cost no run, and no share of --max.
    const fresh = []
    queue.forEach((m, i) => { if (carry.ids.has(m.id)) outcomes[i] = { ...row(m), outcome: 'killed', carried: true }; else fresh.push(i) })
    const runnable = fresh.slice(0, Number(opt.max))
    for (const i of fresh.slice(runnable.length)) outcomes[i] = { ...row(queue[i]), outcome: 'skipped' }
    const carried = queue.length - fresh.length
    if (carried) console.log(`${carried} mutant${carried === 1 ? '' : 's'} killed on ${carry.from.slice(0, 7)} and unchanged since: taken over, not run again`)
    else if (carry.why) console.log(`nothing taken over from the earlier results: ${carry.why}`)
    note('mutate.carry', { carried, from: carry.from, why: carry.why, to_run: runnable.length })

    // Each slot takes the next mutant, breaks its own copy of the file, runs, and puts it back.
    let next = 0
    await Promise.all(slots.map(async slot => {
      while (next < runnable.length) {
        const i = runnable[next++]
        const m = queue[i]
        const path = join(slot.worktree, m.file)
        const original = m.lines.join('\n')
        writeFileSync(path, m.lines.with(m.line - 1, m.mutated).join('\n'))
        try {
          const valid = parses(root, m.file, path)
          const began = Date.now()
          if (valid === false) outcomes[i] = { ...row(m), outcome: 'invalid' }
          else {
            const run = await runTests(opt.test, slot, Number(opt.timeout))
            const outcome = classify(run)
            // A failing run of code nobody could check may be a parse error, not a test catching the change.
            outcomes[i] = { ...row(m), outcome: outcome === 'killed' && valid === null ? 'unverified' : outcome, log: run.out.slice(-1500) }
          }
          results.push(outcomes[i])
          // syntax_checked: true/false is the checker's answer; null means nothing here can check this file type.
          note('mutate.mutant', { mutant: m.id, outcome: outcomes[i].outcome, slot: slot.n, syntax_checked: valid, elapsed_ms: Date.now() - began })
        } finally { writeFileSync(path, original) }
      }
    }))
    // In queue order, whatever order the slots finished in.
    results.splice(0, results.length, ...outcomes)
  } finally {
    const left = slots.filter(slot => existsSync(slot.worktree)).length
    cleanup()
    note('mutate.cleanup', { outcome: slots.some(slot => existsSync(slot.worktree)) ? 'worktree left behind' : 'ok', slots: left })
  }

  const outcomes = Object.fromEntries(results.map(r => [r.id, r.outcome]))
  const carriedIds = results.filter(r => r.carried).map(r => r.id)
  const summary = { ...tally(outcomes), carried: carriedIds.length, unsupported, tree }
  const label = { killed: 'killed  ', survived: 'SURVIVED', invalid: 'invalid ', timeout: 'timeout ', infra: 'infra   ', inconclusive: 'unclear ', unverified: 'UNVERIFIED', skipped: 'not run ' }
  for (const r of results) console.log(`${r.carried ? 'carried ' : label[r.outcome]} ${r.file}:${r.line}  ${r.from}  ->  ${r.to}${['survived', 'timeout', 'unverified', 'skipped'].includes(r.outcome) ? `  [${r.id}]` : ''}`)
  const notCovered = scope.filter(f => !covered.includes(f))
  console.log(`\n${summary.killed} of ${summary.valid} valid mutants killed${summary.carried ? ` (${summary.carried} carried over from ${carry.from.slice(0, 7)})` : ''}` +
    [summary.invalid && `${summary.invalid} did not parse (not counted)`, summary.unverified && `${summary.unverified} failed but could not be checked for valid syntax (not counted)`,
      summary.timeout && `${summary.timeout} timed out`,
      (summary.infra + summary.inconclusive) && `${summary.infra + summary.inconclusive} inconclusive`,
      summary.skipped && `${summary.skipped} not run (over --max ${opt.max})`, unsupported.length && `${unsupported.length} file(s) not mutated`].filter(Boolean).map(s => `, ${s}`).join(''))
  if (summary.survived) console.log('Each SURVIVED line is behaviour no test checks: add a test, or say why the mutant changes nothing observable (loop.mjs mutant accept <id> "<why>").')
  if (summary.unverified) console.log('UNVERIFIED: the tests failed, but no syntax checker for this file type is installed (typescript in the project), so it may be a parse error.')
  if (summary.timeout + summary.infra + summary.inconclusive) console.log('Timeouts and inconclusive runs say nothing about the tests; look at them before counting anything.')
  if (notCovered.length) console.log(`Changed source files not mutated in this call: ${notCovered.join(', ')}`)
  if (outside.length) console.log(`Changed files of a type this runner cannot mutate (name them in the report): ${outside.join(', ')}`)
  if (laneSkipped.length) console.log(`Not mutated in the ${lane.name} lane (name them in the report): ${laneSkipped.join(', ')}`)
  console.log(`RESULT ${JSON.stringify(summary)}`)

  // Inside a run the result is evidence for test review, with the per-mutant log next to it:
  // for the run and attempt this call started in, and for no other.
  if (!live) return
  const { ctx } = live
  const log = keepLog('finished', { ...summary, results }) ?? fail(`the mutant log could not be written under ${runRoot}`)
  try {
    opUpdate(runRoot, ctx, r => {
      // Several calls on one tree (one per file group, or a retry) merge by mutant id:
      // a retry replaces the earlier outcome, the earlier log stays as history. Results
      // of another run, attempt, tree or base are never merged with: they are other evidence.
      const had = r.evidence?.mutants
      const prev = had && had.tree === tree && had.base === base && (had.run ?? ctx.run) === ctx.run && (had.attempt ?? ctx.attempt) === ctx.attempt ? had : {}
      const merged = { ...prev.outcomes, ...outcomes }
      const mutants = {
        ...tally(merged), tree, base, run: ctx.run, attempt: ctx.attempt, scope, outside, outcomes: merged,
        lane: lane.name, lane_skipped: laneSkipped,
        // A mutant this call ran fresh is no longer carried, whatever an earlier call said.
        carried: [...new Set([...(prev.carried ?? []).filter(id => !(id in outcomes)), ...carriedIds])], carried_from: carry.from ?? prev.carried_from ?? null,
        covered: [...new Set([...(prev.covered ?? []), ...covered])],
        unsupported: [...new Set([...(prev.unsupported ?? []), ...unsupported])],
        dispositions: prev.dispositions ?? {}, logs: [...(prev.logs ?? []), log],
      }
      return { ...r, evidence: { ...r.evidence, mutants } }
    }, { log, summary })
  } catch (error) {
    opEnd(runRoot, ctx, error.kind === 'stale' ? 'stale' : 'failed', error.message)
    live = null
    throw error
  }
  opEnd(runRoot, ctx, 'ok', `${summary.killed} of ${summary.valid} valid killed`)
  live = null
  emit(runRoot, { kind: 'note', text: `mutants: ${summary.killed} of ${summary.valid} valid killed` })
}
const fail = message => { throw new Error(message) }

// Counts per outcome; "valid" are the mutants that say something about the tests.
export function tally(outcomes) {
  const all = Object.values(outcomes)
  const count = outcome => all.filter(o => o === outcome).length
  const t = Object.fromEntries(['killed', 'survived', 'invalid', 'timeout', 'infra', 'inconclusive', 'unverified', 'skipped'].map(o => [o, count(o)]))
  return { ...t, valid: t.killed + t.survived, total: all.length - t.skipped }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    cleanup()
    if (live) opEnd(live.runRoot, live.ctx, 'failed', error.message)
    console.error(`mutate: ${error.message}`)
    process.exit(error.kind === 'stale' ? 4 : 1)
  })
}
