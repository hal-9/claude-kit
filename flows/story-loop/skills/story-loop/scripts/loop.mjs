#!/usr/bin/env node
// story-loop state machine. The graph (graph.json) is the only source of which
// moves exist; this script refuses every other move, and a stage passes only
// when its evidence checks out (passProblem). State lives in the target repo
// under .start-story/, which must be gitignored.
import {
  readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, rmSync, renameSync, copyFileSync,
  statSync, realpathSync, openSync, readSync, closeSync, cpSync, symlinkSync, readdirSync,
} from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bind, record, toggle, exportBundle, diagDir, readEvents, readManifest, scrub } from './diag.mjs'
import { appendLedger, readLedger, summary as ledgerSummary, lessons as ledgerLessons, ledgerFile } from './ledger.mjs'
import { acquire } from './lease.mjs'

export const GRAPH = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'graph.json'), 'utf8'))
export const SCHEMA = 3
export const LEASE_MS = 15 * 60_000
const DONE = new Set(['passed', 'skipped'])
const PUT_KEYS = new Set(['title', 'branch', 'pr', 'base', 'repo', 'tasks', 'findings', 'browser', 'environment', 'required_checks', 'lane', 'lessons', 'evidence_sharing', 'web_guidance'])
// Which stages may be skipped, and on whose word. Everything else needs only a reason.
const SKIP = {
  contract: 'never', build: 'never', second_review: 'never', push: 'never', report: 'never',
  // With no Copilot comments fix_comments passes on its own; a skip would only hide open ones.
  fix_comments: 'never',
  // With nothing flagged the quality gate passes on its own, and a retro with nothing to learn records an empty list.
  quality: 'never', retro: 'never',
  // Copilot not answering is noted in the report, not a stop for the human.
  verify: 'human', copilot_review: 'reason', human_review: 'human',
}
// Stages whose evidence covers one exact code tree; a later change makes it stale.
export const FRESH = ['quality', 'test_review', 'verify', 'second_review']

// A run starts from a Shortcut story (sc-123) or a GitHub issue (gh-123).
// Accepts SC-123, 123, gh-123, #123, and the URL of either.
export function storyId(input = '') {
  const text = String(input).trim().toLowerCase()
  const issue = text.match(/^(?:gh-|#)(\d+)$/)?.[1] ?? (issueRepo(text) && text.match(/\/issues\/(\d+)\/?$/)[1])
  if (issue) return `gh-${issue}`
  const story = text.match(/^(?:sc-)?(\d+)$/) ?? text.match(/shortcut\.com\/[^/]+\/story\/(\d+)/)
  return story ? `sc-${story[1]}` : null
}
// owner/name of a GitHub issue URL or a git remote URL, lowercased; null for anything
// else. Parsed whole, never searched: the host must be github.com itself, the scheme,
// port and user one git uses for it, and the path exactly one owner/name. A URL that
// only contains "github.com/owner/name" somewhere (another host, a local path) is null.
const GH_HOST = 'github.com'
const OWNER = /^[a-z0-9](?:[a-z0-9-]{0,38})$/i
const NAME = /^[a-z0-9._-]{1,100}$/i
const repoPath = path => {
  const parts = String(path).replace(/\/$/, '').split('/')
  if (parts.length !== 2) return null
  const [owner, name] = [parts[0], parts[1].replace(/\.git$/i, '')]
  if (!OWNER.test(owner) || !NAME.test(name) || /^\.+$/.test(name)) return null
  return `${owner}/${name}`.toLowerCase()
}
const parsedUrl = text => { try { return new URL(text) } catch { return null } }
export function remoteRepo(url) {
  const text = String(url).trim()
  if (/[\s%\\]/.test(text)) return null
  // scp-like: git@github.com:owner/name(.git)
  const scp = text.match(/^git@github\.com:([^/].*)$/i)
  if (scp) return repoPath(scp[1])
  const u = parsedUrl(text)
  if (!u || u.hostname.toLowerCase() !== GH_HOST || u.search || u.hash || text.includes('#') || text.includes('?')) return null
  if (u.protocol === 'https:') return !u.port ? repoPath(u.pathname.slice(1)) : null
  if (u.protocol === 'ssh:') return u.username === 'git' && !u.password && !u.port ? repoPath(u.pathname.slice(1)) : null
  return null
}
export function issueRepo(input) {
  const text = String(input).trim()
  const u = /[\s%\\]/.test(text) ? null : parsedUrl(text)
  if (!u || u.protocol !== 'https:' || u.hostname.toLowerCase() !== GH_HOST || u.port || u.username || u.search || text.includes('?')) return null
  const m = u.pathname.match(/^\/([^/]+\/[^/]+)\/issues\/\d+\/?$/)
  return m ? repoPath(m[1]) : null
}
// A base is recorded as "main" or "origin/main"; both name the branch main.
export const baseName = base => String(base ?? '').replace(/^origin\//, '')
// The ref a diff is taken against: the remote branch when it exists. A local
// "main" lags origin/main, and diffing a branch cut from origin/main against it
// counts everyone else's commits as this change.
export function diffBase(git, base) {
  const remote = `origin/${baseName(base)}`
  try { git('rev-parse', '--verify', '--quiet', `${remote}^{commit}`); return remote } catch { return base }
}

export function newRun(story, now = new Date().toISOString()) {
  return {
    schema: SCHEMA, id: randomUUID().slice(0, 8), revision: 0, story, started_at: now, owner: null, stop_blocks: 0,
    stages: Object.fromEntries(GRAPH.stages.map(s => [s.id, { status: 'pending', rounds: 0, attempt: 1 }])),
    tasks: [], findings: [], evidence: {}, checks: null, history: [],
  }
}

// Old runs keep their data. A schema 1 run recorded no code tree, so nothing it
// passed counts as fresh evidence; a stage the graph gained since is pending, so
// the run stops there first.
export function migrate(run) {
  if (run.schema === SCHEMA || !run.stages || typeof run.stages !== 'object') return run
  const { session, ...rest } = run
  const from = run.schema ?? 1
  return {
    ...rest, schema: SCHEMA, revision: run.revision ?? 0, migrated_from: from,
    owner: from < 2 ? (session ? { session, since: run.started_at, heartbeat: 0 } : null) : run.owner ?? null,
    stages: { ...Object.fromEntries(GRAPH.stages.map(s => [s.id, { status: 'pending', rounds: 0, attempt: 1 }])),
      ...Object.fromEntries(Object.entries(run.stages).map(([id, s]) => [id, { attempt: 1, ...s }])) },
    checks: run.checks ?? null, history: run.history ?? [],
  }
}

const ids = () => GRAPH.stages.map(s => s.id)
const fail = message => { throw new Error(message) }
// The stages that run side by side (graph.json "parallel"): they read the same
// committed code and none needs another's result.
export const groupOf = stage => (GRAPH.parallel ?? []).find(g => g.includes(stage)) ?? [stage]

// The stage the loop must work on next: the first one that is not done.
export function current(run) {
  return ids().find(id => !DONE.has(run.stages[id].status)) ?? null
}
// Every stage that may be worked on now: the current one and the rest of its
// parallel group that is not done yet.
export function active(run) {
  const cur = current(run)
  return cur ? groupOf(cur).filter(id => !DONE.has(run.stages[id].status)) : []
}
// The stages that stop for the human: the contract, the report's open questions and the human review.
export const HUMAN_STAGES = ['contract', 'report', 'human_review']

// One move. Returns the new run; throws with the reason when the graph forbids it.
// Evidence gates are separate (passProblem) so this stays pure.
export function move(run, verb, stage, arg, reason, now = new Date().toISOString()) {
  const next = structuredClone(run)
  const st = next.stages[stage] ?? fail(`unknown stage "${stage}" (stages: ${ids().join(', ')})`)
  const cur = current(next)
  const needReason = () => reason || fail(`"${verb}" needs a reason`)
  // A finished run can still be sent back from its last stage (a human note after the report).
  const mustBeCurrent = () => active(next).includes(stage) || (verb === 'back' && cur === null && stage === ids().at(-1)) ||
    fail(`"${stage}" is not the current stage; current is "${active(next).join('", "') || cur}"`)

  switch (verb) {
    case 'start':
      mustBeCurrent()
      Object.assign(st, { status: 'running', started_at: now, reason: undefined, waiting_on: undefined })
      break
    case 'pass':
      st.status === 'running' || fail(`"${stage}" is ${st.status}, not running; start it first`)
      Object.assign(st, { status: 'passed', ended_at: now, reason })
      break
    case 'skip': {
      mustBeCurrent(); needReason()
      const policy = SKIP[stage] ?? 'reason'
      policy === 'never' && fail(`${stage} is never skipped; block it with the reason instead`)
      policy === 'human' && !/^human:/i.test(reason) &&
        fail(`${stage} is skipped only on the human's say-so: skip ${stage} "human: <their reason>". A missing tool is a wait, not a skip`)
      Object.assign(st, { status: 'skipped', ended_at: now, reason })
      break
    }
    case 'block':
      mustBeCurrent(); needReason()
      Object.assign(st, { status: 'blocked', reason })
      break
    case 'wait':
      mustBeCurrent(); needReason()
      // background: a command the conductor started in the background (a Codex review) and is idle for; its end wakes it.
      ;['human', 'copilot', 'background'].includes(arg) || fail('wait needs who: human | copilot | background')
      // Between the contract and the human review the loop runs on: the advisor decides, open questions go into the report.
      arg === 'human' && !HUMAN_STAGES.includes(stage) && !/^critical:/i.test(reason) &&
        fail(`${stage} does not wait on the human. Decide with the advisor and go on: park a finding or a size question for the human review (the report lists it). ` +
          `Only what makes going on impossible or unsafe waits: wait ${stage} human "critical: <what>" (no browser reachable, the remote moved, a note that changes the contract)`)
      Object.assign(st, { status: 'waiting', waiting_on: arg, reason })
      break
    case 'back': {
      needReason(); mustBeCurrent()
      GRAPH.back.some(([from, to]) => from === stage && to === arg) ||
        fail(`no edge ${stage} -> ${arg} in the graph`)
      const target = next.stages[arg]
      // The cap stops the agent looping on its own; a human asking for a change is not a loop.
      // ponytail: "human:" is the agent's word that the human asked; no host primitive proves it.
      const byHuman = /^human:/i.test(reason)
      !byHuman && target.rounds >= GRAPH.maxRounds &&
        fail(`"${arg}" already went back ${GRAPH.maxRounds} times. Park what is still open for the human review and go on (a blocker: block ${stage} "<what>")`)
      const all = ids()
      for (const id of all.slice(all.indexOf(arg))) {
        const s = next.stages[id]
        next.stages[id] = { status: 'pending', rounds: s.rounds, attempt: (s.attempt ?? 1) + 1 }
      }
      // Evidence of the old attempt is history now: kept, never counted again.
      next.history = [...(next.history ?? []), { at: now, from: stage, to: arg, reason, evidence: next.evidence }]
      next.evidence = {}
      if (!byHuman) next.stages[arg].rounds += 1
      next.stages[arg].reason = reason
      break
    }
    case 'reopen':
      // A finished sibling of the parallel group that is still running, whose evidence no
      // longer covers its inputs (tests committed since, a changed check list), runs again
      // without a round back to build. Not a round: nothing about the build changed.
      needReason()
      groupOf(stage).includes(cur) && stage !== cur || active(next).includes(stage) ||
        fail(`"${stage}" is not in the running parallel group; a stage outside it goes back to build`)
      DONE.has(st.status) || ['running', 'waiting', 'blocked'].includes(st.status) || fail(`"${stage}" is ${st.status}; nothing to reopen`)
      next.history = [...(next.history ?? []), { at: now, reopened: stage, attempt: st.attempt ?? 1, reason }]
      next.stages[stage] = { status: 'pending', rounds: st.rounds, attempt: (st.attempt ?? 1) + 1, reason }
      break
    default:
      fail(`unknown verb "${verb}" (start | pass | skip | block | wait | back | reopen)`)
  }
  next.stop_blocks = 0
  return next
}

// A worker the hook saw start and never saw stop counts as running for this long;
// past it, a worker that died without a SubagentStop no longer holds the gate open.
export const WORKER_TTL_MS = 60 * 60_000
export const liveWorkers = (run, now = Date.now()) => Object.entries(run.live_workers ?? {}).filter(([, since]) => now - since < WORKER_TTL_MS).map(([id]) => id)

// The run's background helpers (mutate, copilot-wait, …) whose process still runs.
export const liveHelpers = run => Object.values(run.ops ?? {}).filter(o => alive(o.pid))

// What the Stop hook decides: null lets the session end, a string keeps it going.
// Workers or background helpers still running let it end: the conductor waits for
// their reports by being idle (their end wakes it), never by polling files.
export function stopReason(run, now = Date.now()) {
  const open = active(run).filter(id => !['waiting', 'blocked'].includes(run.stages[id].status))
  if (!open.length) return null
  if (liveWorkers(run, now).length || liveHelpers(run).length) return null
  const cur = open[0]
  const human = HUMAN_STAGES.includes(cur) ? 'human' : 'human "critical: <what>"'
  return `story-loop ${run.story}: stage "${cur}" is ${run.stages[cur].status}. Carry on with it, or record why it stops: ` +
    `loop.mjs wait ${cur} background "<what runs>" | loop.mjs wait ${cur} ${human} | loop.mjs block ${cur} "<reason>".`
}

// ---- ownership ----------------------------------------------------------------
// One conductor session owns a run. Its hook calls renew a lease; a lease nobody
// renewed for LEASE_MS is expired and may be taken by `loop.mjs acquire`.

export function ownerState(run, session, now = Date.now()) {
  const owner = run.owner
  if (!owner?.session) return 'unowned'
  if (owner.session === session) return 'ours'
  return now - (owner.heartbeat ?? 0) > LEASE_MS ? 'expired' : 'live'
}

// ---- files -----------------------------------------------------------------

export function findRoot(from = process.cwd()) {
  for (let dir = resolve(from); ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.start-story', 'active.json'))) return dir
    // A checkout's own root ends the search: a worktree nested inside the run's checkout is other work.
    if (dir === dirname(dir) || existsSync(join(dir, '.git'))) return null
  }
}
export const paths = root => ({
  dir: join(root, '.start-story'),
  active: join(root, '.start-story', 'active.json'),
  prev: join(root, '.start-story', 'active.prev.json'),
  events: join(root, '.start-story', 'events.jsonl'),
  lock: join(root, '.start-story', '.lock'),
})
export const runDir = (root, run) => join(root, '.start-story', run.story)
// What names one run: two runs of the same story are different runs.
export const runKey = run => run.id ?? run.started_at

// Valid JSON is not yet a run or a list of notes: {} parses and is neither.
// Reading, keeping a backup and recovering all ask these two the same question.
export function runProblem(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return 'not a run object'
  if (typeof data.story !== 'string' || !data.story) return 'it names no story'
  if (!data.stages || typeof data.stages !== 'object') return 'it has no stages'
  const missing = ids().filter(id => typeof data.stages[id]?.status !== 'string')
  return missing.length ? `stage ${missing[0]} has no status` : null
}
export function notesProblem(data) {
  if (!Array.isArray(data)) return 'not a list of notes'
  const bad = data.findIndex(n => !n || typeof n !== 'object' || typeof n.id !== 'string' || typeof n.status !== 'string')
  return bad < 0 ? null : `entry ${bad + 1} is not a note (id and status)`
}
// The parsed file when it is what `problem` accepts; throws with the reason otherwise.
function readValid(file, problem) {
  const data = JSON.parse(readFileSync(file, 'utf8'))
  const why = problem(data)
  if (why) throw new Error(why)
  return data
}

export function load(root) {
  const file = paths(root).active
  let text
  try { text = readFileSync(file, 'utf8') } catch (error) { fail(`no run state at ${file} (${error.code})`) }
  try {
    const run = migrate(JSON.parse(text))
    const why = runProblem(run)
    if (why) throw new Error(why)
    return run
  } catch (error) {
    fail(`the run state ${file} is unreadable (${error.message}); restore the last good copy with: loop.mjs recover`)
  }
}
// Crash-safe: write a temp file, keep the previous good state, then rename over.
export function save(root, run) {
  const p = paths(root)
  const tmp = `${p.active}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(run, null, 2) + '\n')
  try { readValid(p.active, data => runProblem(migrate(data))); copyFileSync(p.active, p.prev) } catch { /* no good state to keep */ }
  renameSync(tmp, p.active)
}
export function emit(root, event) {
  // Scrubbed at the boundary, diagnostics on or off: stage reasons and notes can quote a command.
  appendFileSync(paths(root).events, JSON.stringify(scrub({ ts: new Date().toISOString(), ...event })) + '\n')
  // The board feed is emptied by every init; the diagnostic stream of a run is not.
  if (event.kind === 'note' || event.kind === 'session') record(root, 'feed', { feed: event.kind, phase: event.phase, text: event.text })
}

const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
// A lock is stale when its holder is dead, or it never got a pid and is old.
function staleLock(lock) {
  let pid = null
  try { pid = Number(readFileSync(join(lock, 'pid'), 'utf8')) } catch { /* not written yet */ }
  if (pid) { try { process.kill(pid, 0); return false } catch (error) { return error.code === 'ESRCH' } }
  try { return Date.now() - statSync(lock).mtimeMs > 30_000 } catch { return false }
}
// Every read-modify-write of .start-story goes through this one lock, so two
// processes never lose each other's change. ponytail: one lock for the whole
// folder; finer locks only if the board ever contends with the hooks.
// Only one process at a time may break a stale lock, and it looks again once it
// is the one: a waiter that saw the old lock can never remove its replacement.
function breakStale(lock) {
  const guard = `${lock}.break`
  try { mkdirSync(guard) } catch {
    // ponytail: a breaker that died in this short window leaves the guard behind;
    // it is cleared by age alone, which is the one place two waiters could still collide.
    try { if (Date.now() - statSync(guard).mtimeMs > 30_000) rmSync(guard, { recursive: true, force: true }) } catch {}
    return
  }
  try { if (staleLock(lock)) rmSync(lock, { recursive: true, force: true }) } finally { rmSync(guard, { recursive: true, force: true }) }
}
export function withLock(root, fn, wait = Number(process.env.STORY_LOOP_LOCK_WAIT) || 10_000) {
  const { lock } = paths(root)
  const deadline = Date.now() + wait
  for (;;) {
    try { mkdirSync(lock); writeFileSync(join(lock, 'pid'), String(process.pid)); break } catch (error) {
      if (error.code !== 'EEXIST') throw error
      Date.now() > deadline && fail(`the run state is locked by another process (${lock}); try again`)
      if (staleLock(lock)) breakStale(lock)
      sleep(20)
    }
  }
  try { return fn() } finally {
    try { if (readFileSync(join(lock, 'pid'), 'utf8') === String(process.pid)) rmSync(lock, { recursive: true, force: true }) } catch {}
  }
}
// Read, change, write under the lock. fn gets a copy; returning undefined writes nothing.
export function update(root, fn) {
  return withLock(root, () => {
    const run = load(root)
    const next = fn(structuredClone(run))
    if (next === undefined) return run
    next.revision = (run.revision ?? 0) + 1
    next.updated_at = new Date().toISOString()
    save(root, next)
    return next
  })
}

// ---- operations ------------------------------------------------------------------
// A helper that takes time (tests, polling, a push, a gh call) notes who it works
// for before it starts and is checked against that, under the lock, before its
// result becomes run state. A result that comes back to another run or a newer
// attempt is kept under its own identity and changes nothing.

export function opContext(root, run, kind, stage, extra = {}) {
  return {
    op: randomUUID().slice(0, 8), kind, run: runKey(run), story: run.story, stage, attempt: run.stages[stage]?.attempt ?? 1,
    generation: run.owner?.generation ?? 0, tree: headTree(root), commit: headCommit(root), base: run.base ?? null,
    started_at: new Date().toISOString(), ...extra,
  }
}
const alive = pid => { try { process.kill(pid, 0); return true } catch (error) { return error.code !== 'ESRCH' } }
// For the helpers that run long: also listed in the run, so status, a takeover and `end` can see them.
export function opStart(root, kind, stage, extra = {}) {
  let ctx
  const run = update(root, r => {
    ctx = opContext(root, r, kind, stage, extra)
    // A helper that was killed hard never said it ended; its entry goes when the next one starts.
    const ops = Object.fromEntries(Object.entries(r.ops ?? {}).filter(([, o]) => alive(o.pid)))
    return { ...r, ops: { ...ops, [ctx.op]: { kind, stage, attempt: ctx.attempt, pid: process.pid, started_at: ctx.started_at } } }
  })
  bind(root, run, ctx)
  record(root, 'op.start', { kind, pid: process.pid, ...extra })
  return ctx
}
export function staleReason(run, ctx) {
  if (runKey(run) !== ctx.run) return `run ${ctx.run} (${ctx.story}) is no longer the active run; ${run.story} run ${runKey(run)} is`
  const attempt = run.stages[ctx.stage]?.attempt ?? 1
  return attempt === ctx.attempt ? null : `${ctx.stage} is on attempt ${attempt}; this ${ctx.kind} started in attempt ${ctx.attempt}`
}
// Applies fn only while ctx still names the active run and attempt (and `also`
// finds nothing else changed). Otherwise `result` is kept under the identity it
// was produced for, and the caller gets an error of kind "stale".
export function opUpdate(root, ctx, fn, result, also = () => null) {
  let why = null
  let next
  try {
    next = update(root, r => {
      why = staleReason(r, ctx) ?? also(r)
      return why ? undefined : fn(r)
    })
  } catch (error) {
    if (existsSync(paths(root).active)) throw error
    why = `run ${ctx.run} (${ctx.story}) has ended`
  }
  if (!why) return next
  const dir = join(root, '.start-story', ctx.story, 'stale')
  const file = join(dir, `${ctx.kind}-${ctx.op}.json`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(file, JSON.stringify({ why, at: new Date().toISOString(), context: ctx, result }, null, 2) + '\n')
  record(root, 'op.stale', { kind: ctx.kind, op: ctx.op, stage: ctx.stage, attempt: ctx.attempt, reason: why, kept: file })
  const error = new Error(`this ${ctx.kind} finished for ${ctx.story} run ${ctx.run}, attempt ${ctx.attempt}, but ${why}. Its result changes nothing here and is kept in ${file}`)
  error.kind = 'stale'
  throw error
}
export function opEnd(root, ctx, outcome, reason) {
  let changed = false
  try {
    update(root, r => {
      if (runKey(r) !== ctx.run || !r.ops?.[ctx.op]) return undefined
      changed = (r.owner?.generation ?? 0) !== ctx.generation
      const { [ctx.op]: _, ...ops } = r.ops
      return { ...r, ops }
    })
  } catch { /* the run ended or is unreadable: there is no entry left to clear */ }
  record(root, 'op.end', { kind: ctx.kind, op: ctx.op, stage: ctx.stage, attempt: ctx.attempt, outcome, reason, ownership_changed: changed,
    elapsed_ms: Date.now() - Date.parse(ctx.started_at) })
}
// `end` asks the helpers of the run it ends to stop. Only a process that still is
// one of ours is signalled; whatever it had already done outside stays done.
function cancelOps(run) {
  const out = []
  for (const [op, o] of Object.entries(run.ops ?? {})) {
    let command = ''
    try { command = execFileSync('ps', ['-p', String(o.pid), '-o', 'command='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }) } catch {}
    const ours = /(mutate|quality|github|publish)\.mjs/.test(command)
    if (ours) { try { process.kill(o.pid, 'SIGTERM') } catch {} }
    out.push({ op, kind: o.kind, pid: o.pid, signalled: ours })
  }
  return out
}

// ---- git -----------------------------------------------------------------------

export const gitIn = root => (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
export function headTree(root) { try { return gitIn(root)('rev-parse', 'HEAD^{tree}') } catch { return null } }
export function headCommit(root) { try { return gitIn(root)('rev-parse', 'HEAD') } catch { return null } }
export function dirty(root) { try { return gitIn(root)('status', '--porcelain') } catch { return 'not a git checkout' } }

// Why a passed stage's evidence no longer covers its inputs, or null. One answer for the
// stage gates, publication, the board and the report. Each kind of evidence names what
// it depends on:
//   quality, test_review  the exact code tree (tests, config and lockfiles are in it), and for mutants the lane
//   verify                the application code (a commit of tests only leaves it standing), the approved
//                         check list revision and the environment the browser tested
//   second_review         the exact code tree: tests are executable code and are reviewed too
// A passed stage that names no tree (a run from before 0.7) proves nothing about this code.
// Stale evidence stays on record with its reason; it never satisfies a current gate.
export function evidenceStale(root, run, id, tree = headTree(root)) {
  const s = run.stages[id]
  if (s?.status !== 'passed' || !FRESH.includes(id)) return null
  if (id === 'verify') {
    const request = s.request
    if (request && (request.checks_revision ?? 0) !== (run.checks_revision ?? 0)) return 'the approved check list changed since the browser ran'
    if (request && run.environment && request.env_tag !== undefined && request.env_tag !== envTag(run.environment)) return 'the environment changed since the browser ran'
    if (s.tree !== tree && !(s.commit && testsOnlySince(root, s.commit))) return 'the application code changed since the browser ran'
    return null
  }
  if (id === 'test_review' && s.lane && s.lane !== (run.lane?.lane ?? 'standard')) return `the mutants ran under the ${s.lane} lane`
  return s.tree === tree ? null : 'the code changed since it passed'
}
export function staleStages(root, run, tree = headTree(root)) {
  return FRESH.filter(id => evidenceStale(root, run, id, tree))
}

// ---- notes from the board ----------------------------------------------------
// A note is the human's instruction, typed on the board, kept per run.
// queued -> copied (the human took the handover text) -> delivered (a hook put
// it in the conductor's context) -> done (the agent says what it did).
// A copied note is still delivered by the hook: a duplicate beats a lost note.

const inboxFile = (root, run) => join(runDir(root, run), 'inbox.json')
const legacyInbox = root => join(root, '.start-story', 'inbox.json')
export function readInbox(root, run) {
  // Runs from before 0.7 kept one inbox for the whole folder.
  const file = existsSync(inboxFile(root, run)) ? inboxFile(root, run) : legacyInbox(root)
  let text
  try { text = readFileSync(file, 'utf8') } catch (error) { if (error.code === 'ENOENT') return []; throw error }
  // An unreadable inbox is never an empty one: the notes in it are the human's instructions.
  try {
    const notes = JSON.parse(text)
    const why = notesProblem(notes)
    return why ? fail(why) : notes
  } catch (error) {
    fail(`the notes file ${file} is unreadable (${error.message}); nothing was changed. Restore the last good copy with: loop.mjs recover`)
  }
}
// Crash-safe like save(): temp file, keep the previous good copy, rename over.
export function writeInbox(root, run, notes) {
  mkdirSync(runDir(root, run), { recursive: true })
  const file = inboxFile(root, run)
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(notes, null, 2) + '\n')
  try { readValid(file, notesProblem); copyFileSync(file, `${file}.prev`) } catch { /* no good copy to keep */ }
  renameSync(tmp, file)
}

const KINDS = { note: 'note', wrong: 'this is wrong', change: 'change request', fix: 'fix it after all', answer: 'answer to your question' }

// The text an agent receives, whether a hook injects it or the human pastes it.
export function handover(run, notes) {
  const head = `Notes from the human, sent from the story-loop board ` +
    `(story ${run.story}${run.pr ? `, PR ${run.pr}` : ''}, current stage: ${current(run) ?? 'all stages done'}).`
  const items = notes.map(n => [
    `[${n.id}] ${KINDS[n.kind] ?? 'note'}${n.stage ? ` · stage ${n.stage}` : ''}${n.file ? ` · ${n.file}` : ''}${n.finding ? ` · finding ${n.finding}` : ''}`,
    n.kind === 'answer' && n.question ? `  You asked: "${n.question}"` : '',
    n.kind === 'answer' ? `  human: ${n.verdict === 'yes' ? 'yes' : 'no'}${n.text ? ` — ${n.text}` : ''}` : `  ${n.text}`,
    n.context ? `  (They were reading: "${n.context}")` : '',
  ].filter(Boolean).join('\n'))
  return [head,
    'These are my instructions, not suggestions. Handle each one as the story-loop skill\'s "Notes from the board" section says ' +
    '(if that skill is not loaded in this session, load it with /story-loop and run its `status` command first). ' +
    'A note you already handled under the same id needs nothing more. ' +
    'When a note is handled, record it: loop.mjs note done <id> "<what you did>".',
    ...items].join('\n\n')
}

// Adds one note under the lock; returns its id.
export function addNote(root, note) {
  return withLock(root, () => {
    const run = load(root)
    const notes = readInbox(root, run)
    const id = `n${notes.length + 1}`
    writeInbox(root, run, [...notes, { id, ts: new Date().toISOString(), status: 'queued', ...note }])
    emit(root, { kind: 'note', text: `note ${id} queued for the agent` })
    record(root, 'note.queued', { note: id, note_kind: note.kind })
    return id
  })
}

// Hands every note the agent has not received to it. via 'copy' only marks them
// copied (a clipboard is not a receipt) and includes earlier copied ones again.
// A delivery is to one session: a note that was handed to an earlier owner and
// never marked done is handed to the session that owns the run now, once, under
// the same id.
export function deliver(root, via, session) {
  return withLock(root, () => {
    const run = load(root)
    const notes = readInbox(root, run)
    const copy = via === 'copied from the board'
    const open = notes.filter(n => n.status === 'queued' || n.status === 'copied' ||
      (!copy && session && n.status === 'delivered' && n.delivered_to !== session))
    if (!open.length) return null
    const status = copy ? 'copied' : 'delivered'
    writeInbox(root, run, notes.map(n => open.includes(n) ? { ...n, status, via, ...(copy ? {} : { delivered_to: session ?? null }) } : n))
    emit(root, { kind: 'note', text: `${open.length} note${open.length > 1 ? 's' : ''} ${copy ? 'copied for the agent' : `handed to the agent (${via})`}` })
    for (const n of open) record(root, copy ? 'note.copied' : 'note.delivered', { note: n.id, via, session: session ?? null, generation: run.owner?.generation ?? 0, again: n.status === 'delivered' })
    return handover(run, open)
  })
}

// Waits for the human's answer from the board and returns it. Run in the background
// while a stage waits on the human: the process ending is what wakes an idle
// conductor, so a click on the board needs no message typed into the session.
// One waiter per run: a newer one takes over and the older one ends quietly.
// ponytail: polls a local file every interval; nothing leaves the machine and no model runs.
export function awaitHuman(root, run, { minutes = 12 * 60, interval = 2000 } = {}) {
  const dir = runDir(root, run)
  mkdirSync(dir, { recursive: true })
  const pidFile = join(dir, 'waiter.pid')
  writeFileSync(pidFile, String(process.pid))
  const mine = () => { try { return readFileSync(pidFile, 'utf8').trim() === String(process.pid) } catch { return false } }
  const deadline = Date.now() + minutes * 60_000
  try {
    for (;;) {
      if (!mine()) return { outcome: 'replaced' }
      const now = load(root)
      if (runKey(now) !== runKey(run)) return { outcome: 'ended' }
      const text = deliver(root, 'from the board while you waited', now.owner?.session ?? null)
      if (text) return { outcome: 'answered', text }
      if (Date.now() > deadline) return { outcome: 'timeout' }
      sleep(interval)
    }
  } finally {
    if (mine()) rmSync(pidFile, { force: true })
  }
}

// ---- evidence gates --------------------------------------------------------------

export const resultsFile = (root, run) => join(runDir(root, run), 'results.json')
export const evidenceDir = (root, run) => join(runDir(root, run), 'evidence')
// The verifier writes { "request": "<id from start verify>", "results": [...] }.
// A bare array (before 0.8) is read, but carries no request and so never passes.
export function readResultsFile(root, run) {
  let data
  try { data = JSON.parse(readFileSync(resultsFile(root, run), 'utf8')) } catch { return null }
  if (Array.isArray(data)) return { request: null, results: data }
  return Array.isArray(data?.results) ? { request: data.request ?? null, results: data.results } : null
}
export const readResults = (root, run) => readResultsFile(root, run)?.results ?? null

// What `start verify` hands the verifier: the run, attempt, check list and code
// tree these results are for. Results carrying another id are not this attempt's.
export function verifyRequest(run, tree, commit = null) {
  const attempt = run.stages.verify.attempt ?? 1
  const checks_revision = run.checks_revision ?? 0
  const environment = run.environment ? requestEnvironment(run.environment, tree, commit) : null
  const env = environment ? envTag(run.environment) : ''
  return { id: `${runKey(run)}-a${attempt}-c${checks_revision}-${String(tree).slice(0, 12)}${env}`, tree, commit, attempt, checks_revision, environment, env_tag: env }
}

const envTag = env => `-e${createHash('sha1').update(JSON.stringify(env)).digest('hex').slice(0, 6)}`
// Where the browser will test, and what ties that place to the code under review.
//   {"url":"http://127.0.0.1:3000","kind":"local","server":"bin/dev, started from this checkout"}
//   {"url":"https://pr-12.preview.example","kind":"remote","revision":"<commit the deployment reports>"}
//   {"url":"https://staging.example","kind":"remote","unlinked":"human: <why testing other code is acceptable>"}
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\]|.+\.localhost|.+\.test)$/i
const urlOf = text => { try { const u = new URL(String(text)); return /^https?:$/.test(u.protocol) ? u : null } catch { return null } }
export function environmentProblem(env) {
  if (!env || typeof env !== 'object' || Array.isArray(env)) return 'environment is a JSON object: {"url":…,"kind":"local"|"remote",…}'
  const url = urlOf(env.url)
  if (!url) return 'environment needs the base URL the browser opens (url, http or https)'
  if (env.kind === 'local') return LOCAL_HOST.test(url.hostname) ? null : `"${url.hostname}" is not a local address; a deployed environment is "kind":"remote" with the revision it serves`
  if (env.kind !== 'remote') return 'environment needs "kind": "local" (a server started from this checkout) or "remote" (a deployment)'
  if (env.revision !== undefined) return /^[0-9a-f]{7,40}$/i.test(String(env.revision)) ? null : 'revision is the commit the deployment reports (7 to 40 hex characters)'
  return /^human:/i.test(String(env.unlinked ?? '')) ? null
    : 'a remote environment needs "revision" (the commit it serves, read from the deployment), or "unlinked": "human: <their reason>" when nothing ties it to this code'
}
// What the request records. provenance says how far the browser's page is tied to the reviewed code:
//   local-checkout       the conductor's word that the server at url runs this checkout (commit and tree recorded)
//   deployment-revision  the deployment reported the commit under review
//   unlinked             nothing ties the page to this code; the human accepted that. Never exact-code verification.
function requestEnvironment(env, tree, commit) {
  const base = { url: env.url, kind: env.kind }
  if (env.kind === 'local') return { ...base, provenance: 'local-checkout', build: { commit, tree }, server: env.server ?? null }
  if (env.revision !== undefined) return { ...base, provenance: 'deployment-revision', build: { commit: String(env.revision) } }
  return { ...base, provenance: 'unlinked', unlinked: env.unlinked }
}
const sameEnvironment = (a, b) => String(a ?? '').trim().replace(/\/+$/, '') === String(b ?? '').trim().replace(/\/+$/, '')

const MAGIC = [[0x89, 0x50, 0x4e, 0x47], [0xff, 0xd8, 0xff]]
// A screenshot must be a real PNG/JPEG/WebP file inside the evidence folder.
export function imageProblem(dir, file) {
  let real, base
  try { base = realpathSync(dir); real = realpathSync(resolve(dir, String(file))) } catch { return `screenshot ${file} does not exist` }
  if (!real.startsWith(base + sep)) return `screenshot ${file} is outside the evidence folder`
  const st = statSync(real)
  if (!st.isFile()) return `screenshot ${file} is not a file`
  if (st.size < 64) return `screenshot ${file} is too small to be an image`
  const head = Buffer.alloc(12)
  const fd = openSync(real, 'r'); readSync(fd, head, 0, 12, 0); closeSync(fd)
  const webp = head.toString('latin1', 0, 4) === 'RIFF' && head.toString('latin1', 8, 12) === 'WEBP'
  if (!webp && !MAGIC.some(m => m.every((b, i) => head[i] === b))) return `screenshot ${file} is not a PNG, JPEG or WebP image`
  // A capture cut off while it was written keeps its header and loses its end.
  // ponytail: this checks the container's end marker, it does not decode pixels.
  const tail = Buffer.alloc(64)
  const fd2 = openSync(real, 'r'); readSync(fd2, tail, 0, 64, st.size - 64); closeSync(fd2)
  const whole = webp ? Math.abs(head.readUInt32LE(4) + 8 - st.size) <= 1
    : head[0] === 0x89 ? tail.subarray(-8).equals(Buffer.from('49454e44ae426082', 'hex'))
    : tail.includes(Buffer.from([0xff, 0xd9]))
  if (!whole) return `screenshot ${file} is cut off (its end is missing); capture it again`
  return null
}

// The approved check list is the denominator: every check exactly once, nothing invented.
// Returns what the gate decides and why, row by row, so the board shows the same
// decision instead of its own reading of the file:
//   problem  why verify cannot pass, or null
//   rows     one per reported result: { id, accepted, reason }; accepted means it
//            counts as passing evidence for the current request
//   accepted / total  against the approved list
export function verifyReport(root, run) {
  const checks = run.checks
  const request = run.stages?.verify?.request ?? null
  const written = readResultsFile(root, run)
  const results = Array.isArray(written?.results) ? written.results : []
  const out = (problem, rows = results.map((r, i) => ({ id: r?.id ?? `invalid-${i + 1}`, accepted: false, reason: problem }))) => ({
    problem, rows, request: request?.id ?? null, results_request: written?.request ?? null,
    accepted: rows.filter(r => r.accepted).length, total: Array.isArray(checks) ? checks.length : 0,
    provenance: request?.environment?.provenance ?? null,
  })
  if (!Array.isArray(checks)) return out('no approved check list yet (loop.mjs checks set \'[{"id":…,"step":…}]\')')
  if (!checks.length) return out('the approved check list is empty: no user journey, so verify is skipped on the human\'s say-so, not passed')
  if (!request) return out('verify was not started on this attempt; loop.mjs start verify prints the request id the results must carry')
  if (request.checks_revision !== (run.checks_revision ?? 0)) return out('the check list changed since verify started; run loop.mjs start verify again and verify against the new list')
  if (!request.environment) return out('this verify request names no environment; record it (loop.mjs put environment \'{"url":…,"kind":"local"}\') and run loop.mjs start verify again')
  if (!results.length) return out(`0 of ${checks.length} checks reported; the verifier has not written ${resultsFile(root, run)}`)
  if (written.request !== request.id)
    return out(`the results carry request "${written.request ?? 'none'}", not this attempt's "${request.id}"; they belong to another attempt, check list or run`)
  const approved = new Map(checks.map(c => [c.id, c]))
  const count = new Map()
  for (const r of results) count.set(r?.id, (count.get(r?.id) ?? 0) + 1)
  const rowProblem = r => {
    if (!r || typeof r !== 'object' || Array.isArray(r)) return 'this result is not an object'
    const check = approved.get(r.id)
    if (!check) return `result "${r.id}" is not in the approved check list`
    if (count.get(r.id) > 1) return `check "${r.id}" is reported twice`
    if (r.carried && !(request.carried ?? []).includes(r.id))
      return `check "${r.id}" is marked carried over, but this attempt runs it again (changed code serves its step); the browser must check it`
    if (r.verdict !== 'pass') return `check "${r.id}" is "${r.verdict}", not pass`
    if (r.step !== check.step) return `check "${r.id}" reports Test Step ${r.step ?? '(none)'}; the approved list has it under step ${check.step}`
    if ((r.case ?? null) !== (check.case ?? null)) return `check "${r.id}" reports case "${r.case ?? '(none)'}"; the approved list says "${check.case ?? '(none)'}"`
    if (typeof r.text !== 'string' || !r.text.trim()) return `check "${r.id}" does not quote the goal it checked (text)`
    if (!urlOf(r.url)) return `check "${r.id}" does not record the URL it ended on (url)`
    if (!sameEnvironment(r.environment, request.environment.url))
      return `check "${r.id}" ran against "${r.environment ?? '(none)'}", not the requested environment "${request.environment.url}"`
    if (!Array.isArray(r.evidence) || !r.evidence.length) return `check "${r.id}" has no screenshot`
    for (const file of r.evidence) {
      const problem = imageProblem(evidenceDir(root, run), file)
      if (problem) return `check "${r.id}": ${problem}`
    }
    return designProblem(r, check)
  }
  const rows = results.map((r, i) => { const reason = rowProblem(r); return { id: r?.id ?? `invalid-${i + 1}`, accepted: !reason, reason } })
  // The order of the first reported problem: nothing invented or doubled, then nothing missing, then each row.
  const structural = rows.find(r => /not in the approved check list|reported twice|not an object/.test(r.reason ?? ''))
  if (structural) return out(structural.reason, rows)
  const seen = new Set(rows.map(r => r.id))
  const missing = checks.filter(c => !seen.has(c.id)).map(c => c.id)
  if (missing.length) return out(`${seen.size} of ${checks.length} checks reported; missing: ${missing.join(', ')}`, rows)
  return out(rows.find(r => r.reason)?.reason ?? null, rows)
}
export const verifyProblem = (root, run) => verifyReport(root, run).problem

// ---- what a later attempt runs again -------------------------------------------
// Decided from the diff and the run's own records, no model: a browser check keeps
// its earlier pass when no changed code serves its Test Step; a second review of a
// small fix confirms the fix instead of reading the whole branch blind again.
// ponytail: path patterns decide what a test file is; a helper outside them counts as code (reruns more, never less).
export const isTestFile = f => /(^|\/)(spec|specs|test|tests|__tests__)\/|_spec\.rb$|\.(test|spec)\.[cm]?[jt]sx?$/.test(f)
// Only test files changed since `commit`: what the browser saw and the reviewer read is still the code.
// Lets test review commit tests while verify and the second review run on the same code.
export function testsOnlySince(root, commit) {
  const d = changedSince(root, commit)
  return Boolean(d) && d.files.every(isTestFile)
}
// Uncommitted changes outside test files (a test-review worker may be writing tests meanwhile).
export function dirtyCode(root) {
  return dirty(root).split('\n').filter(Boolean).map(l => l.slice(3).split(' -> ').pop().replace(/^"|"$/g, ''))
    .filter(f => !isTestFile(f)).join('\n')
}

// prior: what the last attempt's browser accepted ({ checks_revision, environment, results }).
// delta: files changed since then. tasks: [{ files, steps }] — which Test Steps each file serves.
export function verifyCarry({ checks = [], checksRevision = 0, environment = null, prior = null, delta = null, tasks = [], attempt = null }) {
  const all = checks.map(c => c.id)
  const none = why => ({ carry: [], rerun: all, why })
  if (!prior?.results?.length) return none('no earlier passes to keep')
  if (!Array.isArray(delta)) return none('the code the earlier passes covered cannot be compared with HEAD')
  if (prior.checks_revision !== checksRevision) return none('the check list changed')
  if (!sameEnvironment(prior.environment, environment)) return none('the browser tests another environment')
  // Task-to-step mappings say what a change was meant to touch, not what it can break: a
  // shared file reaches every journey that renders it. Any change to application code
  // reruns the whole approved list; only a delta of test files keeps earlier passes.
  // ponytail: no dependency analysis; add a validated per-repo rule before carrying across code changes.
  const code = delta.filter(f => !isTestFile(f))
  if (code.length) return none(`application code changed (${code.slice(0, 3).join(', ')}${code.length > 3 ? ', …' : ''}); every approved check runs again`)
  const passed = new Set(prior.results.map(r => r.id))
  const carry = checks.filter(c => passed.has(c.id)).map(c => c.id)
  return { carry, rerun: all.filter(id => !carry.includes(id)), why: 'only tests changed' }
}

// prior: the last attempt's recorded review ({ commit }). delta: { files, lines, commits } since it;
// branchLines: lines changed on the whole branch. Findings sent back since then name the files a fix may touch.
export function reviewScope({ prior = null, delta = null, branchLines = 0, findings = [] }) {
  const full = why => ({ scope: 'full', why })
  if (!prior?.commit) return full('first review of this story')
  if (!delta) return full('the reviewed commit cannot be compared with HEAD')
  if (delta.files.length && delta.files.every(isTestFile))
    return { scope: 'delta', since: prior.commit, confirm: [], why: 'only tests changed since the last review; review the new tests as code' }
  const sent = findings.filter(f => f.verdict === 'fix_requested' ||
    (f.verdict === 'fixed' && delta.commits.some(c => f.commit && c.startsWith(String(f.commit)))))
  if (!sent.length) return full('no finding was sent back to build since the last review')
  const named = new Set(sent.map(f => String(f.file ?? '').replace(/:\d.*$/, '')).filter(Boolean))
  const outside = delta.files.filter(f => !isTestFile(f) && !named.has(f))
  if (outside.length) return full(`the fix touched code no finding named: ${outside.join(', ')}`)
  if (delta.lines * 4 > branchLines) return full(`the fix (${delta.lines} lines) is more than a quarter of the branch (${branchLines} lines)`)
  return { scope: 'delta', since: prior.commit, confirm: sent.map(f => f.id),
    why: `the fix stays in the files of ${sent.map(f => f.id).join(', ')} and is ${delta.lines} of ${branchLines} lines` }
}

// What changed between an earlier commit and HEAD; null when that commit is not in this history.
export function changedSince(root, commit) {
  if (!commit) return null
  const git = gitIn(root)
  try {
    const numstat = git('diff', '--numstat', '--no-renames', `${commit}`, 'HEAD')
    const rows = numstat ? numstat.split('\n').map(l => l.split('\t')) : []
    return {
      files: rows.map(r => r[2]),
      lines: rows.reduce((n, [a, d]) => n + (Number(a) || 0) + (Number(d) || 0), 0),
      commits: (git('rev-list', `${commit}..HEAD`) || '').split('\n').filter(Boolean),
    }
  } catch { return null }
}

// The Figma frame a design link points at: figma.com/design|file/<key>/…?node-id=1-2 → { key, node: '1:2' }.
export function figmaRef(url) {
  const u = urlOf(url)
  const key = u && /(^|\.)figma\.com$/.test(u.hostname) && u.pathname.match(/^\/(?:design|file)\/([A-Za-z0-9]+)/)?.[1]
  const node = u?.searchParams.get('node-id')?.replace('-', ':')
  return key && node && /^\d+:\d+$/.test(node) ? { key, node } : null
}
// What a result names as the Figma frame it was compared with.
export const designReference = d => { const f = figmaRef(d.url); return `figma:${f.key}:${f.node}` }

export function checksProblem(checks) {
  if (!Array.isArray(checks)) return 'checks must be a JSON array'
  const seen = new Set()
  for (const c of checks) {
    if (typeof c?.id !== 'string' || !c.id.trim()) return 'every check needs an id'
    if (seen.has(c.id)) return `check id "${c.id}" is used twice`
    if (!Number.isInteger(c.step)) return `check "${c.id}" needs the number of its Test Step (step)`
    if (c.design !== undefined) {
      const d = c.design
      if (d?.kind === 'figma') { if (!figmaRef(d.url)) return `check "${c.id}": a figma design is the link to one frame (figma.com/design/<file>/…?node-id=<frame>)` }
      else if (d?.kind === 'prototype') { if (!urlOf(d.url)) return `check "${c.id}": a prototype design needs the URL the browser opens` }
      else return `check "${c.id}": design is {"kind":"figma"|"prototype","url":…}`
    }
    seen.add(c.id)
  }
  return null
}

// A check with a design passes only when the browser compared the page with it and found no
// deviation, or the human accepted the deviation. The comparison is the verifier's judgment;
// the script checks that it names this check's design and, for a prototype, kept its capture.
// ponytail: a Figma frame is read through the Figma MCP, so no file proves the fetch; the reference id is the verifier's word.
function designProblem(r, check) {
  const d = check.design
  if (!d) return null
  const got = r.design
  if (!got || typeof got !== 'object') return `check "${r.id}" has a design and reports no comparison with it (design)`
  if (d.kind === 'figma' && got.reference !== designReference(d))
    return `check "${r.id}" must compare with Figma frame ${designReference(d)}, not "${got.reference ?? '(none)'}"`
  if (d.kind === 'prototype' && !(r.evidence ?? []).includes(got.reference))
    return `check "${r.id}": the prototype capture (design.reference) must be one of its screenshots (evidence)`
  if (got.verdict === 'match') return null
  if (got.verdict === 'deviates')
    return /^human:/i.test(String(got.accepted ?? '')) ? null : `check "${r.id}" deviates from the design: ${got.note ?? '(no note)'}`
  return `check "${r.id}": design.verdict is "match" or "deviates"`
}

const SEVERITY = ['blocker', 'major', 'minor', 'nit', 'question']
const VERDICTS = ['open', 'fix_requested', 'fixed', 'rejected', 'parked']
export function findingsProblem(findings) {
  for (const f of findings) {
    const name = `finding ${f.id ?? '(no id)'}`
    if (!f.id) return `${name} needs an id`
    if (!SEVERITY.includes(f.severity)) return `${name} needs a severity (${SEVERITY.join(' | ')})`
    if (!VERDICTS.includes(f.verdict)) return `${name} has verdict "${f.verdict}" (${VERDICTS.join(' | ')})`
    if (f.verdict === 'open' || f.verdict === 'fix_requested') return `${name} is ${f.verdict}; settle it first`
    if (f.verdict === 'fixed' && !f.commit) return `${name} is fixed but names no commit that fixed it`
    if (['rejected', 'parked'].includes(f.verdict) && !f.note) return `${name} is ${f.verdict} without a reason (note)`
    if (f.verdict === 'parked' && f.severity === 'blocker') return `${name} is a blocker; a blocker is fixed or rejected with a reason, never parked`
  }
  return null
}

// Every Copilot comment that was fetched must have become a finding. A fetched
// empty list is an answer; no fetch at all is not.
export function commentsProblem(run) {
  if (run.stages?.copilot_review?.status === 'skipped') return null
  const review = run.copilot?.review
  const fetched = run.copilot?.comments
  if (!review || fetched?.review !== review.id) return 'the Copilot review\'s comments were not fetched yet (github.mjs comments)'
  const mapped = new Set((run.findings ?? []).filter(f => f.source === 'copilot').map(f => String(f.comment)))
  const missing = fetched.ids.filter(id => !mapped.has(String(id)))
  return missing.length ? `${missing.length} of ${fetched.ids.length} Copilot comments have no finding (comment ids: ${missing.join(', ')}); record each with "source":"copilot","comment":<id>` : null
}

// Mutation results count when every changed source file was mutated and every
// mutant that did not die has a recorded reason.
const UNRESOLVED = ['survived', 'timeout', 'skipped', 'unverified']
export function mutantsProblem(m) {
  const outcomes = Object.entries(m.outcomes ?? {})
  const reasons = m.dispositions ?? {}
  const fileOf = id => id.split(':').slice(0, -2).join(':')
  const uncovered = (m.scope ?? []).filter(f => !(m.covered ?? []).includes(f) && !reasons[f])
  if (uncovered.length) return `changed source files were not mutated: ${uncovered.join(', ')}; run mutate.mjs on them, or record why not: loop.mjs mutant accept <file> "<reason>"`
  const unclear = outcomes.filter(([, o]) => o === 'infra' || o === 'inconclusive').length
  if (unclear) return `${unclear} mutant runs were inconclusive (infrastructure or a signal); fix the cause and run mutate.mjs again`
  if (!outcomes.some(([, o]) => o === 'killed' || o === 'survived')) return 'no valid mutant ran, so the results say nothing about the tests; with nothing to mutate, skip test_review with the reason'
  const open = outcomes.filter(([id, o]) => UNRESOLVED.includes(o) && !reasons[id] && !(o === 'skipped' && reasons[fileOf(id)])).map(([id, o]) => `${id} (${o})`)
  return open.length ? `${open.length} mutants need a decision: ${open.slice(0, 5).join(', ')}${open.length > 5 ? ', …' : ''}. Kill each with a test and run mutate.mjs again, or record why it stands: loop.mjs mutant accept <id> "<reason>"` : null
}

// How much planning and how large a diff the story was signed off for.
//   {"lane":"standard","why":"…","hard":["new column on users"],"flag":"reading_list_v2"}
// `hard` names the decisions that are costly to change later (schema, public API,
// data migration); `flag` is the feature flag the change ships behind, or false.
export function laneProblem(lane) {
  const names = Object.keys(GRAPH.lanes)
  if (!lane || typeof lane !== 'object' || Array.isArray(lane)) return `lane is a JSON object: {"lane":"${names.join('|')}","why":…,"hard":[…],"flag":"<name>"|false}`
  if (!names.includes(lane.lane)) return `lane is one of: ${names.join(', ')}`
  if (typeof lane.why !== 'string' || !lane.why.trim()) return 'lane needs why: how likely this is to change later, and how costly that would be'
  if (!Array.isArray(lane.hard) || lane.hard.some(h => typeof h !== 'string' || !h.trim())) return 'lane needs "hard": the decisions that are costly to change later (schema, API, migration), or [] when there are none'
  if (lane.flag !== false && (typeof lane.flag !== 'string' || !lane.flag.trim())) return 'lane needs "flag": the feature flag this ships behind, or false when the human decided on none'
  return null
}

// The quality gate's results count when lint ran clean on this code and every
// slop signal in the diff was removed or stands with a recorded reason.
export function qualityProblem(q) {
  const lint = q.lint ?? []
  if (!lint.length && !q.no_lint) return 'no lint command ran on the changed files; run quality.mjs with --lint \'<command>\', or --no-lint "<why this repo has none>"'
  const failed = lint.filter(l => l.exit !== 0)
  if (failed.length) return `lint failed: ${failed.map(l => l.command).join('; ')}. Fix the offenses (not the rule) and run quality.mjs again`
  const open = Object.entries(q.flags ?? {}).filter(([id]) => !q.dispositions?.[id]).map(([id, f]) => `${id} (${f.kind})`)
  return open.length ? `${open.length} slop signals need a decision: ${open.slice(0, 5).join(', ')}${open.length > 5 ? ', …' : ''}. Remove each and run quality.mjs again, or record why it stands: loop.mjs quality accept <id> "<reason>"` : null
}

// Every comment a human reviewer left must have become a finding, and the round
// ends when a human merged or closed the PR.
export function humanReviewProblem(run) {
  const fetched = run.human_review?.comments
  if (!fetched) return 'the human reviewers\' comments were not fetched yet (github.mjs human-comments)'
  const mine = (run.findings ?? []).filter(f => f.source === 'human-review')
  const mapped = new Set(mine.map(f => String(f.comment)))
  const missing = fetched.ids.filter(id => !mapped.has(String(id)))
  if (missing.length) return `${missing.length} of ${fetched.ids.length} reviewer comments have no finding (ids: ${missing.join(', ')}); record each with "source":"human-review","comment":"<id>"`
  return findingsProblem(mine) ?? (['MERGED', 'CLOSED'].includes(fetched.pr_state) ? null
    : `PR ${run.pr} was ${String(fetched.pr_state ?? 'open').toLowerCase()} when the comments were last fetched; the review round ends when a human merges or closes it. Wait (loop.mjs wait human_review human "<what is open>") and fetch again after`)
}

// What a correction can become, from the most to the least reliable.
export const CHECK_KINDS = ['lint', 'type', 'test', 'api', 'review', 'feature-map', 'prose', 'none']
// Every correction of this run (a finding that was fixed, a stage that sent work
// back) is named by a lesson, and each lesson says which check would catch its
// kind next time, or why none can.
export function lessonsProblem(run) {
  const lessons = run.lessons
  if (!Array.isArray(lessons)) return 'record what this run taught: loop.mjs put lessons \'[{"id":"l1","pattern":"<slug>","from":["r1","back:1"],"check":"lint","proposal":"…"}]\' (\'[]\' when nothing was corrected)'
  for (const l of lessons) {
    const name = `lesson ${l?.id ?? '(no id)'}`
    if (!l?.id) return `${name} needs an id`
    if (!/^[a-z0-9][a-z0-9-]*$/.test(String(l.pattern ?? ''))) return `${name} needs a pattern: a short lowercase slug naming the kind of mistake, reused when it happens again (missing-empty-state)`
    if (!Array.isArray(l.from) || !l.from.length) return `${name} needs "from": the finding ids and "back:<n>" rounds it was learned from`
    if (!CHECK_KINDS.includes(l.check)) return `${name} needs a check (${CHECK_KINDS.join(' | ')})`
    if (l.check === 'none' ? !l.note : !l.proposal) return l.check === 'none' ? `${name} says no check can catch this; say why (note)` : `${name} names a ${l.check} check; say what it would be (proposal)`
  }
  const named = new Set(lessons.flatMap(l => l.from.map(String)))
  const corrections = [...(run.findings ?? []).filter(f => f.verdict === 'fixed').map(f => String(f.id)), ...(run.history ?? []).map((_, i) => `back:${i + 1}`)]
  const missing = corrections.filter(c => !named.has(c))
  return missing.length ? `${missing.length} corrections have no lesson: ${missing.join(', ')}; each fixed finding and each round sent back is named in a lesson's "from"` : null
}

// Why `stage` may not pass yet, or null. The CLI asks this before every pass.
export function passProblem(root, run, stage) {
  const tree = headTree(root)
  const head = headCommit(root)
  const stale = () => {
    const list = staleStages(root, run, tree)
    return list.length ? `${list.join(', ')} covered older code or other inputs than now (${list.map(id => `${id}: ${evidenceStale(root, run, id, tree)}`).join('; ')}); go back to build so they run on this code` : null
  }
  switch (stage) {
    case 'contract': {
      const missing = ['title', 'branch', 'pr', 'base'].filter(k => !run[k])
      if (missing.length) return `record ${missing.join(', ')} first (loop.mjs put …)`
      if (!Array.isArray(run.checks)) return 'record the approved check list (loop.mjs checks set …)'
      if (laneProblem(run.lane)) return `record the lane the human signed off (loop.mjs put lane …): ${laneProblem(run.lane)}`
      let branch = ''
      try { branch = gitIn(root)('rev-parse', '--abbrev-ref', 'HEAD') } catch {}
      return branch === run.branch ? null : `the checkout is on "${branch}", not the story branch "${run.branch}"`
    }
    case 'build': {
      if (!run.tasks?.length) return 'no tasks recorded'
      const open = run.tasks.filter(t => t.status !== 'accepted')
      if (open.length) return `tasks not accepted yet: ${open.map(t => t.title ?? t.id).join(', ')}`
      return dirty(root) ? 'the checkout has uncommitted changes; commit the integrated work first' : null
    }
    case 'quality': {
      const q = run.evidence?.quality
      if (!q) return 'no quality results for this attempt (run quality.mjs)'
      if (q.tree !== tree) return 'the quality results cover older code; run quality.mjs again'
      return qualityProblem(q) ?? (dirty(root) ? 'commit first; the gate covers committed code' : null)
    }
    case 'test_review': {
      const m = run.evidence?.mutants
      if (!m) return 'no mutation results for this attempt (run mutate.mjs)'
      if (m.tree !== tree) return 'the mutation results cover older code; run mutate.mjs again'
      // Results under one lane's budget say nothing about a lane signed off later.
      const lane = run.lane?.lane ?? 'standard'
      if (m.lane && m.lane !== lane) return `the mutants ran under the ${m.lane} lane, the story is now ${lane}; run mutate.mjs again`
      // Tests added for surviving mutants are code the quality gate has not seen: check them now, not at the push.
      if (run.stages.quality?.status === 'passed' && run.stages.quality.tree !== tree)
        return 'test review changed the code after the quality gate; run quality.mjs again on it (a clean run brings the gate up to date)'
      const sibling = groupOf('test_review').find(id => id !== 'test_review' && evidenceStale(root, run, id, tree))
      if (sibling) return `${sibling} passed on code test review changed since (${evidenceStale(root, run, sibling, tree)}); run it again on this code: loop.mjs reopen ${sibling} "<why>"`
      return mutantsProblem(m) ?? (dirty(root) ? 'commit the test changes first' : null)
    }
    case 'verify': {
      const request = run.stages.verify.request
      if (request && request.tree !== tree && !testsOnlySince(root, request.commit)) return 'the code changed since verify started; run loop.mjs start verify again so the browser tests this code'
      if (dirtyCode(root)) return 'the checkout has uncommitted changes outside tests; the browser must have tested committed code'
      const envNow = run.environment ? verifyRequest(run, tree, head) : null
      const moved = request && envNow && request.checks_revision === (run.checks_revision ?? 0) &&
        (request.env_tag !== undefined ? request.env_tag !== envNow.env_tag : envNow.id !== request.id)
      if (moved) return 'the environment changed since verify started; run loop.mjs start verify again so the results name where they ran'
      return verifyProblem(root, run) ??
        (run.browser ? null : 'record the browser that was used (loop.mjs put browser chrome|browseros|playwright)')
    }
    case 'second_review': {
      const review = run.review
      const request = run.stages.second_review.request
      const usage = 'loop.mjs review codex|claude|<name> <file with the reviewer\'s output> --request <id>'
      if (!request) return 'second_review was not started on this attempt; loop.mjs start second_review prints the request id the review is recorded under'
      if (request.tree !== tree) return 'the code changed since this review was requested (tests are code too); run loop.mjs start second_review again and review this code'
      if (!review) return `record the review of this code (${usage})`
      if (review.request !== request.id || review.attempt !== (run.stages.second_review.attempt ?? 1) || review.tree !== request.tree)
        return `the recorded review covered older code or an earlier attempt; review this code and record it (${usage})`
      return findingsProblem((run.findings ?? []).filter(f => f.source !== 'copilot')) ?? (dirtyCode(root) ? 'commit first' : null)
    }
    case 'push':
      if (stale()) return stale()
      if (run.pushed?.state !== 'confirmed') return 'nothing published yet (publish.mjs)'
      return run.pushed.sha === head ? null : `the published commit ${run.pushed.sha.slice(0, 7)} is not HEAD ${head?.slice(0, 7)}; publish again`
    case 'copilot_review':
      return run.copilot?.review?.commit && run.copilot.review.commit === run.pushed?.sha ? null
        : 'no Copilot review for the published commit yet (github.mjs copilot-wait)'
    case 'fix_comments':
      return commentsProblem(run) ?? findingsProblem((run.findings ?? []).filter(f => f.source === 'copilot')) ?? stale() ??
        (run.pushed?.sha === head ? null : 'HEAD is not published; a code fix goes back to build')
    case 'report':
      // The last gate looks again at everything, not at the labels earlier stages left.
      if (stale()) return stale()
      if (commentsProblem(run) ?? findingsProblem(run.findings ?? [])) return commentsProblem(run) ?? findingsProblem(run.findings ?? [])
      if (run.pushed?.sha !== head) return 'HEAD is not the published commit'
      if (run.ci?.sha !== head) return 'no required-CI result for HEAD (github.mjs ci)'
      if (!['pass', 'none'].includes(run.ci.state)) return `required CI is ${run.ci.state} on HEAD`
      if (run.ci.state === 'none' && run.ci.required?.length !== 0) return 'no checks reported on HEAD yet and the required checks are unknown; run github.mjs ci again'
      if (run.report?.sha === head && run.report.state !== 'confirmed') return `the report was ${run.report.state}, not confirmed on the PR; run github.mjs report again to reconcile`
      return run.report?.sha === head && run.report.comment_id ? null : 'the report for HEAD is not posted (github.mjs report)'
    case 'human_review':
      return humanReviewProblem(run)
    case 'retro':
      return lessonsProblem(run)
  }
  return null
}

// What a passing stage stamps on itself so later changes can be detected.
export function passStamp(root, stage, run) {
  if (!FRESH.includes(stage)) return {}
  const provenance = stage === 'verify' ? { provenance: run?.stages.verify.request?.environment?.provenance ?? null } : {}
  const lane = stage === 'test_review' ? { lane: run?.evidence?.mutants?.lane ?? run?.lane?.lane ?? null } : {}
  return { tree: headTree(root), commit: headCommit(root), ...provenance, ...lane }
}

// ---- CLI ---------------------------------------------------------------------

function status(run) {
  const cur = current(run)
  const now = active(run)
  const rows = GRAPH.stages.map(({ id, label }) => {
    const s = run.stages[id]
    const extra = [s.rounds ? `round ${s.rounds + 1}` : '', s.waiting_on ? `waiting on ${s.waiting_on}` : '', s.reason ?? '',
      s.status === 'running' && s.request ? `request ${s.request.id}` : '',
      id === 'verify' && (s.provenance ?? s.request?.environment?.provenance) === 'unlinked' ? 'environment NOT linked to this code' : '']
      .filter(Boolean).join(' · ')
    return `${now.includes(id) ? '>' : ' '} ${label.padEnd(15)} ${s.status.padEnd(8)} ${extra}`
  })
  const owner = run.owner?.session ? `owner ${run.owner.session}` : 'no owner yet'
  // Helpers still at work for this run: a new owner should know before starting the same thing again.
  const ops = Object.entries(run.ops ?? {}).map(([op, o]) => `outstanding: ${o.kind} ${op} for ${o.stage} attempt ${o.attempt}, started ${o.started_at} (${alive(o.pid) ? `pid ${o.pid}, still running` : 'its process is gone'})`)
  return [`story-loop ${run.story}${run.branch ? ` · ${run.branch}` : ''}${run.pr ? ` · PR ${run.pr}` : ''} · ${owner}${run.diagnostics?.enabled ? ' · diagnostics on' : ''}`, ...rows, ...ops,
    cur ? `next: ${now.join(' + ')}${now.length > 1 ? ' (side by side)' : ''}` : 'all stages done'].join('\n')
}

export function repoRoot() {
  try { return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch { return process.cwd() }
}

// Recording on or off for the active run; the run state carries the switch so hooks and helpers find it.
function setDiagnostics(root, enabled) {
  return update(root, r => {
    if (Boolean(r.diagnostics?.enabled) === enabled) return undefined
    return { ...r, diagnostics: toggle(root, r, enabled) }
  })
}

// ---- parallel runs ----------------------------------------------------------------
// One checkout holds one run. A second story runs in its own worktree beside the
// checkout (<repo>-story-loop/<story>), with the untracked files the repo's .devloops
// lists (worktree.entries: copy or link) and its own ports, recorded in
// .start-story/ports.json for the board and the browser check.

// worktree.entries from the repo's .devloops; node_modules linked when there is none.
// ponytail: reads that one YAML block by pattern; a YAML parser if the file grows more shapes.
export function worktreeEntries(root) {
  let text = ''
  try { text = readFileSync(join(root, '.devloops'), 'utf8') } catch { return [{ path: 'node_modules', mode: 'link' }] }
  const block = text.match(/^worktree:[^\n]*\n((?:[ \t]+[^\n]*\n?|\n)*)/m)?.[1] ?? ''
  const entries = [...block.matchAll(/-\s*path:\s*(\S+)\s*\n\s+mode:\s*(copy|link)\b/g)].map(([, path, mode]) => ({ path, mode }))
  return entries.length ? entries : [{ path: 'node_modules', mode: 'link' }]
}

// Ports for the n-th parallel run: the board and the app each get their own.
export const portsFor = n => ({ board: 4317 + n, app: 3000 + n })

// Why Rails specs of two runs would collide: one test database for every checkout.
export function sharedTestDatabase(root) {
  let yml
  try { yml = readFileSync(join(root, 'config', 'database.yml'), 'utf8') } catch { return null }
  const test = yml.match(/^test:[^\n]*\n((?:[ \t]+[^\n]*\n?)*)/m)?.[1] ?? ''
  return /TEST_ENV_NUMBER/.test(test) ? null
    : 'config/database.yml names one test database for every checkout: two runs must not run Rails specs or Rails mutants at the same time (name it after TEST_ENV_NUMBER to separate them)'
}

export function parallelWorktree(root, input, { fetch = true } = {}) {
  const story = storyId(input) ?? fail('usage: loop.mjs worktree SC-12345 | gh-123 | <story or issue URL>')
  const git = gitIn(root)
  const home = join(dirname(root), `${basename(root)}-story-loop`)
  const dir = join(home, story)
  if (existsSync(dir)) {
    existsSync(join(dir, '.git')) || fail(`${dir} exists and is not a worktree; move it away first`)
    let ports = null
    try { ports = JSON.parse(readFileSync(join(dir, '.start-story', 'ports.json'), 'utf8')) } catch {}
    return { story, dir, existing: true, ports, linked: [], missing: [], warning: sharedTestDatabase(root) }
  }
  if (fetch) try { git('fetch', '--quiet', 'origin') } catch { /* offline: the last fetched base will do */ }
  let base = 'HEAD'
  try { base = git('symbolic-ref', '--short', 'refs/remotes/origin/HEAD').trim() } catch { try { git('rev-parse', '--verify', '--quiet', 'origin/main'); base = 'origin/main' } catch {} }
  mkdirSync(home, { recursive: true })
  // Ports are leased to the worktree, not counted from the folder: a removed worktree frees
  // its own number and never makes a new story take a live neighbour's.
  const n = acquire(root, 'ports', { path: dir })
  git('worktree', 'add', '--detach', '--quiet', dir, base)
  const linked = [], missing = []
  for (const { path, mode } of worktreeEntries(root)) {
    const from = join(root, path), to = join(dir, path)
    if (!existsSync(from)) { missing.push(path); continue }
    if (existsSync(to)) continue
    mkdirSync(dirname(to), { recursive: true })
    mode === 'copy' ? cpSync(from, to, { recursive: true }) : symlinkSync(from, to)
    linked.push(`${path} (${mode})`)
  }
  const ports = portsFor(n)
  mkdirSync(join(dir, '.start-story'), { recursive: true })
  writeFileSync(join(dir, '.start-story', 'ports.json'), JSON.stringify(ports, null, 2) + '\n')
  return { story, dir, base, existing: false, ports, linked, missing, warning: sharedTestDatabase(root) }
}

function init(input, diagnostics = false) {
  const story = storyId(input) ?? fail('usage: loop.mjs init SC-12345 | gh-123 | <story or issue URL> [--diagnostics]')
  const root = repoRoot()
  let origin = null
  try { origin = remoteRepo(gitIn(root)('remote', 'get-url', 'origin')) } catch {}
  const repo = issueRepo(input)
  repo && origin && repo !== origin && fail(`that issue belongs to ${repo}, but this checkout's origin is ${origin}; run from a checkout of ${repo}`)
  const p = paths(root)
  mkdirSync(p.dir, { recursive: true })
  // Check, archive and create are one step under the lock: two inits never replace each other's run.
  console.log(status(withLock(root, () => {
    if (existsSync(p.active)) {
      const old = load(root)
      old.story === story || current(old) === null || fail(`another run is active here (${old.story}); run this story beside it with: loop.mjs worktree ${story}, or finish that one first (loop.mjs end)`)
      if (old.story === story) {
        if (!diagnostics || old.diagnostics?.enabled) return old
        const next = { ...old, diagnostics: toggle(root, old, true), revision: (old.revision ?? 0) + 1 }
        save(root, next)
        return next
      }
      if (existsSync(legacyInbox(root))) writeInbox(root, old, readInbox(root, old))
      archive(root, old)
    }
    // A shared inbox from before 0.7 belongs to an old story, never to this one.
    if (existsSync(legacyInbox(root))) renameSync(legacyInbox(root), `${legacyInbox(root)}.old-${Date.now()}`)
    writeFileSync(p.events, '')
    const run = { ...newRun(story), source: String(input), repo: repo ?? origin }
    if (diagnostics) run.diagnostics = toggle(root, run, true)
    save(root, run)
    emit(root, { kind: 'stage', text: `run started for ${story}` })
    record(root, 'run.start', { source: String(input), repo: run.repo, schema: SCHEMA, lease_minutes: LEASE_MS / 60_000, max_rounds: GRAPH.maxRounds, models: GRAPH.models })
    return run
  })))
}

// An ended run is kept next to its evidence, never deleted. Helpers still working
// for it are asked to stop; a result that arrives anyway is refused as stale.
function archive(root, run, { ledger = true } = {}) {
  const cancelled = cancelOps(run)
  // Every run leaves its line in the ledger, also one that was dropped half way. A ledger that cannot be written never keeps a run from ending.
  if (ledger) try { appendLedger(root, run, { ended: true }) } catch { /* the run's own record is still kept below */ }
  record(root, 'run.end', { cancelled, stage: current(run) })
  mkdirSync(runDir(root, run), { recursive: true })
  renameSync(paths(root).active, join(runDir(root, run), `run-${Date.now()}.json`))
}

// Moves browser results aside so they never count again.
function archiveAttempt(root, run, name) {
  let dir = join(runDir(root, run), 'attempts', String(name))
  if (existsSync(dir)) dir += `-${Date.now()}`
  for (const from of [resultsFile(root, run), evidenceDir(root, run)]) {
    if (!existsSync(from)) continue
    mkdirSync(dir, { recursive: true })
    renameSync(from, join(dir, from.split(sep).pop()))
  }
  return dir
}

// The passes the browser gave this attempt, kept for the next one to carry over
// where no changed code serves their step. Null when nothing passed here.
function verifyPrior(root, run) {
  const request = run.stages.verify.request
  const report = request ? verifyReport(root, run) : null
  const ok = new Set((report?.rows ?? []).filter(r => r.accepted).map(r => r.id))
  if (!ok.size || !request.commit) return null
  const results = readResults(root, run).filter(r => ok.has(r.id))
  return { request: request.id, commit: request.commit, checks_revision: request.checks_revision, environment: request.environment?.url, results }
}

// Puts the carried-over passes into this attempt's results, screenshots copied in;
// a pass whose screenshot is gone is run again instead.
function carryOver(root, run, request, prior, ids) {
  const kept = []
  const dest = evidenceDir(root, run)
  for (const r of prior.results.filter(x => ids.includes(x.id))) {
    const files = (r.evidence ?? []).map(f => [join(prior.dir, 'evidence', String(f)), join(dest, String(f))])
    if (!files.length || !files.every(([from]) => existsSync(from))) continue
    mkdirSync(dest, { recursive: true })
    for (const [from, to] of files) copyFileSync(from, to)
    kept.push({ ...r, carried: { from: prior.request, commit: prior.commit } })
  }
  mkdirSync(dirname(resultsFile(root, run)), { recursive: true })
  writeFileSync(resultsFile(root, run), JSON.stringify({ request: request.id, results: kept }, null, 2))
  return kept.map(r => r.id)
}

// Puts the last good copy back in place of a file that is not what `problem`
// accepts (cut off, or valid JSON of the wrong shape); the broken one is kept.
// A backup is restored only when it is itself valid.
function restore(file, prev, problem, what) {
  try { readValid(file, problem); return null } catch (error) { if (error.code === 'ENOENT') return null }
  try { readValid(prev, problem) } catch (error) {
    fail(`${what}: ${file} is unreadable and there is no valid backup at ${prev} (${error.code === 'ENOENT' ? 'none was kept' : error.message}). Nothing was changed; the broken file is still there`)
  }
  const kept = `${file}.broken-${Date.now()}`
  renameSync(file, kept)
  copyFileSync(prev, file)
  return kept
}
function recover(root) {
  const p = paths(root)
  withLock(root, () => {
    const state = restore(p.active, p.prev, data => runProblem(migrate(data)), 'the run state')
    const inbox = inboxFile(root, load(root))
    const notes = restore(inbox, `${inbox}.prev`, notesProblem, 'the notes')
    if (!state && !notes) return console.log('the run state and the notes are readable; nothing to recover')
    record(root, 'recover', { state: Boolean(state), notes: Boolean(notes) })
    emit(root, { kind: 'note', text: `${[state && 'run state', notes && 'notes'].filter(Boolean).join(' and ')} restored from the last good copy` })
    for (const kept of [state, notes].filter(Boolean)) console.log(`restored the last good copy; the broken file is kept at ${kept}`)
    if (notes) console.log('a note typed after that copy was made is only in the broken file; read it there')
  })
}

// `diagnostics export` works for any run that recorded, the active one or one that ended long ago.
function exportDiagnostics(args) {
  const opt = name => { const i = args.indexOf(`--${name}`); return i < 0 ? undefined : args[i + 1] }
  const root = findRoot() ?? repoRoot()
  let id = opt('run')
  if (!id) { try { id = runKey(load(root)) } catch { fail('no active run here; name the run: loop.mjs diagnostics export --run <run id> (the ids are the folder names under .start-story/<story>/diagnostics/)') } }
  const out = exportBundle(root, id, { screenshots: args.includes('--screenshots'), out: opt('out') && resolve(opt('out')) })
  console.log(`diagnostics of run ${id} exported to ${out.dest}`)
  console.log(`${out.events} events, ${out.artifacts} files copied, ${out.omitted} listed but not copied${out.complete ? '' : '; the recording is INCOMPLETE, see "Recording limitations" in summary.md'}`)
  console.log('Nothing was uploaded. Read summary.md first; it ends with the prompt for the agent that analyses the bundle.')
}

function diagnostics(root, run, [sub, ...rest]) {
  if (sub === 'on' || sub === 'off') {
    const next = setDiagnostics(root, sub === 'on')
    if (sub === 'on') record(root, 'diagnostics.on', { stage: current(next) })
    return console.log(`diagnostics ${sub} for run ${runKey(next)}${sub === 'on' ? `; events go to ${diagDir(root, next.story, runKey(next))}` : '; what was recorded so far is kept'}`)
  }
  // What no script can see (a capability the human confirmed, a setup result): the conductor's own note in the stream.
  if (sub === 'mark') {
    rest.length >= 2 || fail('usage: loop.mjs diagnostics mark <kind> "<what>"')
    return console.log(record(root, `mark.${rest[0]}`, { text: rest.slice(1).join(' '), stage: current(run) }) ? 'recorded' : 'diagnostics are off; nothing recorded')
  }
  if (sub && sub !== 'status') fail('usage: loop.mjs diagnostics status | on | off | mark <kind> "<what>" | export [--run <id>] [--screenshots] [--out <dir>]')
  const dir = diagDir(root, run.story, runKey(run))
  const manifest = readManifest(dir)
  if (!manifest) return console.log(`diagnostics are off for run ${runKey(run)} and nothing was recorded (loop.mjs diagnostics on)`)
  const { events, unreadable } = readEvents(dir)
  console.log(`diagnostics ${run.diagnostics?.enabled ? 'on' : 'off'} for run ${runKey(run)} · ${events.length} events${unreadable ? ` · ${unreadable} unreadable line(s)` : ''}`)
  console.log(`coverage: ${manifest.coverage}`)
  console.log(`stream: ${dir}`)
}

function main(argv) {
  const [verb, ...args] = argv
  if (verb === 'init') return init(args.filter(a => a !== '--diagnostics').join(' '), args.includes('--diagnostics'))
  if (verb === 'diagnostics' && args[0] === 'export') return exportDiagnostics(args.slice(1))
  // A second story beside the active run: its own worktree, files and ports.
  if (verb === 'worktree') {
    const w = parallelWorktree(findRoot() ?? repoRoot(), args.join(' '))
    console.log([
      `${w.existing ? 'Worktree already there' : 'Worktree ready'} for ${w.story}: ${w.dir}${w.base ? ` (from ${w.base})` : ''}`,
      w.linked.length ? `set up: ${w.linked.join(', ')}` : null,
      w.missing.length ? `not found in this checkout, so not set up: ${w.missing.join(', ')}` : null,
      w.ports ? `ports: board ${w.ports.board}, app ${w.ports.app} (in .start-story/ports.json)` : null,
      w.warning ? `careful: ${w.warning}` : null,
      `Next: open a new Claude Code session in that folder, on Opus, and run /story-loop ${w.story} there.`,
    ].filter(Boolean).join('\n'))
    return
  }
  // The ledger outlives every run, so it is read with or without an active one.
  if (verb === 'ledger') {
    const at = findRoot() ?? repoRoot()
    if (args[0] === '--lessons') return console.log(ledgerLessons(readLedger(at)))
    return console.log(`${ledgerSummary(readLedger(at))}\n\n(${ledgerFile(at)})`)
  }
  const root = findRoot() ?? fail('no active story-loop run here (loop.mjs init SC-12345)')
  if (verb === 'recover') return recover(root)
  const run = load(root)
  if (!verb || verb === 'status') return console.log(status(run))
  if (verb === 'json') return console.log(JSON.stringify(run))
  if (verb === 'diagnostics') return diagnostics(root, run, args)
  // The hook does the actual acquire, because only it knows the session id.
  if (verb === 'acquire') return console.log(status(run))
  const started = Date.now()
  // Every command that can change the run leaves one record: what was asked and whether it was accepted or refused, and why.
  try {
    const result = command(root, run, verb, args)
    if (!MOVES.has(verb)) record(root, 'cli', { verb, outcome: 'accepted', args, elapsed_ms: Date.now() - started })
    return result
  } catch (error) {
    record(root, MOVES.has(verb) ? 'transition' : 'cli', { verb, stage: MOVES.has(verb) ? args[0] : undefined, outcome: 'rejected', reason: error.message, args, elapsed_ms: Date.now() - started })
    throw error
  }
}
const MOVES = new Set(['start', 'pass', 'skip', 'block', 'wait', 'back', 'reopen'])

// Verify that already ran or runs on inputs that just changed (check list, environment)
// runs again: reopened while its parallel group is still going, otherwise left for the
// staleness rules to stop publication. Never stays passed on the old inputs.
function reopenVerify(run, reason) {
  const st = run.stages.verify.status
  if (st === 'pending') return run
  return active(run).includes('verify') || groupOf('verify').includes(current(run)) ? move(run, 'reopen', 'verify', null, reason) : run
}

function command(root, run, verb, args) {
  if (verb === 'inbox') {
    const open = readInbox(root, run).filter(n => n.status !== 'done')
    return console.log(open.length ? handover(run, open) : 'no open notes')
  }
  if (verb === 'await-human') {
    const i = args.indexOf('--minutes')
    const minutes = i < 0 ? undefined : Number(args[i + 1])
    minutes === undefined || (Number.isFinite(minutes) && minutes > 0) || fail('--minutes needs a positive number')
    const { outcome, text } = awaitHuman(root, run, { minutes })
    if (outcome === 'answered') return console.log(text)
    if (outcome === 'timeout') { console.log('no answer from the board in time; the stage still waits on the human'); process.exitCode = 3; return }
    return console.log(outcome === 'replaced' ? 'a newer waiter took over; nothing to do' : 'the run ended; nothing to wait for')
  }
  if (verb === 'note') {
    const [sub, id, ...what] = args
    sub === 'done' && id && what.length || fail('usage: loop.mjs note done <id> "<what you did>"')
    return withLock(root, () => {
      const notes = readInbox(root, run)
      notes.some(n => n.id === id) || fail(`no note "${id}"`)
      writeInbox(root, run, notes.map(n => n.id === id ? { ...n, status: 'done', result: what.join(' '), done_at: new Date().toISOString() } : n))
      emit(root, { kind: 'note', text: `note ${id} handled: ${what.join(' ')}` })
      record(root, 'note.done', { note: id })
      console.log(`note ${id} done`)
    })
  }
  if (verb === 'end') {
    const ended = withLock(root, () => { const now = load(root); archive(root, now); return now })
    const left = Object.values(ended.ops ?? {})
    if (left.length) console.log(`${left.length} helper${left.length === 1 ? ' was' : 's were'} still working for it (${left.map(o => o.kind).join(', ')}) and asked to stop; anything one still reports is kept under .start-story/${ended.story}/stale/ and counts for nothing`)
    return console.log(`run ${ended.story} ended; its record is kept in ${runDir(root, ended)}`)
  }
  // The review as an artifact: who reviewed which code under which request, and what they said.
  // The request exists before the reviewer runs (start second_review); an answer is
  // recorded for that request and that code, never stamped with whatever HEAD is later.
  if (verb === 'review') {
    const at = args.indexOf('--request')
    const id = at < 0 ? undefined : args[at + 1]
    const [reviewer, file] = args.filter((_, i) => at < 0 || (i !== at && i !== at + 1))
    const usage = 'loop.mjs review codex|claude|<name> <file with the reviewer\'s output> --request <id from start second_review>'
    reviewer && file || fail(`usage: ${usage}`)
    let output = ''
    try { output = readFileSync(resolve(file), 'utf8') } catch { fail(`cannot read the reviewer's output at ${file}`) }
    output.trim() || fail(`${file} is empty; a review that said nothing still says so`)
    const sha256 = createHash('sha256').update(output).digest('hex')
    const next = update(root, r => {
      active(r).includes('second_review') && r.stages.second_review.status === 'running' || fail('a review is recorded while second_review is running (loop.mjs start second_review)')
      const request = r.stages.second_review.request ?? fail('this attempt has no review request; run loop.mjs start second_review, then start the reviewer')
      id || fail(`name the request this answer is for (it is ${request.id} now): ${usage}`)
      id === request.id || fail(`that answer is for request "${id}"; the review requested now is "${request.id}". An answer to an earlier request is history, not this review: run the reviewer again on this code`)
      dirtyCode(root) && fail('commit first; a review is recorded for committed code')
      request.tree === headTree(root) || fail(`the code changed since request ${request.id} was made (${request.commit?.slice(0, 7)} then, ${headCommit(root)?.slice(0, 7)} now); that answer reviewed the older code. Run loop.mjs start second_review again and review this code`)
      const earlier = (r.reviews ?? []).find(v => v.sha256 === sha256)
      earlier && fail(`this exact answer is already recorded for request ${earlier.request}; reading an old answer again is not a new review`)
      const kept = join(runDir(root, r), 'reviews', `${request.id}.txt`)
      existsSync(kept) && fail(`request ${request.id} already has its answer on record; for another review run loop.mjs start second_review again`)
      mkdirSync(dirname(kept), { recursive: true })
      writeFileSync(kept, output)
      const review = { reviewer, request: request.id, attempt: request.attempt, tree: request.tree, commit: request.commit, sha256, output: kept, at: new Date().toISOString() }
      return { ...r, reviewer, review, reviews: [...(r.reviews ?? []), review] }
    })
    record(root, 'review.recorded', { reviewer, request: next.review.request, tree: next.review.tree, commit: next.review.commit, sha256, stage: 'second_review', attempt: next.review.attempt })
    emit(root, { kind: 'note', text: `review by ${reviewer} recorded for ${next.review.commit?.slice(0, 7)}` })
    return console.log(`review by ${reviewer} recorded for ${next.review.commit?.slice(0, 7)} (request ${next.review.request})`)
  }
  // A mutant that did not die, or a changed file that was not mutated, stands only with a reason.
  if (verb === 'mutant') {
    const [sub, key, ...why] = args
    sub === 'accept' && key && why.length || fail('usage: loop.mjs mutant accept <mutant id | file> "<why it stands>"')
    update(root, r => {
      const m = r.evidence?.mutants ?? fail('no mutation results yet (run mutate.mjs)')
      key in (m.outcomes ?? {}) || (m.scope ?? []).includes(key) || fail(`"${key}" is neither a mutant id nor a changed source file of these results`)
      return { ...r, evidence: { ...r.evidence, mutants: { ...m, dispositions: { ...m.dispositions, [key]: why.join(' ') } } } }
    })
    emit(root, { kind: 'note', text: `mutant ${key} accepted: ${why.join(' ')}` })
    return console.log(`${key} accepted`)
  }
  // A slop signal that stays in the diff stands only with a reason, like a surviving mutant.
  if (verb === 'quality') {
    const [sub, key, ...why] = args
    sub === 'accept' && key && why.length || fail('usage: loop.mjs quality accept <signal id> "<why it stands>"')
    update(root, r => {
      const q = r.evidence?.quality ?? fail('no quality results yet (run quality.mjs)')
      key in (q.flags ?? {}) || fail(`"${key}" is not a signal of these results`)
      // The lane's size was the human's sign-off: going over it is their decision at the human review, listed first in the report.
      return { ...r, evidence: { ...r.evidence, quality: { ...q, dispositions: { ...q.dispositions, [key]: why.join(' ') } } } }
    })
    emit(root, { kind: 'note', text: `quality signal ${key} accepted: ${why.join(' ')}` })
    return console.log(`${key} accepted`)
  }
  if (verb === 'checks') {
    const [sub, raw] = args
    sub === 'set' && raw || fail('usage: loop.mjs checks set \'[{"id":"1-desktop","step":1,"case":"desktop"}, …]\'')
    let checks
    try { checks = JSON.parse(raw) } catch { fail('checks must be JSON') }
    const problem = checksProblem(checks)
    problem && fail(problem)
    const next = update(root, r => {
      const at = ids().indexOf(current(r) ?? ids().at(-1))
      at > ids().indexOf('verify') && fail('verify already passed on the old list; go back to build first')
      const out = { ...r, checks, checks_revision: (r.checks_revision ?? 0) + 1 }
      return reopenVerify(out, 'the approved check list changed')
    })
    emit(root, { kind: 'note', text: `check list set: ${checks.length} check${checks.length === 1 ? '' : 's'} (revision ${next.checks_revision})` })
    return console.log(`${checks.length} checks set`)
  }
  // One finding changed without restating the list: loop.mjs finding <id> <verdict> "<note>" [--commit <sha>] [--severity <s>]
  if (verb === 'finding') {
    const opt = name => { const i = args.indexOf(`--${name}`); return i < 0 ? undefined : args[i + 1] }
    const [id, verdict, ...rest] = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'))
    id && verdict || fail('usage: loop.mjs finding <id> <open|fix_requested|fixed|rejected|parked> "<note>" [--commit <sha>] [--severity <s>]')
    VERDICTS.includes(verdict) || fail(`verdict is one of: ${VERDICTS.join(', ')}`)
    update(root, r => {
      const f = (r.findings ?? []).find(x => x.id === id) ?? fail(`no finding "${id}"; add new ones with loop.mjs put findings`)
      const next = { ...f, verdict, ...(rest.length ? { note: rest.join(' ') } : {}), ...(opt('commit') ? { commit: opt('commit') } : {}), ...(opt('severity') ? { severity: opt('severity') } : {}) }
      return { ...r, findings: r.findings.map(x => x.id === id ? next : x) }
    })
    emit(root, { kind: 'note', text: `finding ${id}: ${verdict}` })
    return console.log(`finding ${id} ${verdict}`)
  }
  if (verb === 'put') {
    const replace = args.includes('--replace')
    const [key, raw] = args.filter(a => a !== '--replace')
    key === 'reviewer' && fail('a review is recorded with its output: loop.mjs review <reviewer> <file>')
    PUT_KEYS.has(key) || fail(`put takes one of: ${[...PUT_KEYS].join(', ')}`)
    let value = raw
    try { value = JSON.parse(raw) } catch { /* a bare string such as a branch name */ }
    if (key === 'environment') { const problem = environmentProblem(value); problem && fail(problem) }
    if (key === 'required_checks') Array.isArray(value) && value.every(n => typeof n === 'string' && n.trim()) || fail('required_checks is a JSON list of check names, e.g. \'["rspec","lint"]\', or \'[]\' for none')
    if (key === 'lane') { const problem = laneProblem(value); problem && fail(problem) }
    if (key === 'lessons') Array.isArray(value) || fail('lessons is a JSON list, \'[]\' when nothing was corrected')
    if (key === 'web_guidance') /^human:\s*\S/i.test(String(value)) || fail('web_guidance is set by the hook when the modern-web-guidance skill runs; put it only on the human\'s word: put web_guidance "human: <why it is not used>"')
    if (key === 'evidence_sharing') ['pr', 'artifact', 'none'].includes(value) || fail('evidence_sharing is pr (screenshots attached to the PR), artifact (a private page linked from the report) or none')
    let dropped = false
    update(root, r => {
      key === 'branch' && r.branch && r.branch !== value && r.pushed &&
        fail(`the story branch is "${r.branch}" and was published; it does not change mid-run`)
      key === 'repo' && r.repo && r.repo !== value && fail(`this run belongs to ${r.repo}; the repository does not change mid-run`)
      if (key === 'tasks' || key === 'findings') {
        Array.isArray(value) || fail(`${key} is a JSON list`)
        const ids = new Set(value.map(x => x?.id))
        const lost = (r[key] ?? []).map(x => x.id).filter(id => !ids.has(id))
        lost.length && !replace && fail(`this list leaves out recorded ${key} (${lost.join(', ')}); give the whole list, change one finding with loop.mjs finding <id> …, or drop them on purpose with --replace`)
      }
      if (key === 'tasks') {
        // The build round a task belongs to: verify reruns only the steps this round's tasks name for the files they changed.
        const had = new Map((r.tasks ?? []).map(t => [t.id, t]))
        value = value.map(t => ({ ...t, attempt: t.attempt ?? had.get(t.id)?.attempt ?? r.stages.build.attempt ?? 1 }))
      }
      let next = { ...r, [key]: value }
      if (key === 'environment' && JSON.stringify(r.environment) !== JSON.stringify(value)) next = reopenVerify(next, 'the environment changed')
      // The human approved a list for one repository and one base branch; it says nothing about another.
      if (key === 'required_checks') {
        r.repo && r.base || fail('record the repository and the base branch first (loop.mjs put base <branch>); the list is approved for that base')
        next.required_checks_for = { repo: r.repo, base: baseName(r.base), at: new Date().toISOString() }
      }
      if ((key === 'base' || key === 'repo') && r[key] && baseName(r[key]) !== baseName(value)) {
        dropped = Array.isArray(r.required_checks)
        delete next.required_checks; delete next.required_checks_for; delete next.ci
      }
      return next
    })
    emit(root, { kind: 'note', text: `${key} updated` })
    if (dropped) console.log(`the required checks the human named were approved for the old ${key}; they are dropped. Ask again for this one: loop.mjs put required_checks '[…]'`)
    return console.log(`${key} set`)
  }
  // wait and back take a second positional (who / target) before the reason.
  const [stage, ...rest] = args
  const arg = verb === 'wait' || verb === 'back' ? rest.shift() : undefined
  const reason = rest.join(' ') || undefined
  MOVES.has(verb) || fail(`unknown verb "${verb}" (start | pass | skip | block | wait | back | reopen)`)
  let before
  const next = update(root, r => {
    before = r.stages[stage]
    if (verb === 'pass') {
      const report = stage === 'verify' ? verifyReport(root, r) : null
      const problem = passProblem(root, r, stage)
      if (report) record(root, 'verify.report', { stage, attempt: r.stages.verify.attempt ?? 1, request: report.request, outcome: problem ? 'rejected' : 'accepted', reason: problem,
        accepted: report.accepted, total: report.total, results_request: report.results_request, provenance: report.provenance, rows: report.rows })
      problem && fail(`${stage} cannot pass: ${problem}`)
    }
    const moved = move(r, verb, stage, arg, reason)
    if (verb === 'start' && stage === 'verify') {
      // The request exists before the browser runs; results are checked against it, never stamped afterwards.
      dirtyCode(root) && fail('verify starts on committed code; the checkout has uncommitted changes outside tests')
      const env = r.environment ?? fail('record where the browser will test, and what ties it to this code, before verify starts: ' +
        'loop.mjs put environment \'{"url":"http://127.0.0.1:3000","kind":"local","server":"<how it was started from this checkout>"}\' ' +
        '(a deployment: "kind":"remote" with "revision":"<the commit it reports>")')
      const head = headCommit(root) ?? fail('not a git checkout')
      // A deployment that reports another commit serves other code: its checks would say nothing about this one.
      env.revision !== undefined && !head.startsWith(String(env.revision).toLowerCase()) &&
        fail(`the environment ${env.url} reports revision ${env.revision}, but the code under review is ${head.slice(0, 12)}; the browser would test other code. Deploy this commit there and record its revision, or use a local server started from this checkout`)
      const request = verifyRequest(r, headTree(root) ?? fail('not a git checkout'), head)
      const prior = r.verify_prior
      const plan = verifyCarry({ checks: r.checks ?? [], checksRevision: r.checks_revision ?? 0, environment: env.url,
        prior, delta: prior ? changedSince(root, prior.commit)?.files ?? null : null, tasks: r.tasks ?? [], attempt: r.stages.build.attempt ?? 1 })
      const same = readResultsFile(root, r)?.request === request.id
      if (!same) archiveAttempt(root, r, `${request.attempt}-superseded`)
      // Restarting under the same request keeps what is in the file; a new request carries over afresh.
      request.carried = same ? (r.stages.verify.request?.carried ?? []) : plan.carry.length ? carryOver(root, r, request, prior, plan.carry) : []
      request.plan = { why: plan.why, rerun: (r.checks ?? []).map(c => c.id).filter(id => !request.carried.includes(id)) }
      moved.stages.verify.request = request
    }
    if (verb === 'start' && stage === 'second_review') {
      // Made before the reviewer is started: the code it is asked to review, under an id no earlier answer can carry.
      dirtyCode(root) && fail('the second review starts on committed code; the checkout has uncommitted changes outside tests')
      const attempt = r.stages.second_review.attempt ?? 1
      const tree = headTree(root) ?? fail('not a git checkout')
      const open = r.stages.second_review.request
      // Starting again on the same code keeps the request, and with it an answer already on record
      // (a resume after a wait reviews nothing new). Changed code gets a new one; added tests do not.
      const keep = open && open.attempt === attempt && open.tree === tree
      if (keep) moved.stages.second_review.request = open
      else {
        // The last recorded review, also of this attempt (tests committed after it get a delta review).
        const prior = (r.reviews ?? []).filter(v => v.attempt <= attempt).at(-1) ?? null
        const git = gitIn(root)
        let branchLines = 0
        try { branchLines = changedSince(root, git('merge-base', diffBase(git, r.base), 'HEAD'))?.lines ?? 0 } catch {}
        const scope = reviewScope({ prior, delta: prior ? changedSince(root, prior.commit) : null, branchLines, findings: r.findings ?? [] })
        moved.stages.second_review.request = { id: `${runKey(r)}-r${attempt}-${randomUUID().slice(0, 8)}`, attempt, tree, commit: headCommit(root), at: new Date().toISOString(), scope }
      }
    }
    if (verb === 'pass') Object.assign(moved.stages[stage], passStamp(root, stage, r))
    if (verb === 'back') {
      // Read what passed before the results are moved aside.
      const prior = verifyPrior(root, r)
      const dir = archiveAttempt(root, r, r.stages.verify.attempt ?? 1)
      if (prior) moved.verify_prior = { ...prior, dir }
    }
    return moved
  })
  const now = next.stages[stage]
  record(root, 'transition', { verb, stage, attempt: before.attempt ?? 1, to: arg, outcome: 'accepted', reason, revision: next.revision,
    request: now.request?.id, tree: headTree(root), commit: headCommit(root), base: next.base ?? null,
    from_status: before.status, to_status: now.status, rounds: now.rounds, waiting_on: now.waiting_on })
  emit(root, { kind: 'stage', stage, verb, to: arg, text: reason })
  // The retro is the run's last word on itself: its ledger line carries the lessons.
  if (verb === 'pass' && stage === 'retro') { try { appendLedger(root, next) } catch (error) { console.error(`loop: the ledger line could not be written (${error.message}); the run is unaffected`) } }
  console.log(status(next))
  // A run whose retro passed is over: archived now, so its guards never hold up the next piece of work.
  if (verb === 'pass' && stage === 'retro') {
    withLock(root, () => { const now = load(root); if (runKey(now) === runKey(next)) archive(root, now, { ledger: false }) })
    return console.log(`run ${next.story} ended; its record is kept in ${runDir(root, next)}`)
  }
  if (verb === 'start' && stage === 'verify') {
    const { id, environment } = next.stages.verify.request
    console.log(`verify request: ${id}  (results.json must carry it as "request")`)
    console.log(`environment: ${environment.url}  (every result names it as "environment"; link to this code: ${environment.provenance})`)
    if (environment.provenance === 'unlinked') console.log('This environment is not tied to the code under review. The checks are not exact-code verification; say so in the report.')
    const { carried = [], plan } = next.stages.verify.request
    if (carried.length) console.log(`carried over from the last attempt: ${carried.join(', ')} (already in results.json; keep those rows)`)
    if (plan && (next.stages.verify.attempt ?? 1) > 1) console.log(`the browser checks: ${plan.rerun.join(', ') || 'nothing'}  (${plan.why})`)
  }
  if (verb === 'start' && stage === 'second_review') {
    const { id, commit, scope } = next.stages.second_review.request
    console.log(`review request: ${id}  for commit ${commit?.slice(0, 12)}  (record the answer with: loop.mjs review <reviewer> <file> --request ${id})`)
    if (scope?.scope === 'delta') console.log(`review scope: delta since ${scope.since.slice(0, 12)}; confirm ${scope.confirm.join(', ')} are closed and look for what the fix broke (${scope.why})`)
    else if (scope) console.log(`review scope: full, blind (${scope.why})`)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)) } catch (error) { console.error(`loop: ${error.message}`); process.exit(1) }
}
