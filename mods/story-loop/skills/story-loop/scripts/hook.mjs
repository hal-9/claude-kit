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
import { GRAPH, LEASE_MS, findRoot, load, update, emit, stopReason, deliver, current, ownerState } from './loop.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const MAX_STOP_BLOCKS = 3
const HEARTBEAT_MS = 60_000
// The plugin's four worker profiles and the model each one is defined with.
export const PROFILES = { 'worker-haiku': 'haiku', 'worker-sonnet': 'sonnet', 'worker-opus': 'opus', 'worker-opus-max': 'opus' }
// Commands with an effect outside this machine. With an unreadable state they are refused.
const OUTWARD = /\bgit\b[^\n;&|]*\spush\b|\bgh\b[^\n;&|]*\b(pr|api|issue|release)\b/
const LOOP_WRITE = /loop\.mjs["']?\s+(start|pass|skip|block|wait|back|put|checks|note|end)\b|publish\.mjs|github\.mjs|mutate\.mjs/

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

const deny = message => { console.error(message); process.exit(2) }

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
    return { ...run, owner: { session, since: new Date().toISOString(), heartbeat: Date.now() }, stop_blocks: 0 }
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
  if (event === 'PreToolUse' && input.tool_name === 'Bash' && !input.agent_id && /loop\.mjs["']?\s+(init|start)\b/.test(command)) {
    const model = knownModel(input.session_id)
    if (model && !isConductorModel(model))
      deny(`story-loop: the conductor runs on ${MODELS.conductor}, this session is on ${model}. Ask the human to switch with /model, then continue.`)
  }

  const root = findRoot(input.cwd || process.cwd())
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
      // Every refusal is decided before any write, so a busy lock can never turn one into an allow.
      if (tool === 'Agent' || tool === 'Task') {
        const refused = (ours || state === 'unowned') && checkAgent(ti)
        if (refused) deny(refused)
      }
      // The first session to drive loop.mjs owns an unowned run; the owner renews its lease.
      const claims = state === 'unowned' && tool === 'Bash' && /loop\.mjs/.test(command)
      if (!input.agent_id && input.session_id && (claims || (ours && Date.now() - (run.owner.heartbeat ?? 0) > HEARTBEAT_MS))) {
        try {
          update(root, r => {
            const now = ownerState(r, input.session_id)
            if (now !== 'unowned' && now !== 'ours') return undefined
            return { ...r, owner: { session: input.session_id, since: r.owner?.since ?? new Date().toISOString(), heartbeat: Date.now() } }
          })
        } catch { /* a missed heartbeat is retried on the next call */ }
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
      return emit(root, { kind: 'agent', phase: 'start', agent, agent_id, text: claimTitle(root, input.agent_type) })
    case 'SubagentStop':
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
      const notes = deliver(root, 'while working')
      if (notes) console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: notes } }))
      return
    }
    case 'Stop': {
      if (!ours) return
      const notes = deliver(root, 'before stopping')
      if (notes) return console.log(JSON.stringify({ decision: 'block', reason: notes }))
      const reason = stopReason(run)
      if (!reason) return emit(root, { kind: 'session', phase: 'idle' })
      if ((run.stop_blocks ?? 0) >= MAX_STOP_BLOCKS) {
        // Give way, but say so in the run: the stage is blocked, not quietly pending.
        const cur = current(run)
        const why = `stop gate: the conductor stopped ${MAX_STOP_BLOCKS + 1} times without moving "${cur}"; resume with loop.mjs start ${cur}`
        update(root, r => ({ ...r, stop_blocks: 0, stages: { ...r.stages, [cur]: { ...r.stages[cur], status: 'blocked', reason: why } } }))
        return emit(root, { kind: 'stage', stage: cur, verb: 'block', text: why })
      }
      update(root, r => ({ ...r, stop_blocks: (r.stop_blocks ?? 0) + 1 }))
      console.log(JSON.stringify({ decision: 'block', reason }))
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // A broken hook must not take the session down; only a deliberate deny exits 2.
  // Policy failures are handled above (unreadable state refuses outward commands).
  try { main() } catch (error) { console.error(`story-loop hook: ${error.message}`); process.exit(0) }
}
