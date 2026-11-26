#!/usr/bin/env node
// Mutation testing on the lines a story changed, with nothing to install.
//   node mutate.mjs --test '<command>' [--adapter node|jest|vitest|rspec|exit] [--base <the run's base>]
//                   [--max 25] [--timeout 300] [--jobs 1] [--weight 1] [--budget <seconds>] [--link <path>]... [--explore] <file>...
// Runs in throwaway git worktrees of HEAD, so the checkout is never touched. For every
// changed line it applies one small break at a time (flip a comparison, move a boundary,
// swap and/or, ...), checks the mutant still parses, runs the test command and reads what
// the runner reported (adapters.mjs).
//
// What counts as a kill. A failing run is a behavioural kill only when the runner's report
// attributes it to the code under test: an assertion failed, or a test body threw and the
// unmutated code, run again in the same slot right after, passes. A failed hook, a file that
// could not be loaded, no tests selected, a compile error, a timeout or a signal is never a
// kill on its own: setup and runtime failures count once a clean recheck passes (otherwise
// they are infra), collection and build failures are kept apart and never enter the score,
// and anything the report does not explain is inconclusive and blocks test review. The
// exit-code-only adapter (--adapter exit) has to be asked for; each of its failures is
// rechecked against clean code before it counts. A recheck narrows the doubt; it does not
// prove the absence of every flake.
//
// Identity and replacement. Each call claims its files as the test review's units: a newer
// call for a file replaces the earlier result for that file only, and while it runs (or if
// it fails) the gate is not satisfied. Calls on different files merge into one aggregate,
// in any completion order. --base must give the run's merge base (loop.mjs put base changes
// it); results name the command, adapter, tree, merge base and runtime they ran under.
//
// Capacity. The runnable mutants are known before any worktree is made: a call opens at most
// min(--jobs, runnable mutants) slots, and every call in every checkout of the repository
// draws its slots from one shared budget (STORY_LOOP_MUTATION_CAPACITY, default 4 units; a
// slot whose test runner starts its own workers takes --weight units). A call waits for its
// first slot (never holding part of one while it waits) and takes more only when free.
// Each slot proves the unmutated suite green in its own copy first, with TEST_ENV_NUMBER set
// per slot, so a test database named after it is never shared. --budget stops starting new
// mutants after that many seconds; what did not run is recorded as not run, and needs a
// decision before test review passes. --explore runs and prints but records nothing.
// --link symlinks an untracked path the tests need (node_modules is linked by default).
// ponytail: mutants are textual, one operator per line, at most --max per call. Swap in
// Stryker/mutant if a budget appears.
import { readFileSync, writeFileSync, existsSync, mkdirSync, symlinkSync, rmSync, readdirSync, realpathSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { GRAPH, findRoot, load, emit, update, headTree, opStart, opUpdate, opEnd, diffBase, baseName } from './loop.mjs'
import { record, sanitizeOutput } from './diag.mjs'
import { acquire, tryAcquire, release } from './lease.mjs'
import { ADAPTERS, NODE_REPORTER, detectAdapter, parseReport, judge, settle } from './adapters.mjs'

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
// Kills from earlier code are history, never evidence for this tree. Whether a test still
// kills a mutant depends on more than the mutated line and the test file: a caller that no
// longer reaches the function, a fixture, a dependency or the test command can turn a kill
// into a survivor (seen: unchanged function and test, changed caller, two kills became two
// survivors). Results of the same tree, base, run and attempt still merge (see the end of main).
// ponytail: no cross-tree reuse at all; add it back only keyed on a full execution identity
// (sources and their dependencies, tests and support files, command, config, lockfile, runtime, operator version).
export function carriedKills(run, { tree } = {}) {
  const earlier = [run?.evidence?.mutants, ...(run?.history ?? []).map(h => h.evidence?.mutants)].some(m => m?.tree && m.tree !== tree && m.outcomes)
  return { from: null, ids: new Set(), holds: () => false, why: earlier ? 'kills on earlier code are history, not evidence for this code; every mutant runs' : null }
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


// The shared mutation budget, in units, across every mutate call in every checkout of the repository.
export const capacity = () => {
  const n = Number(process.env.STORY_LOOP_MUTATION_CAPACITY ?? GRAPH.mutation?.capacity ?? 4)
  return Number.isInteger(n) && n > 0 ? n : 4
}

// The slots of this call, each a disposable worktree with at most one test run: { worktree, child }.
let active = null // { root, slots } for the signal handlers
function releaseSlot(root, slot) {
  if (slot.n !== undefined) release(root, 'test-env', slot.n)
  for (const u of slot.units ?? []) release(root, 'mutation-capacity', u)
}
function cleanup() {
  if (!active) return
  for (const slot of active.slots) {
    try { if (slot.child?.pid) process.kill(-slot.child.pid, 'SIGKILL') } catch {}
    if (slot.worktree) {
      try { execFileSync('git', ['worktree', 'remove', '--force', slot.worktree], { cwd: active.root, stdio: 'ignore' }) } catch {}
      rmSync(slot.worktree, { recursive: true, force: true })
    }
    if (slot.reports) rmSync(slot.reports, { recursive: true, force: true })
    releaseSlot(active.root, slot)
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
    writeFileSync(file, JSON.stringify({ status, op: live.ctx.op, run: live.ctx.run, attempt: live.ctx.attempt, base: live.base, tree: live.tree, identity: live.identity, ...extra }, null, 2) + '\n')
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

// Output is kept whole while it runs (bounded), and sanitized before it is cut or stored.
const RAW_LIMIT = 1 << 20
function runTests(command, slot, seconds, stats) {
  const report = join(slot.reports, `report-${++slot.runs}.json`)
  rmSync(report, { force: true })
  stats.running++; stats.peak = Math.max(stats.peak, stats.running)
  return new Promise(done => {
    let out = '', timedOut = false
    const child = spawn(command, { shell: true, cwd: slot.worktree, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...slotEnv(slot.n), STORY_LOOP_REPORT: report, STORY_LOOP_NODE_REPORTER: NODE_REPORTER } })
    slot.child = child
    const keep = chunk => { out = (out + chunk).slice(-RAW_LIMIT) }
    child.stdout.on('data', keep); child.stderr.on('data', keep)
    const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, 'SIGKILL') } catch {} }, seconds * 1000)
    const finish = result => { stats.running--; slot.child = null; done({ ...result, out: sanitizeOutput(out, 4000), report }) }
    child.on('error', error => { clearTimeout(timer); finish({ error }) })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      try { process.kill(-child.pid, 'SIGKILL') } catch {} // stragglers of the group
      finish({ code, signal, timedOut })
    })
  })
}
// The structured report a run wrote, or null when it is missing or unreadable.
function readReport(adapter, file) {
  if (adapter === 'exit') return null
  try { return parseReport(adapter, readFileSync(file, 'utf8')) } catch { return null }
}
// Unmutated code is healthy in a slot when it exits 0 and, with a report, ran tests and failed none.
function healthy(adapter, exec) {
  if (exec.error || exec.timedOut || exec.code !== 0) return false
  if (adapter === 'exit') return true
  const r = readReport(adapter, exec.report)
  return Boolean(r && r.tests > 0 && !r.failures.length)
}

// Leases a slot's share of the budget: `weight` capacity units and one test-env number, all or nothing.
function leaseSlot(root, weight) {
  const units = []
  for (let i = 0; i < weight; i++) {
    const u = tryAcquire(root, 'mutation-capacity', { pid: process.pid }, { max: capacity() })
    if (u === null) { units.forEach(n => release(root, 'mutation-capacity', n)); return null }
    units.push(u)
  }
  return { units, n: acquire(root, 'test-env', { pid: process.pid }) }
}
const pause = ms => new Promise(r => setTimeout(r, ms))

async function main(argv) {
  const opt = { timeout: 300, jobs: 1, weight: 1, files: [], link: ['node_modules'] }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--link') opt.link.push(argv[++i])
    else if (argv[i] === '--explore') opt.explore = true
    else if (argv[i].startsWith('--')) opt[argv[i].slice(2)] = argv[++i]
    else opt.files.push(argv[i])
  }
  if (!opt.test || !opt.files.length) throw new Error("usage: mutate.mjs --test '<command>' [--adapter node|jest|vitest|rspec|exit] [--base ref] [--max n] [--timeout s] [--jobs n] [--weight n] [--budget s] [--link path] [--explore] <file>...")
  for (const name of ['max', 'timeout', 'jobs', 'weight', 'budget'])
    if (opt[name] !== undefined && !(Number.isFinite(Number(opt[name])) && Number(opt[name]) > 0)) throw new Error(`--${name} needs a positive number, got "${opt[name]}"`)
  if (!Number.isInteger(Number(opt.jobs)) || Number(opt.jobs) > MAX_JOBS) throw new Error(`--jobs takes a whole number from 1 to ${MAX_JOBS}, got "${opt.jobs}"`)
  const weight = Number(opt.weight)
  if (!Number.isInteger(weight) || weight > capacity()) throw new Error(`--weight takes a whole number from 1 to the shared capacity ${capacity()}, got "${opt.weight}"`)
  // What reads the runner's verdict: named, or recognised from the command; never assumed.
  const adapter = opt.adapter ?? detectAdapter(opt.test) ??
    fail(`say how to read this test command's results: --adapter ${ADAPTERS.join('|')}. A structured adapter needs the command to write its report to $STORY_LOOP_REPORT (see adapters.mjs); --adapter exit uses the exit code alone and rechecks every failure against clean code`)
  ADAPTERS.includes(adapter) || fail(`--adapter is one of ${ADAPTERS.join(', ')}`)
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' })
  for (const file of opt.files)
    if (git('status', '--porcelain', '--', file).trim()) throw new Error(`${file} has uncommitted changes; commit first, mutants are judged on committed code`)
  const tree = headTree(root)
  // Whose evidence this will be is settled now, before any test runs, and never again.
  const runRoot = opt.explore ? null : findRoot(root)
  const runNow = runRoot ? load(runRoot) : null
  // Inside a run the diff is taken against the run's base; a --base that gives another merge base is other evidence.
  const gitq = (...args) => git(...args).trim()
  const runBase = runNow?.base ? diffBase(gitq, runNow.base) : null
  const base = gitq('merge-base', opt.base ?? runBase ?? 'origin/main', 'HEAD')
  if (runBase && opt.base && base !== gitq('merge-base', runBase, 'HEAD'))
    fail(`--base ${opt.base} gives another diff than the run's base ${runNow.base}; test review decides against the run's base. Change it with loop.mjs put base <branch>, or look without recording: --explore`)
  // The lane the human signed off sets how much mutation the story gets: how many
  // mutants per call and which kinds of files. --max overrides the
  // count; every mutant it leaves out still needs a recorded reason before the gate passes.
  const laneName = runNow?.lane?.lane ?? null
  const lane = laneBudget(laneName)
  // Earlier attempts' kills are history: every mutant of this tree runs (carriedKills says why).
  const carry = carriedKills(runNow, { tree })
  opt.max = opt.max !== undefined ? Number(opt.max) : lane.max
  const identity = { command: opt.test, adapter, tree, merge_base: base, base_name: runNow?.base ? baseName(runNow.base) : opt.base ?? 'origin/main',
    runtime: { node: process.version, platform: `${process.platform}-${process.arch}` }, links: opt.link, timeout_s: Number(opt.timeout) }

  // Scope: every changed file this runner can mutate. Changed files it cannot are named, not hidden.
  const changed = git('diff', '--name-only', '--diff-filter=AMR', '-z', base, 'HEAD').split('\0').filter(Boolean)
  const scope = changed.filter(f => mutable(f) && laneAllows(lane, f))
  // Mutable, but not in this lane's share: recorded as such, never silently missing.
  const laneSkipped = changed.filter(f => mutable(f) && !laneAllows(lane, f))
  const outside = changed.filter(f => !mutable(f) && !IS_TEST.test(f))
  const covered = []
  const unsupported = []
  // The queue, in a stable order, with --max decided before any worktree or test exists.
  const queue = []
  for (const file of opt.files) {
    const ext = extname(file)
    if (!mutable(file)) { unsupported.push(file); console.log(`skip ${file} (test file or unsupported type)`); continue }
    if (!laneAllows(lane, file)) { console.log(`skip ${file} (the ${lane.name} lane mutates ${lane.exts.join(' ')} only)`); continue }
    // A symlink in the tree would write through into the real checkout (checked again in each copy).
    if (git('ls-files', '-s', '--', file).startsWith('120000')) { unsupported.push(file); console.log(`skip ${file} (it resolves outside the disposable copy; mutating it would change the real file)`); continue }
    let text
    try { text = git('show', `HEAD:${file}`) } catch { unsupported.push(file); console.log(`skip ${file} (not in HEAD)`); continue }
    covered.push(file)
    const lines = text.split('\n')
    for (const n of changedLines(git('diff', '-U0', base, 'HEAD', '--', file)))
      for (const mutated of mutantsFor(lines[n - 1] ?? '', ext))
        queue.push({ id: mutantId(file, n, mutated.trim()), file, line: n, from: lines[n - 1].trim(), to: mutated.trim(), ext, lines, mutated })
  }
  const outcomes = new Array(queue.length)
  const runnable = queue.map((_, i) => i).slice(0, Number(opt.max))
  for (const i of queue.map((_, i) => i).slice(runnable.length)) outcomes[i] = { ...row(queue[i]), outcome: 'skipped', why: `over --max ${opt.max}` }
  if (carry.why) console.log(`nothing taken over from the earlier results: ${carry.why}`)

  const results = []
  if (runRoot) {
    // The files this call answers for are its units: a newer call for one of them replaces it.
    const ctx = opStart(runRoot, 'mutate', 'test_review', { files: opt.files, test: opt.test, adapter, requested_base: opt.base ?? null, merge_base: base, max: Number(opt.max), timeout_s: Number(opt.timeout) }, covered)
    live = { runRoot, ctx, base, tree, results, identity }
  }
  const note = (kind, fields) => { if (live) record(live.runRoot, kind, fields) }
  const stats = { baselines: 0, rechecks: 0, mutants: 0, running: 0, peak: 0, slots: 0, waited_ms: 0, began: Date.now() }

  const abandoned = pruneAbandoned(root)
  if (abandoned.length) note('mutate.abandoned', { removed: abandoned })
  // Slots: no more than there are mutants to run, drawn from the shared budget.
  const want = Math.min(Number(opt.jobs), runnable.length)
  const stamp = `${process.pid}-${Date.now()}`
  active = { root, slots: [] }
  const budgetEnds = opt.budget ? Date.now() + Number(opt.budget) * 1000 : Infinity
  try {
    while (want && !active.slots.length) {
      const got = leaseSlot(root, weight)
      if (got) { active.slots.push(got); break }
      if (Date.now() > budgetEnds) break
      if (!stats.waited_ms) console.log(`waiting for mutation capacity (${capacity()} units shared by every mutate call in this repository)`)
      await pause(200); stats.waited_ms += 200
    }
    while (active.slots.length && active.slots.length < want) { const got = leaseSlot(root, weight); if (!got) break; active.slots.push(got) }
    for (const slot of active.slots) {
      slot.worktree = join(tmpdir(), `${WORKTREE_PREFIX}${stamp}-${slot.n}`)
      git('worktree', 'add', '--detach', '--quiet', slot.worktree, 'HEAD')
      Object.assign(slot, { inside: realpathSync(slot.worktree) + sep, child: null, runs: 0, reports: join(tmpdir(), `${WORKTREE_PREFIX}${stamp}-${slot.n}-reports`) })
      mkdirSync(slot.reports, { recursive: true })
      for (const path of opt.link) {
        const from = resolve(root, path)
        if (!existsSync(from) || existsSync(join(slot.worktree, path))) continue
        mkdirSync(dirname(join(slot.worktree, path)), { recursive: true })
        symlinkSync(from, join(slot.worktree, path))
      }
    }
    const slots = active.slots
    stats.slots = slots.length
    note('mutate.capacity', { capacity: capacity(), weight, wanted: want, slots: slots.length, waited_ms: stats.waited_ms })

    // A copy whose path resolves outside itself would write through into the real checkout.
    for (const file of [...covered]) if (slots.some(slot => !realpathSync(join(slot.worktree, file)).startsWith(slot.inside))) {
      covered.splice(covered.indexOf(file), 1); unsupported.push(file)
      console.log(`skip ${file} (it resolves outside the disposable copy; mutating it would change the real file)`)
      queue.forEach((m, i) => { if (m.file === file) outcomes[i] = { ...row(m), outcome: 'skipped', why: 'resolves outside the disposable copy' } })
    }
    const todo = runnable.filter(i => !outcomes[i])

    if (slots.length) {
      // Every slot proves on unmutated code that it runs green on its own and next to the others:
      // a slot that fails here would turn its failures into fake kills.
      note('mutate.baseline', { outcome: 'started', jobs: slots.length })
      const began = Date.now()
      const baselines = await Promise.all(slots.map(slot => { stats.baselines++; return runTests(opt.test, slot, Number(opt.timeout), stats) }))
      const bad = baselines.findIndex(b => !healthy(adapter, b))
      const baseline = baselines[bad] ?? baselines[0]
      const how = bad < 0 ? 'ok' : baseline.error || [126, 127].includes(baseline.code) ? 'infra' : baseline.timedOut ? 'timeout'
        : baseline.code === 0 ? 'no readable report or no tests' : 'failed'
      note('mutate.baseline', { outcome: how, jobs: slots.length, slot: bad < 0 ? null : bad + 1, code: baseline.code ?? null, signal: baseline.signal ?? null, timed_out: Boolean(baseline.timedOut), elapsed_ms: Date.now() - began })
      if (bad >= 0) {
        const log = keepLog('baseline_failed', { outcome: how, jobs: slots.length, slot: bad + 1, code: baseline.code ?? null, signal: baseline.signal ?? null, output: baseline.out })
        if (live) opEnd(live.runRoot, live.ctx, 'baseline_failed', `the unmutated baseline did not pass (${how}${slots.length > 1 ? ` in slot ${bad + 1} of ${slots.length}` : ''}); see ${log}`)
        live = null
        const parallel = slots.length > 1 ? ` With --jobs ${slots.length} the slots run at the same time: if they share a test database or a port, run again with --jobs 1.` : ''
        const reportHint = how === 'no readable report or no tests' ? ` The ${adapter} adapter reads the report the command writes to $STORY_LOOP_REPORT; make the command write it.` : ''
        throw new Error(`the test command fails on unmutated code in the disposable copy (${how}); fix that first, or --link the untracked files it needs.${parallel}${reportHint}\n${baseline.out.slice(-1500)}`)
      }
    }

    const progress = { files: covered, total: todo.length, done: 0, killed: 0, survived: 0, other: 0, carried: 0, running: [] }
    const report = () => {
      if (!live) return
      try { update(live.runRoot, r => r.ops?.[live.ctx.op] ? { ...r, ops: { ...r.ops, [live.ctx.op]: { ...r.ops[live.ctx.op], progress: { ...progress, at: new Date().toISOString() } } } } : undefined) } catch { /* progress is a view, never a reason to stop */ }
    }
    report()

    // Each slot takes the next mutant, breaks its own copy of the file, runs, and puts it back.
    let next = 0
    await Promise.all(slots.map(async slot => {
      while (next < todo.length) {
        if (Date.now() > budgetEnds) return
        const i = todo[next++]
        const m = queue[i]
        const path = join(slot.worktree, m.file)
        const original = m.lines.join('\n')
        progress.running = [...progress.running.filter(x => x.slot !== slot.n), { slot: slot.n, mutant: `${m.file}:${m.line}`, to: m.to.slice(0, 80) }]
        report()
        writeFileSync(path, m.lines.with(m.line - 1, m.mutated).join('\n'))
        let restored = false
        try {
          const valid = parses(root, m.file, path)
          const began = Date.now()
          if (valid === false) outcomes[i] = { ...row(m), outcome: 'invalid' }
          else {
            stats.mutants++
            const exec = await runTests(opt.test, slot, Number(opt.timeout), stats)
            let judged = judge(exec, adapter, readReport(adapter, exec.report))
            // A failure the report cannot pin on the mutant is checked against the unmutated code, in this slot, now.
            if (judged.recheck) {
              writeFileSync(path, original); restored = true
              stats.rechecks++; stats.baselines++
              judged = { ...settle(judged, healthy(adapter, await runTests(opt.test, slot, Number(opt.timeout), stats))), rechecked: true }
            }
            // A failing run of code nobody could check may be a parse error, not a test catching the change.
            const outcome = judged.outcome === 'killed' && valid === null ? 'unverified' : judged.outcome
            outcomes[i] = { ...row(m), outcome, ...(judged.kill_kind && outcome === 'killed' ? { kill_kind: judged.kill_kind } : {}),
              ...(judged.why ? { why: judged.why } : {}), ...(judged.rechecked ? { rechecked: true } : {}), log: exec.out.slice(-1500) }
          }
          results.push(outcomes[i])
          const o = outcomes[i].outcome
          progress.done++; progress[o === 'killed' ? 'killed' : o === 'survived' ? 'survived' : 'other']++
          progress.running = progress.running.filter(x => x.slot !== slot.n)
          progress.last = { mutant: `${m.file}:${m.line}`, outcome: o, tail: String(outcomes[i].log ?? '').trim().split('\n').slice(-3).join('\n').slice(-300) }
          report()
          // syntax_checked: true/false is the checker's answer; null means nothing here can check this file type.
          note('mutate.mutant', { mutant: m.id, outcome: o, kill_kind: outcomes[i].kill_kind ?? null, rechecked: Boolean(outcomes[i].rechecked), slot: slot.n, syntax_checked: valid, elapsed_ms: Date.now() - began })
        } finally { if (!restored) writeFileSync(path, original) }
      }
    }))
    // What the budget left unrun is recorded as not run, never dropped.
    for (const i of todo) if (!outcomes[i]) outcomes[i] = { ...row(queue[i]), outcome: 'skipped', why: slots.length ? `the --budget of ${opt.budget}s ran out` : 'no mutation capacity became free within the --budget' }
    // In queue order, whatever order the slots finished in.
    results.splice(0, results.length, ...outcomes.filter(Boolean))
  } finally {
    const slots = active?.slots ?? []
    const left = slots.filter(slot => slot.worktree && existsSync(slot.worktree)).length
    cleanup()
    note('mutate.cleanup', { outcome: slots.some(slot => slot.worktree && existsSync(slot.worktree)) ? 'worktree left behind' : 'ok', slots: left })
  }

  const byId = Object.fromEntries(results.map(r => [r.id, r.outcome]))
  const summary = { ...tally(byId), carried: 0, unsupported, tree,
    stats: { adapter, slots: stats.slots, mutant_runs: stats.mutants, baseline_runs: stats.baselines, rechecks: stats.rechecks, peak_test_processes: stats.peak, waited_ms: stats.waited_ms, elapsed_ms: Date.now() - stats.began, max_rss_mb: Math.round(process.resourceUsage().maxRSS / 1024) } }
  const label = { killed: 'killed  ', survived: 'SURVIVED', invalid: 'invalid ', timeout: 'timeout ', infra: 'infra   ', inconclusive: 'unclear ', unverified: 'UNVERIFIED', skipped: 'not run ', collection: 'collect ', build: 'build   ', no_tests: 'NO TESTS' }
  for (const r of results) console.log(`${label[r.outcome]} ${r.file}:${r.line}  ${r.from}  ->  ${r.to}${['survived', 'timeout', 'unverified', 'skipped', 'infra', 'inconclusive', 'no_tests'].includes(r.outcome) ? `  [${r.id}]` : ''}${r.kill_kind && r.kill_kind !== 'assertion' ? `  (${r.kill_kind}, clean code passed)` : ''}${r.why && r.outcome !== 'killed' ? `  (${r.why})` : ''}`)
  const notCovered = scope.filter(f => !covered.includes(f))
  console.log(`\n${summary.killed} of ${summary.valid} valid mutants killed` +
    [summary.invalid && `${summary.invalid} did not parse (not counted)`, summary.build && `${summary.build} did not compile (not counted)`,
      summary.collection && `${summary.collection} broke test collection (not counted)`, summary.unverified && `${summary.unverified} failed but could not be checked for valid syntax (not counted)`,
      summary.timeout && `${summary.timeout} timed out`,
      (summary.infra + summary.inconclusive + summary.no_tests) && `${summary.infra + summary.inconclusive + summary.no_tests} inconclusive`,
      summary.skipped && `${summary.skipped} not run`, unsupported.length && `${unsupported.length} file(s) not mutated`].filter(Boolean).map(s => `, ${s}`).join(''))
  console.log(`runs: ${stats.mutants} mutant, ${stats.baselines} unmutated (${stats.rechecks} rechecks), ${stats.slots} slot${stats.slots === 1 ? '' : 's'}, peak ${stats.peak} test processes, ${summary.stats.elapsed_ms} ms`)
  if (summary.survived) console.log('Each SURVIVED line is behaviour no test checks: add a test, or say why the mutant changes nothing observable (loop.mjs mutant accept <id> "<why>").')
  if (summary.unverified) console.log('UNVERIFIED: the tests failed, but no syntax checker for this file type is installed (typescript in the project), so it may be a parse error.')
  if (summary.timeout + summary.infra + summary.inconclusive + summary.no_tests) console.log('Timeouts, infra and inconclusive runs say nothing about the tests; look at them and run again before counting anything.')
  if (notCovered.length) console.log(`Changed source files not mutated in this call: ${notCovered.join(', ')}`)
  if (outside.length) console.log(`Changed files of a type this runner cannot mutate (name them in the report): ${outside.join(', ')}`)
  if (laneSkipped.length) console.log(`Not mutated in the ${lane.name} lane (name them in the report): ${laneSkipped.join(', ')}`)
  console.log(`RESULT ${JSON.stringify(summary)}`)
  if (opt.explore) return console.log('explore: nothing recorded; test review is unchanged')

  // Inside a run the result is evidence for test review, with the per-mutant log next to it:
  // for the run and attempt this call started in, and for no other.
  if (!live) return
  const { ctx } = live
  const log = keepLog('finished', { ...summary, results }) ?? fail(`the mutant log could not be written under ${runRoot}`)
  try {
    opUpdate(runRoot, ctx, (r, owned) => {
      // Calls on one tree and base merge per file: the newest call for a file replaces that
      // file's outcomes (its earlier log stays as history), other files keep theirs, in any
      // order the calls finish. Results of another run, attempt, tree or base are other evidence.
      const had = r.evidence?.mutants
      const prev = had && had.tree === tree && had.base === base && (had.merge_base ?? had.base) === base && (had.run ?? ctx.run) === ctx.run && (had.attempt ?? ctx.attempt) === ctx.attempt ? had : {}
      const fileOf = id => id.split(':').slice(0, -2).join(':')
      const mine = new Set(owned)
      const merged = { ...Object.fromEntries(Object.entries(prev.outcomes ?? {}).filter(([id]) => !mine.has(fileOf(id)))),
        ...Object.fromEntries(Object.entries(byId).filter(([id]) => mine.has(fileOf(id)))) }
      const kinds = { ...Object.fromEntries(Object.entries(prev.kill_kinds ?? {}).filter(([id]) => !mine.has(fileOf(id)))),
        ...Object.fromEntries(results.filter(x => x.kill_kind && mine.has(x.file)).map(x => [x.id, x.kill_kind])) }
      const mutants = {
        ...tally(merged), tree, base, merge_base: base, run: ctx.run, attempt: ctx.attempt, scope, outside, outcomes: merged, kill_kinds: kinds,
        lane: lane.name, lane_skipped: laneSkipped, identity: { ...prev.identity, [ctx.op]: identity },
        carried: [], carried_from: null,
        covered: [...new Set([...(prev.covered ?? []), ...covered.filter(f => mine.has(f))])],
        unsupported: [...new Set([...(prev.unsupported ?? []), ...unsupported])],
        // Reasons are keyed by stable mutant id on this tree: they stand for the same mutant whichever call ran it.
        dispositions: prev.dispositions ?? {},
        logs: [...(prev.logs ?? []), log],
      }
      return { ...r, evidence: { ...r.evidence, mutants } }
    }, { log, summary }, () => null, { partial: true })
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
export const OUTCOMES = ['killed', 'survived', 'invalid', 'build', 'collection', 'timeout', 'infra', 'inconclusive', 'no_tests', 'unverified', 'skipped']
export function tally(outcomes) {
  const all = Object.values(outcomes)
  const count = outcome => all.filter(o => o === outcome).length
  const t = Object.fromEntries(OUTCOMES.map(o => [o, count(o)]))
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
