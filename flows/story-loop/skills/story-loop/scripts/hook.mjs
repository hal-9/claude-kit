#!/usr/bin/env node
// One command hook for every event story-loop listens to. It does nothing unless
// a run is active in the checkout the event came from.
//   PreToolUse     guard pushes, merges and readiness; ownership; forward what the agent is doing
//   PostToolUse    hand notes typed on the board to the conductor
//   SubagentStart  / SubagentStop: forward workers appearing and leaving
//   Stop           hand over notes; keep the conductor going until a stage waits, blocks or all pass
//   SessionStart   / PostModelSwitch: remember the session's model; tell a new session about the run
//   PreModelSwitch keep the conductor on its model while a run is active
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { GRAPH, LEASE_MS, findRoot, load, update, emit, stopReason, liveWorkers, liveHelpers, deliver, current, ownerState } from './loop.mjs'
import { bind, record } from './diag.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const MAX_STOP_BLOCKS = 3
const HEARTBEAT_MS = 60_000
// The plugin's four worker profiles and the model each one is defined with.
export const PROFILES = { 'worker-haiku': 'haiku', 'worker-sonnet': 'sonnet', 'worker-opus': 'opus', 'worker-opus-max': 'opus' }
// Commands with an effect outside this machine. With an unreadable state they are refused.
const OUTWARD = /\bgit\b[^\n;&|]*\spush\b|\bgh\b[^\n;&|]*\b(pr|api|issue|release)\b/
const LOOP_WRITE = /loop\.mjs["']?\s+(start|pass|skip|block|wait|back|put|checks|note|end|review|mutant|quality)\b|publish\.mjs|github\.mjs|mutate\.mjs|quality\.mjs/
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

// Returns the reason a shell command is refused during a run, or null.
// ponytail: this reads the command's spelling, so it stops accidents and the
// plain spellings, not a determined `sh -c "$(...)"` or an MCP write. Pushes
// are refused outright and go through publish.mjs; the real boundary is branch
// protection on GitHub.
export function checkCommand(command) {
  if (/\bgh\b[^\n;&|]*\bpr\s+(merge|ready)\b/.test(command) ||
      /\bgh\s+api\b[^\n;&|]*(\/merge\b|mergePullRequest|markPullRequestReadyForReview|enablePullRequestAutoMerge)/.test(command))
    return 'story-loop never merges and never marks a PR ready. A human does both on GitHub.'
  if (/\bgit\b(?:\s+(?:-[cC]|--git-dir|--work-tree|--namespace|--exec-path|--config-env)(?:\s+|=)\S+|\s+-{1,2}[\w-]+(?:=\S+)?)*\s+push\b/.test(command))
    return `story-loop: pushes go through the publisher, which pushes the checked commit to the story branch only: node "${join(HERE, 'publish.mjs')}"`
  return null
}

function claimTitle(root, agentType) {
  // ponytail: titles are matched to workers by type in spawn order; two workers
  // of one tier starting together can swap titles. Fix with the spawn's
  // tool_use_id if SubagentStart ever carries it.
  const file = join(root, '.start-story', 'spawns.jsonl')
  if (!existsSync(file)) return undefined
  const rows = readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
  const i = rows.findIndex(r => r.agent === agentType)
  if (i < 0) return undefined
  const [row] = rows.splice(i, 1)
  writeFileSync(file, rows.map(r => JSON.stringify(r) + '\n').join(''))
  return row.title
}

// ---- models: who may think with what -------------------------------------------
// graph.json names the conductor's model and the models work may be delegated to.

const MODELS = GRAPH.models
const isConductorModel = model => new RegExp(MODELS.conductor, 'i').test(model)
const modelFile = sessionId => join(tmpdir(), `story-loop-model-${String(sessionId).replace(/[^\w-]/g, '')}`)
const knownModel = sessionId => { try { return readFileSync(modelFile(sessionId), 'utf8').trim() } catch { return null } }

// Returns why a delegation is refused during a run, or null. The plugin's own
// workers carry their model in their definition; anything else must name one.
export function checkAgent({ subagent_type: type = 'general-purpose', model } = {}) {
  const allowed = MODELS.delegates
  if (model && !allowed.includes(model))
    return `story-loop: work is delegated to ${allowed.join(', ')} only, not "${model}". The conductor keeps ${MODELS.conductor} for itself.`
  const profile = PROFILES[type.replace(/^story-loop:/, '')]
  if (profile) return model && model !== profile
    ? `story-loop: ${type} is defined on ${profile}; drop model: ${model}, or pick the worker defined on ${model}.`
    : null
  if (/fable/i.test(type)) return `story-loop: "${type}" runs on the conductor's model; use a story-loop worker instead.`
  if (!model) return `story-loop: "${type}" would inherit the conductor's model. Use a story-loop worker (${Object.keys(PROFILES).join(', ')}) or add model: ${allowed.join(' | ')}.`
  return null
}

// A refusal never reaches the tool, so no later hook sees it: it is recorded here,
// before the exit. record() cannot throw, so a recording failure never weakens a denial.
let DENIED = null // { root, tool, tool_use_id } once the checkout of the event is known
const deny = message => {
  if (DENIED) record(DENIED.root, 'guard.denied', { reason: message, tool: DENIED.tool, tool_use_id: DENIED.tool_use_id })
  console.error(message)
  process.exit(2)
}

// What a tool call was, small enough to keep: no file contents, no full output.
function toolSummary(root, input) {
  const ti = input.tool_input ?? {}
  const tr = input.tool_response
  const response = tr == null ? undefined : typeof tr === 'string' ? tr.slice(0, 500)
    : { status: tr.status, agent_id: tr.agentId, resolved_model: tr.resolvedModel, total_tokens: tr.totalTokens, total_duration_ms: tr.totalDurationMs, exit_code: tr.exitCode ?? tr.exit_code, interrupted: tr.interrupted }
  return {
    tool: input.tool_name ?? null, tool_use_id: input.tool_use_id ?? null,
    file: ti.file_path ? relative(root, resolve(root, ti.file_path)) : undefined,
    command: typeof ti.command === 'string' ? ti.command.slice(0, 300) : undefined,
    subagent: ti.subagent_type, model: ti.model, description: ti.description, response,
  }
}
// One diagnostic record per hook event. Pre and post of a tool call share its
// tool_use_id; a start with no end is a call that was cancelled or cut off.
function diagnose(root, input, model) {
  const event = input.hook_event_name
  const elapsed_ms = Number.isFinite(input.duration_ms) ? input.duration_ms : null
  switch (event) {
    case 'PreToolUse': return record(root, 'tool.start', toolSummary(root, input))
    case 'PostToolUse': return record(root, 'tool.end', { ...toolSummary(root, input), outcome: 'ok', elapsed_ms })
    case 'PostToolUseFailure': return record(root, 'tool.failed', { ...toolSummary(root, input), outcome: input.is_interrupt ? 'interrupted' : 'error', reason: String(input.error ?? '').slice(0, 1000), elapsed_ms })
    case 'SubagentStart': case 'SubagentStop': return record(root, event === 'SubagentStart' ? 'agent.start' : 'agent.stop', { agent_type: input.agent_type ?? null, agent_id: input.agent_id ?? null })
    case 'SessionStart': return record(root, 'session.start', { source: input.source ?? null, model: input.model ?? model })
    case 'SessionEnd': return record(root, 'session.end', { reason: input.reason ?? null })
    case 'PreModelSwitch': case 'PostModelSwitch': return record(root, 'model.switch', { phase: event, to: input.to_model ?? input.requested_model ?? null, from: model })
  }
}

// Adds (since = a time) or removes (since = null) one worker of the run's live set.
function liveWorker(root, id, since) {
  try {
    update(root, r => {
      const live = { ...r.live_workers }
      if (since == null) { if (!(id in live)) return undefined; delete live[id] } else live[id] = since
      return { ...r, live_workers: live }
    })
  } catch { /* the board still shows the worker; the stop gate only errs toward keeping the conductor going */ }
}

// `loop.mjs acquire [--takeover "<reason>"]`: only the hook knows the session id.
function acquire(root, session, command) {
  const takeover = command.match(/--takeover\s+(["'])(.+?)\1/)?.[2]
  let refused = null
  update(root, run => {
    const state = ownerState(run, session)
    if (state === 'ours') return undefined
    if (state === 'live' && !takeover) {
      refused = `story-loop: run ${run.story} is owned by session ${run.owner.session}, active within the last ${LEASE_MS / 60_000} minutes. ` +
        'If that session is gone or the human wants this one to take over: loop.mjs acquire --takeover "<why>"'
      return undefined
    }
    emit(root, { kind: 'session', phase: 'acquired', text: `session ${session} took over from ${run.owner?.session ?? 'nobody'} (${state}${takeover ? `: ${takeover}` : ''})` })
    // The session that lost the run is retired: its workers may still be running, and their edits are refused from here on.
    const retired = [...new Set([...(run.retired ?? []), run.owner?.session])].filter(s => s && s !== session)
    // Each change of owner is a new generation: notes handed to the old owner are handed over
    // again, and a helper the old owner started is known to have outlived it.
    const generation = (run.owner?.generation ?? 0) + 1
    record(root, 'ownership', { outcome: 'acquired', from: run.owner?.session ?? null, to: session, lease: state, reason: takeover ?? null, generation, outstanding: Object.keys(run.ops ?? {}) })
    return { ...run, retired, owner: { session, since: new Date().toISOString(), heartbeat: Date.now(), generation }, stop_blocks: 0 }
  })
  if (refused) deny(refused)
}

function main() {
  // The board's explainer is a separate read-only `claude -p`; it is never the conductor.
  if (process.env.STORY_LOOP_EXPLAINER) return
  const input = JSON.parse(readFileSync(0, 'utf8') || '{}')
  const event = input.hook_event_name
  const command = String(input.tool_input?.command ?? '')

  // Remember the session's model whenever Claude Code tells us; no other event carries it.
  if (event === 'SessionStart' && input.model) writeFileSync(modelFile(input.session_id), String(input.model))
  if (event === 'PostModelSwitch' && input.to_model) writeFileSync(modelFile(input.session_id), String(input.to_model))
  // A run is started and advanced on the conductor's model only. An unknown model passes: we cannot see it.
  const root = findRoot(input.cwd || process.cwd())
  if (root) DENIED = { root, tool: input.tool_name ?? null, tool_use_id: input.tool_use_id ?? null }
  if (event === 'PreToolUse' && input.tool_name === 'Bash' && !input.agent_id && /loop\.mjs["']?\s+(init|start)\b/.test(command)) {
    const model = knownModel(input.session_id)
    if (model && !isConductorModel(model))
      deny(`story-loop: the conductor runs on ${MODELS.conductor}, this session is on ${model}. Ask the human to switch with /model, then continue.`)
  }

  if (!root) return
  let run
  try { run = load(root) } catch (error) {
    // Unreadable state never turns a refusal into an allow: outward commands wait for recovery.
    if (event === 'PreToolUse' && input.tool_name === 'Bash' && OUTWARD.test(command) && !/loop\.mjs["']?\s+recover\b/.test(command))
      deny(`story-loop: ${error.message}. Pushes, merges and PR changes wait until it is recovered.`)
    return
  }
  const state = ownerState(run, input.session_id)
  const ours = state === 'ours'
  // Recording is the run's own switch (loop.mjs diagnostics on); with it off this binds to nothing.
  bind(root, run, { session: input.session_id ?? null, agent: input.agent_id ? `${input.agent_type ?? 'agent'}:${input.agent_id}` : 'conductor', stage: current(run) })
  diagnose(root, input, knownModel(input.session_id))

  // The human cannot switch the conductor away mid-run by accident; ending the run lifts this.
  if (event === 'PreModelSwitch') {
    const to = String(input.to_model ?? input.requested_model ?? '')
    if ((ours || state === 'unowned') && current(run) && to && !isConductorModel(to))
      deny(`story-loop: a run is active (${run.story}) and its conductor stays on ${MODELS.conductor}. End the run first (loop.mjs end) to switch.`)
    return
  }
  if (event === 'SessionStart') {
    if (ours || !current(run)) return
    const who = state === 'unowned' ? 'no session owns it yet' : `session ${run.owner.session} owns it (${state === 'live' ? 'still active' : 'lease expired'})`
    return console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext:
      `A story-loop run is active in this checkout: ${run.story}, stage ${current(run)}; ${who}. ` +
      'To continue it here, load /story-loop and run `loop.mjs acquire` first; its notes, stop gate and delegation rules then follow this session.' } }))
  }
  const agent = input.agent_type || 'conductor'
  const agent_id = input.agent_id || 'conductor'
  // Any hook call of the owning session renews its lease, a worker's included:
  // a conductor waiting on its workers is active, not gone.
  // ponytail: one tool call running longer than the lease with no other activity still lets it expire.
  if (ours && input.session_id && Date.now() - (run.owner.heartbeat ?? 0) > HEARTBEAT_MS) {
    try {
      // The transcripts of the sessions that drove the run are where the ledger reads its token counts.
      const transcripts = r => input.transcript_path ? [...new Set([...(r.transcripts ?? []), input.transcript_path])] : r.transcripts
      update(root, r => ownerState(r, input.session_id) === 'ours' ? { ...r, owner: { ...r.owner, heartbeat: Date.now() }, transcripts: transcripts(r) } : undefined)
    } catch { /* a missed heartbeat is retried on the next call */ }
  }

  switch (event) {
    case 'PreToolUse': {
      const tool = input.tool_name
      const ti = input.tool_input ?? {}
      if (tool === 'Bash') {
        const refused = checkCommand(command)
        if (refused) deny(refused)
        if (!input.agent_id && /loop\.mjs["']?\s+acquire\b/.test(command)) return acquire(root, input.session_id, command)
        if (LOOP_WRITE.test(command) && (state === 'live' || state === 'expired'))
          deny(`story-loop: run ${run.story} belongs to session ${run.owner.session}. Run loop.mjs acquire first.`)
      }
      // ponytail: this sees the edit tools only; a file changed through a shell command is not caught.
      if (EDIT_TOOLS.has(tool) && !ours && run.retired?.includes(input.session_id))
        deny(`story-loop: session ${run.owner?.session} took over run ${run.story}; this session and its workers no longer change its code. Stop here and report what you had done.`)
      // Every refusal is decided before any write, so a busy lock can never turn one into an allow.
      if (tool === 'Agent' || tool === 'Task') {
        const refused = (ours || state === 'unowned') && checkAgent(ti)
        if (refused) deny(refused)
      }
      // The first session to drive loop.mjs owns an unowned run.
      if (!input.agent_id && input.session_id && state === 'unowned' && tool === 'Bash' && /loop\.mjs/.test(command)) {
        try {
          update(root, r => ownerState(r, input.session_id) === 'unowned'
            ? { ...r, owner: { session: input.session_id, since: new Date().toISOString(), heartbeat: Date.now() } } : undefined)
        } catch { /* claimed on the next call */ }
      }
      if (tool === 'Agent' || tool === 'Task') {
        appendFileSync(join(root, '.start-story', 'spawns.jsonl'),
          JSON.stringify({ agent: ti.subagent_type ?? 'general-purpose', title: ti.description }) + '\n')
        return
      }
      const file = ti.file_path ? relative(root, resolve(root, ti.file_path)) : undefined
      emit(root, { kind: 'tool', agent, agent_id, tool, file, text: tool === 'Bash' ? command.slice(0, 140) : undefined })
      return
    }
    case 'SubagentStart':
      // The stop gate lets a conductor end its turn while its workers run: their
      // reports arrive as notifications, and only an idle conductor receives them.
      if (ours && input.agent_id) liveWorker(root, input.agent_id, Date.now())
      return emit(root, { kind: 'agent', phase: 'start', agent, agent_id, text: claimTitle(root, input.agent_type) })
    case 'SubagentStop':
      if (input.agent_id) liveWorker(root, input.agent_id, null)
      return emit(root, { kind: 'agent', phase: 'stop', agent, agent_id })
    case 'PostToolUse': {
      // Notes typed on the board reach the conductor between two of its tool
      // calls. Never a worker: it would act on them without the plan.
      if (input.agent_id) return
      // `loop.mjs init` created the run after its PreToolUse ran: the session that ran it owns it.
      if (state === 'unowned' && input.tool_name === 'Bash' && /loop\.mjs["']?\s+init\b/.test(command) && input.session_id) {
        update(root, r => ownerState(r, input.session_id) === 'unowned'
          ? { ...r, owner: { session: input.session_id, since: new Date().toISOString(), heartbeat: Date.now() } } : undefined)
        return
      }
      if (!ours) return
      // Notes that cannot be read are said out loud, never treated as no notes.
      let notes
      try { notes = deliver(root, 'while working', input.session_id) } catch (error) { notes = `story-loop: ${error.message}. Tell the human: notes they typed on the board may be waiting in that file.` }
      if (notes) console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: notes } }))
      return
    }
    case 'Stop': {
      if (!ours) return
      const notes = deliver(root, 'before stopping', input.session_id)
      if (notes) { record(root, 'stop', { outcome: 'blocked', reason: 'notes from the board were waiting' }); return console.log(JSON.stringify({ decision: 'block', reason: notes })) }
      const reason = stopReason(run)
      if (!reason) {
        const waiting = [...liveWorkers(run).map(() => 'worker'), ...liveHelpers(run).map(o => o.kind)]
        record(root, 'stop', { outcome: 'allowed', reason: waiting.length ? `waiting on ${waiting.join(', ')}` : undefined })
        return emit(root, { kind: 'session', phase: 'idle' })
      }
      if ((run.stop_blocks ?? 0) >= MAX_STOP_BLOCKS) {
        // Give way, but say so in the run: the stage is blocked, not quietly pending.
        const cur = current(run)
        const why = `stop gate: the conductor stopped ${MAX_STOP_BLOCKS + 1} times without moving "${cur}"; resume with loop.mjs start ${cur}`
        update(root, r => ({ ...r, stop_blocks: 0, stages: { ...r.stages, [cur]: { ...r.stages[cur], status: 'blocked', reason: why } } }))
        record(root, 'transition', { verb: 'block', stage: cur, outcome: 'accepted', reason: why, by: 'stop gate' })
        return emit(root, { kind: 'stage', stage: cur, verb: 'block', text: why })
      }
      update(root, r => ({ ...r, stop_blocks: (r.stop_blocks ?? 0) + 1 }))
      record(root, 'stop', { outcome: 'blocked', reason })
      console.log(JSON.stringify({ decision: 'block', reason }))
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // A broken hook must not take the session down; only a deliberate deny exits 2.
  // Policy failures are handled above (unreadable state refuses outward commands).
  try { main() } catch (error) { console.error(`story-loop hook: ${error.message}`); process.exit(0) }
}
