#!/usr/bin/env node
// story-loop state machine. The graph (graph.json) is the only source of which
// moves exist; this script refuses every other move. State lives in the target
// repo under .start-story/, which start-story already expects to be gitignored.
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const GRAPH = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'graph.json'), 'utf8'))
const DONE = new Set(['passed', 'skipped'])
const PUT_KEYS = new Set(['title', 'branch', 'pr', 'base', 'tasks', 'findings', 'evidence', 'browser', 'reviewer'])

// A run starts from a Shortcut story (sc-123) or a GitHub issue (gh-123).
// Accepts SC-123, 123, gh-123, #123, and the URL of either.
export function storyId(input = '') {
  const text = String(input).trim().toLowerCase()
  const issue = text.match(/^(?:gh-|#)(\d+)$/) ?? text.match(/github\.com\/[^/]+\/[^/]+\/issues\/(\d+)/)
  if (issue) return `gh-${issue[1]}`
  const story = text.match(/^(?:sc-)?(\d+)$/) ?? text.match(/shortcut\.com\/[^/]+\/story\/(\d+)/)
  return story ? `sc-${story[1]}` : null
}

export function newRun(story, now = new Date().toISOString()) {
  return {
    story, started_at: now, session: null, stop_blocks: 0,
    stages: Object.fromEntries(GRAPH.stages.map(s => [s.id, { status: 'pending', rounds: 0 }])),
    tasks: [], findings: [], evidence: {},
  }
}

const ids = () => GRAPH.stages.map(s => s.id)
const fail = message => { throw new Error(message) }

// The stage the loop must work on next: the first one that is not done.
export function current(run) {
  return ids().find(id => !DONE.has(run.stages[id].status)) ?? null
}

// One move. Returns the new run; throws with the reason when the graph forbids it.
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
    case 'skip':
      mustBeCurrent(); needReason()
      stage === 'second_review' && fail('second_review is never skipped; block it with the reason instead')
      stage === 'verify' && !/^human:/i.test(reason) &&
        fail('verify is skipped only on the human\'s say-so: skip verify "human: <their reason>". No browser is a wait, not a skip')
      Object.assign(st, { status: 'skipped', ended_at: now, reason })
      break
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
      const byHuman = /^human:/i.test(reason)
      !byHuman && target.rounds >= GRAPH.maxRounds &&
        fail(`"${arg}" already went back ${GRAPH.maxRounds} times; record "wait ${stage} human" and show the human`)
      const all = ids()
      for (const id of all.slice(all.indexOf(arg))) {
        const s = next.stages[id]
        next.stages[id] = { status: 'pending', rounds: s.rounds }
      }
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

// ---- files -----------------------------------------------------------------

export function findRoot(from = process.cwd()) {
  for (let dir = resolve(from); ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.start-story', 'active.json'))) return dir
    if (dir === dirname(dir)) return null
  }
}
export const paths = root => ({
  active: join(root, '.start-story', 'active.json'),
  events: join(root, '.start-story', 'events.jsonl'),
})
export const load = root => JSON.parse(readFileSync(paths(root).active, 'utf8'))
export const save = (root, run) => writeFileSync(paths(root).active, JSON.stringify(run, null, 2) + '\n')
export function emit(root, event) {
  appendFileSync(paths(root).events, JSON.stringify({ ts: new Date().toISOString(), ...event }) + '\n')
}

// ---- notes from the board ----------------------------------------------------
// A note is the human's instruction, typed on the board. queued -> delivered
// (the hook or the copy button handed it to an agent) -> done (the agent acted).

const inboxFile = root => join(root, '.start-story', 'inbox.json')
export const readInbox = root => { try { return JSON.parse(readFileSync(inboxFile(root), 'utf8')) } catch { return [] } }
export const writeInbox = (root, notes) => writeFileSync(inboxFile(root), JSON.stringify(notes, null, 2) + '\n')

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
    'When a note is handled, record it: loop.mjs note done <id> "<what you did>".',
    ...items].join('\n\n')
}

// Marks every queued note delivered and returns the handover text, or null.
export function deliver(root, via) {
  const notes = readInbox(root)
  const queued = notes.filter(n => n.status === 'queued')
  if (!queued.length) return null
  writeInbox(root, notes.map(n => n.status === 'queued' ? { ...n, status: 'delivered', via } : n))
  emit(root, { kind: 'note', text: `${queued.length} note${queued.length > 1 ? 's' : ''} handed to the agent (${via})` })
  return handover(load(root), queued)
}

// ---- browser verification ------------------------------------------------------
// The verifier writes results.json; "pass verify" is refused unless every check
// passed and has a screenshot that exists. The board shows the same file.

export const resultsFile = (root, run) => join(root, '.start-story', run.story, 'results.json')
export const evidenceDir = (root, run) => join(root, '.start-story', run.story, 'evidence')
export const readResults = (root, run) => { try { return JSON.parse(readFileSync(resultsFile(root, run), 'utf8')) } catch { return null } }

export function verifyProblem(root, run) {
  const results = readResults(root, run)
  if (!Array.isArray(results) || !results.length) return `no checks in ${resultsFile(root, run)}; the verifier has not reported`
  for (const r of results) {
    const name = `step ${r.step}${r.case ? ` (${r.case})` : ''}`
    if (r.verdict !== 'pass') return `${name} is "${r.verdict}", not pass`
    if (!Array.isArray(r.evidence) || !r.evidence.length) return `${name} has no screenshot`
    const missing = r.evidence.find(file => !existsSync(resolve(evidenceDir(root, run), file)))
    if (missing) return `${name}: screenshot ${missing} does not exist`
  }
  return null
}

function status(run) {
  const cur = current(run)
  const rows = GRAPH.stages.map(({ id, label }) => {
    const s = run.stages[id]
    const extra = [s.rounds ? `round ${s.rounds + 1}` : '', s.waiting_on ? `waiting on ${s.waiting_on}` : '', s.reason ?? '']
      .filter(Boolean).join(' · ')
    return `${id === cur ? '>' : ' '} ${label.padEnd(15)} ${s.status.padEnd(8)} ${extra}`
  })
  return [`story-loop ${run.story}${run.branch ? ` · ${run.branch}` : ''}${run.pr ? ` · PR ${run.pr}` : ''}`, ...rows,
    cur ? `next: ${cur}` : 'all stages done'].join('\n')
}

function main([verb, ...args]) {
  if (verb === 'init') {
    const story = storyId(args[0]) ?? fail('usage: loop.mjs init SC-12345 | gh-123 | <story or issue URL>')
    const root = process.cwd()
    const p = paths(root)
    if (existsSync(p.active)) {
      const old = load(root)
      old.story === story || current(old) === null ||
        fail(`another run is active here (${old.story}); finish it or run: loop.mjs end`)
      if (old.story === story) return console.log(status(old))
    }
    mkdirSync(dirname(p.active), { recursive: true })
    writeFileSync(p.events, '')
    const run = newRun(story)
    save(root, run)
    emit(root, { kind: 'stage', text: `run started for ${story}` })
    return console.log(status(run))
  }
  const root = findRoot() ?? fail('no active story-loop run here (loop.mjs init SC-12345)')
  const run = load(root)
  if (!verb || verb === 'status') return console.log(status(run))
  if (verb === 'json') return console.log(JSON.stringify(run))
  if (verb === 'inbox') {
    const open = readInbox(root).filter(n => n.status !== 'done')
    return console.log(open.length ? handover(run, open) : 'no open notes')
  }
  if (verb === 'note') {
    const [sub, id, ...what] = args
    sub === 'done' && id && what.length || fail('usage: loop.mjs note done <id> "<what you did>"')
    const notes = readInbox(root)
    notes.some(n => n.id === id) || fail(`no note "${id}"`)
    writeInbox(root, notes.map(n => n.id === id ? { ...n, status: 'done', result: what.join(' ') } : n))
    emit(root, { kind: 'note', text: `note ${id} handled: ${what.join(' ')}` })
    return console.log(`note ${id} done`)
  }
  if (verb === 'end') { rmSync(paths(root).active); return console.log(`run ${run.story} ended`) }
  if (verb === 'put') {
    const [key, raw] = args
    PUT_KEYS.has(key) || fail(`put takes one of: ${[...PUT_KEYS].join(', ')}`)
    let value = raw
    try { value = JSON.parse(raw) } catch { /* a bare string such as a branch name */ }
    run[key] = value
    save(root, run)
    emit(root, { kind: 'note', text: `${key} updated` })
    return console.log(`${key} set`)
  }
  // wait and back take a second positional (who / target) before the reason.
  const [stage, ...rest] = args
  const arg = verb === 'wait' || verb === 'back' ? rest.shift() : undefined
  const reason = rest.join(' ') || undefined
  if (verb === 'pass' && stage === 'verify') {
    const problem = verifyProblem(root, run)
    if (problem) fail(`verify cannot pass: ${problem}`)
    run.browser || fail('verify cannot pass: record the browser that was used (loop.mjs put browser chrome|browseros|playwright)')
  }
  if (verb === 'pass' && stage === 'second_review')
    run.reviewer || fail('second_review cannot pass: record who reviewed (loop.mjs put reviewer codex|claude|<name>)')
  const next = move(run, verb, stage, arg, reason)
  save(root, next)
  emit(root, { kind: 'stage', stage, verb, to: arg, text: reason })
  console.log(status(next))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)) } catch (error) { console.error(`loop: ${error.message}`); process.exit(1) }
}
