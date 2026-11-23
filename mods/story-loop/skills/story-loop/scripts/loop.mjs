#!/usr/bin/env node
// story-loop state machine. The graph (graph.json) is the only source of which
// moves exist; this script refuses every other move, and a stage passes only
// when its evidence checks out (passProblem). State lives in the target repo
// under .start-story/, which must be gitignored.
import {
  readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, rmSync, renameSync, copyFileSync,
  statSync, realpathSync, openSync, readSync, closeSync,
} from 'node:fs'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const GRAPH = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'graph.json'), 'utf8'))
export const SCHEMA = 2
export const LEASE_MS = 15 * 60_000
const DONE = new Set(['passed', 'skipped'])
const PUT_KEYS = new Set(['title', 'branch', 'pr', 'base', 'repo', 'tasks', 'findings', 'browser', 'required_checks'])
// Which stages may be skipped, and on whose word. Everything else needs only a reason.
const SKIP = {
  contract: 'never', build: 'never', second_review: 'never', push: 'never', report: 'never',
  // With no Copilot comments fix_comments passes on its own; a skip would only hide open ones.
  fix_comments: 'never',
  verify: 'human', copilot_review: 'human',
}
// Stages whose evidence covers one exact code tree; a later change makes it stale.
export const FRESH = ['test_review', 'verify', 'second_review']

// A run starts from a Shortcut story (sc-123) or a GitHub issue (gh-123).
// Accepts SC-123, 123, gh-123, #123, and the URL of either.
export function storyId(input = '') {
  const text = String(input).trim().toLowerCase()
  const issue = text.match(/^(?:gh-|#)(\d+)$/) ?? text.match(/github\.com\/[^/]+\/[^/]+\/issues\/(\d+)/)
  if (issue) return `gh-${issue[1]}`
  const story = text.match(/^(?:sc-)?(\d+)$/) ?? text.match(/shortcut\.com\/[^/]+\/story\/(\d+)/)
  return story ? `sc-${story[1]}` : null
}
// owner/name of a GitHub issue URL or a git remote URL, lowercased; null otherwise.
export const issueRepo = input => String(input).match(/github\.com\/([^/\s]+\/[^/\s]+)\/issues\/\d+/i)?.[1].toLowerCase() ?? null
export const remoteRepo = url => String(url).trim().match(/github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/i)?.[1].toLowerCase() ?? null

export function newRun(story, now = new Date().toISOString()) {
  return {
    schema: SCHEMA, id: randomUUID().slice(0, 8), revision: 0, story, started_at: now, owner: null, stop_blocks: 0,
    stages: Object.fromEntries(GRAPH.stages.map(s => [s.id, { status: 'pending', rounds: 0, attempt: 1 }])),
    tasks: [], findings: [], evidence: {}, checks: null, history: [],
  }
}

// Old (schema 1) runs keep their data, but nothing they recorded counts as
// fresh evidence: no stage carries a code tree, so later gates ask again.
export function migrate(run) {
  if (run.schema === SCHEMA) return run
  const { session, ...rest } = run
  return {
    ...rest, schema: SCHEMA, revision: run.revision ?? 0, migrated_from: run.schema ?? 1,
    owner: session ? { session, since: run.started_at, heartbeat: 0 } : null,
    stages: Object.fromEntries(Object.entries(run.stages).map(([id, s]) => [id, { attempt: 1, ...s }])),
    checks: run.checks ?? null, history: run.history ?? [],
  }
}

const ids = () => GRAPH.stages.map(s => s.id)
const fail = message => { throw new Error(message) }

// The stage the loop must work on next: the first one that is not done.
export function current(run) {
  return ids().find(id => !DONE.has(run.stages[id].status)) ?? null
}

// One move. Returns the new run; throws with the reason when the graph forbids it.
// Evidence gates are separate (passProblem) so this stays pure.
export function move(run, verb, stage, arg, reason, now = new Date().toISOString()) {
  const next = structuredClone(run)
  const st = next.stages[stage] ?? fail(`unknown stage "${stage}" (stages: ${ids().join(', ')})`)
  const cur = current(next)
  const needReason = () => reason || fail(`"${verb}" needs a reason`)
  // A finished run can still be sent back from its last stage (a human note after the report).
  const mustBeCurrent = () => stage === cur || (verb === 'back' && cur === null && stage === ids().at(-1)) ||
    fail(`"${stage}" is not the current stage; current is "${cur}"`)

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
      ;['human', 'copilot'].includes(arg) || fail('wait needs who: human | copilot')
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
        fail(`"${arg}" already went back ${GRAPH.maxRounds} times; record "wait ${stage} human" and show the human`)
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
    default:
      fail(`unknown verb "${verb}" (start | pass | skip | block | wait | back)`)
  }
  next.stop_blocks = 0
  return next
}

// What the Stop hook decides: null lets the session end, a string keeps it going.
export function stopReason(run) {
  const cur = current(run)
  if (!cur) return null
  const st = run.stages[cur]
  if (st.status === 'waiting' || st.status === 'blocked') return null
  return `story-loop ${run.story}: stage "${cur}" is ${st.status}. Carry on with it, or record why it stops: ` +
    `loop.mjs wait ${cur} human "<reason>" | loop.mjs block ${cur} "<reason>".`
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
    if (dir === dirname(dir)) return null
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

export function load(root) {
  const file = paths(root).active
  let text
  try { text = readFileSync(file, 'utf8') } catch (error) { fail(`no run state at ${file} (${error.code})`) }
  try { return migrate(JSON.parse(text)) } catch (error) {
    fail(`the run state ${file} is unreadable (${error.message}); restore the last good copy with: loop.mjs recover`)
  }
}
// Crash-safe: write a temp file, keep the previous good state, then rename over.
export function save(root, run) {
  const p = paths(root)
  const tmp = `${p.active}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(run, null, 2) + '\n')
  try { JSON.parse(readFileSync(p.active, 'utf8')); copyFileSync(p.active, p.prev) } catch { /* no good state to keep */ }
  renameSync(tmp, p.active)
}
export function emit(root, event) {
  appendFileSync(paths(root).events, JSON.stringify({ ts: new Date().toISOString(), ...event }) + '\n')
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

// ---- git -----------------------------------------------------------------------

export const gitIn = root => (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
export function headTree(root) { try { return gitIn(root)('rev-parse', 'HEAD^{tree}') } catch { return null } }
export function headCommit(root) { try { return gitIn(root)('rev-parse', 'HEAD') } catch { return null } }
export function dirty(root) { try { return gitIn(root)('status', '--porcelain') } catch { return 'not a git checkout' } }

// Stages whose evidence covers a different tree than the code now has. A passed
// stage that names no tree (a run from before 0.7) proves nothing about this code.
export function staleStages(root, run, tree = headTree(root)) {
  return FRESH.filter(id => run.stages[id]?.status === 'passed' && run.stages[id].tree !== tree)
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
    return Array.isArray(notes) ? notes : fail('not a list of notes')
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
  try { JSON.parse(readFileSync(file, 'utf8')); copyFileSync(file, `${file}.prev`) } catch { /* no good copy to keep */ }
  renameSync(tmp, file)
}

const KINDS = { note: 'note', wrong: 'this is wrong', change: 'change request', fix: 'fix it after all' }

// The text an agent receives, whether a hook injects it or the human pastes it.
export function handover(run, notes) {
  const head = `Notes from the human, sent from the story-loop board ` +
    `(story ${run.story}${run.pr ? `, PR ${run.pr}` : ''}, current stage: ${current(run) ?? 'all stages done'}).`
  const items = notes.map(n => [
    `[${n.id}] ${KINDS[n.kind] ?? 'note'}${n.file ? ` · ${n.file}` : ''}${n.finding ? ` · finding ${n.finding}` : ''}`,
    `  ${n.text}`,
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
    return id
  })
}

// Hands every note the agent has not received to it. via 'copy' only marks them
// copied (a clipboard is not a receipt) and includes earlier copied ones again.
export function deliver(root, via) {
  return withLock(root, () => {
    const run = load(root)
    const notes = readInbox(root, run)
    const copy = via === 'copied from the board'
    const open = notes.filter(n => n.status === 'queued' || n.status === 'copied')
    if (!open.length) return null
    const status = copy ? 'copied' : 'delivered'
    writeInbox(root, run, notes.map(n => open.includes(n) ? { ...n, status, via } : n))
    emit(root, { kind: 'note', text: `${open.length} note${open.length > 1 ? 's' : ''} ${copy ? 'copied for the agent' : `handed to the agent (${via})`}` })
    return handover(run, open)
  })
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
export function verifyRequest(run, tree) {
  const attempt = run.stages.verify.attempt ?? 1
  const checks_revision = run.checks_revision ?? 0
  return { id: `${run.id ?? run.started_at}-a${attempt}-c${checks_revision}-${String(tree).slice(0, 12)}`, tree, attempt, checks_revision }
}

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
export function verifyProblem(root, run) {
  const checks = run.checks
  if (!Array.isArray(checks)) return 'no approved check list yet (loop.mjs checks set \'[{"id":…,"step":…}]\')'
  if (!checks.length) return 'the approved check list is empty: no user journey, so verify is skipped on the human\'s say-so, not passed'
  const request = run.stages?.verify?.request
  if (!request) return 'verify was not started on this attempt; loop.mjs start verify prints the request id the results must carry'
  if (request.checks_revision !== (run.checks_revision ?? 0)) return 'the check list changed since verify started; run loop.mjs start verify again and verify against the new list'
  const written = readResultsFile(root, run)
  const results = written?.results
  if (!Array.isArray(results) || !results.length) return `0 of ${checks.length} checks reported; the verifier has not written ${resultsFile(root, run)}`
  if (written.request !== request.id)
    return `the results carry request "${written.request ?? 'none'}", not this attempt's "${request.id}"; they belong to another attempt, check list or run`
  const expected = new Set(checks.map(c => c.id))
  const seen = new Set()
  for (const r of results) {
    if (!expected.has(r?.id)) return `result "${r?.id}" is not in the approved check list`
    if (seen.has(r.id)) return `check "${r.id}" is reported twice`
    seen.add(r.id)
  }
  const missing = checks.filter(c => !seen.has(c.id)).map(c => c.id)
  if (missing.length) return `${seen.size} of ${checks.length} checks reported; missing: ${missing.join(', ')}`
  for (const r of results) {
    if (r.verdict !== 'pass') return `check "${r.id}" is "${r.verdict}", not pass`
    if (!Array.isArray(r.evidence) || !r.evidence.length) return `check "${r.id}" has no screenshot`
    for (const file of r.evidence) {
      const problem = imageProblem(evidenceDir(root, run), file)
      if (problem) return `check "${r.id}": ${problem}`
    }
  }
  return null
}

export function checksProblem(checks) {
  if (!Array.isArray(checks)) return 'checks must be a JSON array'
  const seen = new Set()
  for (const c of checks) {
    if (typeof c?.id !== 'string' || !c.id.trim()) return 'every check needs an id'
    if (seen.has(c.id)) return `check id "${c.id}" is used twice`
    if (!Number.isInteger(c.step)) return `check "${c.id}" needs the number of its Test Step (step)`
    seen.add(c.id)
  }
  return null
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

// Why `stage` may not pass yet, or null. The CLI asks this before every pass.
export function passProblem(root, run, stage) {
  const tree = headTree(root)
  const head = headCommit(root)
  const stale = () => {
    const list = staleStages(root, run, tree)
    return list.length ? `${list.join(', ')} covered older code than HEAD; go back to build so they run on this code` : null
  }
  switch (stage) {
    case 'contract': {
      const missing = ['title', 'branch', 'pr', 'base'].filter(k => !run[k])
      if (missing.length) return `record ${missing.join(', ')} first (loop.mjs put …)`
      if (!Array.isArray(run.checks)) return 'record the approved check list (loop.mjs checks set …)'
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
    case 'test_review': {
      const m = run.evidence?.mutants
      if (!m) return 'no mutation results for this attempt (run mutate.mjs)'
      if (m.tree !== tree) return 'the mutation results cover older code; run mutate.mjs again'
      return mutantsProblem(m) ?? (dirty(root) ? 'commit the test changes first' : null)
    }
    case 'verify': {
      const request = run.stages.verify.request
      if (request && request.tree !== tree) return 'the code changed since verify started; run loop.mjs start verify again so the browser tests this code'
      if (dirty(root)) return 'the checkout has uncommitted changes; the browser must have tested committed code'
      return verifyProblem(root, run) ??
        (run.browser ? null : 'record the browser that was used (loop.mjs put browser chrome|browseros|playwright)')
    }
    case 'second_review': {
      const review = run.review
      const usage = 'loop.mjs review codex|claude|<name> <file with the reviewer\'s output>'
      if (!review) return `record the review of this code (${usage})`
      if (review.attempt !== (run.stages.second_review.attempt ?? 1) || review.tree !== tree)
        return `the recorded review covered older code or an earlier attempt; review this code and record it (${usage})`
      return findingsProblem((run.findings ?? []).filter(f => f.source !== 'copilot')) ?? (dirty(root) ? 'commit first' : null)
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
  }
  return null
}

// What a passing stage stamps on itself so later changes can be detected.
export function passStamp(root, stage) {
  if (!FRESH.includes(stage)) return {}
  return { tree: headTree(root), commit: headCommit(root) }
}

// ---- CLI ---------------------------------------------------------------------

function status(run) {
  const cur = current(run)
  const rows = GRAPH.stages.map(({ id, label }) => {
    const s = run.stages[id]
    const extra = [s.rounds ? `round ${s.rounds + 1}` : '', s.waiting_on ? `waiting on ${s.waiting_on}` : '', s.reason ?? '',
      s.status === 'running' && s.request ? `request ${s.request.id}` : '']
      .filter(Boolean).join(' · ')
    return `${id === cur ? '>' : ' '} ${label.padEnd(15)} ${s.status.padEnd(8)} ${extra}`
  })
  const owner = run.owner?.session ? `owner ${run.owner.session}` : 'no owner yet'
  return [`story-loop ${run.story}${run.branch ? ` · ${run.branch}` : ''}${run.pr ? ` · PR ${run.pr}` : ''} · ${owner}`, ...rows,
    cur ? `next: ${cur}` : 'all stages done'].join('\n')
}

function repoRoot() {
  try { return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch { return process.cwd() }
}

function init(input) {
  const story = storyId(input) ?? fail('usage: loop.mjs init SC-12345 | gh-123 | <story or issue URL>')
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
      old.story === story || current(old) === null || fail(`another run is active here (${old.story}); finish it or run: loop.mjs end`)
      if (old.story === story) return old
      if (existsSync(legacyInbox(root))) writeInbox(root, old, readInbox(root, old))
      archive(root, old)
    }
    // A shared inbox from before 0.7 belongs to an old story, never to this one.
    if (existsSync(legacyInbox(root))) renameSync(legacyInbox(root), `${legacyInbox(root)}.old-${Date.now()}`)
    writeFileSync(p.events, '')
    const run = { ...newRun(story), source: String(input), repo: repo ?? origin }
    save(root, run)
    emit(root, { kind: 'stage', text: `run started for ${story}` })
    return run
  })))
}

// An ended run is kept next to its evidence, never deleted.
function archive(root, run) {
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
}

// Puts the last good copy back in place of an unreadable file; the broken one is kept.
function restore(file, prev) {
  try { JSON.parse(readFileSync(file, 'utf8')); return null } catch (error) { if (error.code === 'ENOENT') return null }
  try { JSON.parse(readFileSync(prev, 'utf8')) } catch { fail(`no readable backup at ${prev}; the broken file is still at ${file}`) }
  const kept = `${file}.broken-${Date.now()}`
  renameSync(file, kept)
  copyFileSync(prev, file)
  return kept
}
function recover(root) {
  const p = paths(root)
  withLock(root, () => {
    const state = restore(p.active, p.prev)
    const inbox = inboxFile(root, load(root))
    const notes = restore(inbox, `${inbox}.prev`)
    if (!state && !notes) return console.log('the run state and the notes are readable; nothing to recover')
    emit(root, { kind: 'note', text: `${[state && 'run state', notes && 'notes'].filter(Boolean).join(' and ')} restored from the last good copy` })
    for (const kept of [state, notes].filter(Boolean)) console.log(`restored the last good copy; the broken file is kept at ${kept}`)
    if (notes) console.log('a note typed after that copy was made is only in the broken file; read it there')
  })
}

function main([verb, ...args]) {
  if (verb === 'init') return init(args.join(' '))
  const root = findRoot() ?? fail('no active story-loop run here (loop.mjs init SC-12345)')
  if (verb === 'recover') return recover(root)
  const run = load(root)
  if (!verb || verb === 'status') return console.log(status(run))
  if (verb === 'json') return console.log(JSON.stringify(run))
  // The hook does the actual acquire, because only it knows the session id.
  if (verb === 'acquire') return console.log(status(run))
  if (verb === 'inbox') {
    const open = readInbox(root, run).filter(n => n.status !== 'done')
    return console.log(open.length ? handover(run, open) : 'no open notes')
  }
  if (verb === 'note') {
    const [sub, id, ...what] = args
    sub === 'done' && id && what.length || fail('usage: loop.mjs note done <id> "<what you did>"')
    return withLock(root, () => {
      const notes = readInbox(root, run)
      notes.some(n => n.id === id) || fail(`no note "${id}"`)
      writeInbox(root, run, notes.map(n => n.id === id ? { ...n, status: 'done', result: what.join(' ') } : n))
      emit(root, { kind: 'note', text: `note ${id} handled: ${what.join(' ')}` })
      console.log(`note ${id} done`)
    })
  }
  if (verb === 'end') {
    const ended = withLock(root, () => { const now = load(root); archive(root, now); return now })
    return console.log(`run ${ended.story} ended; its record is kept in ${runDir(root, ended)}`)
  }
  // The review as an artifact: who reviewed which code in which attempt, and what they said.
  if (verb === 'review') {
    const [reviewer, file] = args
    reviewer && file || fail('usage: loop.mjs review codex|claude|<name> <file with the reviewer\'s output>')
    let output = ''
    try { output = readFileSync(resolve(file), 'utf8') } catch { fail(`cannot read the reviewer's output at ${file}`) }
    output.trim() || fail(`${file} is empty; a review that said nothing still says so`)
    const next = update(root, r => {
      current(r) === 'second_review' && r.stages.second_review.status === 'running' || fail('a review is recorded while second_review is running (loop.mjs start second_review)')
      dirty(root) && fail('commit first; a review is recorded for committed code')
      const attempt = r.stages.second_review.attempt ?? 1
      const kept = join(runDir(root, r), `review-${attempt}.txt`)
      mkdirSync(runDir(root, r), { recursive: true })
      writeFileSync(kept, output)
      return { ...r, reviewer, review: { reviewer, attempt, tree: headTree(root), commit: headCommit(root), output: kept, at: new Date().toISOString() } }
    })
    emit(root, { kind: 'note', text: `review by ${reviewer} recorded for ${next.review.commit?.slice(0, 7)}` })
    return console.log(`review by ${reviewer} recorded for ${next.review.commit?.slice(0, 7)}`)
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
  if (verb === 'checks') {
    const [sub, raw] = args
    sub === 'set' && raw || fail('usage: loop.mjs checks set \'[{"id":"1-desktop","step":1,"case":"desktop"}, …]\'')
    let checks
    try { checks = JSON.parse(raw) } catch { fail('checks must be JSON') }
    const problem = checksProblem(checks)
    problem && fail(problem)
    const next = update(root, r => {
      const at = ids().indexOf(current(r) ?? 'report')
      at > ids().indexOf('verify') && fail('verify already passed on the old list; go back to build first')
      return { ...r, checks, checks_revision: (r.checks_revision ?? 0) + 1 }
    })
    emit(root, { kind: 'note', text: `check list set: ${checks.length} check${checks.length === 1 ? '' : 's'} (revision ${next.checks_revision})` })
    return console.log(`${checks.length} checks set`)
  }
  if (verb === 'put') {
    const [key, raw] = args
    key === 'reviewer' && fail('a review is recorded with its output: loop.mjs review <reviewer> <file>')
    PUT_KEYS.has(key) || fail(`put takes one of: ${[...PUT_KEYS].join(', ')}`)
    let value = raw
    try { value = JSON.parse(raw) } catch { /* a bare string such as a branch name */ }
    update(root, r => {
      key === 'branch' && r.branch && r.branch !== value && r.pushed &&
        fail(`the story branch is "${r.branch}" and was published; it does not change mid-run`)
      key === 'repo' && r.repo && r.repo !== value && fail(`this run belongs to ${r.repo}; the repository does not change mid-run`)
      return { ...r, [key]: value }
    })
    emit(root, { kind: 'note', text: `${key} updated` })
    return console.log(`${key} set`)
  }
  // wait and back take a second positional (who / target) before the reason.
  const [stage, ...rest] = args
  const arg = verb === 'wait' || verb === 'back' ? rest.shift() : undefined
  const reason = rest.join(' ') || undefined
  const next = update(root, r => {
    if (verb === 'pass') {
      const problem = passProblem(root, r, stage)
      problem && fail(`${stage} cannot pass: ${problem}`)
    }
    const moved = move(r, verb, stage, arg, reason)
    if (verb === 'start' && stage === 'verify') {
      // The request exists before the browser runs; results are checked against it, never stamped afterwards.
      dirty(root) && fail('verify starts on committed code; the checkout has uncommitted changes')
      const request = verifyRequest(r, headTree(root) ?? fail('not a git checkout'))
      if (readResultsFile(root, r)?.request !== request.id) archiveAttempt(root, r, `${request.attempt}-superseded`)
      moved.stages.verify.request = request
    }
    if (verb === 'pass') Object.assign(moved.stages[stage], passStamp(root, stage))
    if (verb === 'back') archiveAttempt(root, r, r.stages.verify.attempt ?? 1)
    return moved
  })
  emit(root, { kind: 'stage', stage, verb, to: arg, text: reason })
  console.log(status(next))
  if (verb === 'start' && stage === 'verify') console.log(`verify request: ${next.stages.verify.request.id}  (results.json must carry it as "request")`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)) } catch (error) { console.error(`loop: ${error.message}`); process.exit(1) }
}
