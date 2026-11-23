#!/usr/bin/env node
// One command hook for every event story-loop listens to. It does nothing unless
// a run is active in the checkout the event came from.
//   PreToolUse     guard pushes and merges; forward what the agent is doing
//   PostToolUse    hand notes typed on the board to the conductor
//   SubagentStart  / SubagentStop: forward workers appearing and leaving
//   Stop           hand over notes; keep the conductor going until a stage waits, blocks or all pass
//   SessionStart   / PostModelSwitch: remember the session's model
//   PreModelSwitch keep the conductor on its model while a run is active
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { GRAPH, findRoot, load, save, emit, stopReason, deliver, current } from './loop.mjs'

const FORBIDDEN_PUSH_FLAGS = /^(-f|--force.*|--all|--mirror|--tags|--delete|-d|--prune)$/
const MAX_STOP_BLOCKS = 3

// Returns the reason a shell command is refused during a run, or null.
// ponytail: this reads the command's spelling, so it stops accidents and the
// plain cases, not a determined `sh -c "$(...)"`. The real boundary is branch
// protection on GitHub; upgrade path is a server-side rule, not a smarter regex.
export function checkCommand(command, { branch, currentBranch }) {
  if (/\bgh\s+pr\s+merge\b/.test(command) || /\bgh\s+api\b[^\n;&|]*\/merge\b/.test(command))
    return 'story-loop never merges. A human merges the PR on GitHub.'
  for (const [, options, rest] of command.matchAll(/\bgit\b((?:\s+-[cC]\s+\S+|\s+--[\w-]+(?:=\S+)?)*)\s+push\b([^\n;&|]*)/g)) {
    if (!branch) return 'story-loop: no story branch is recorded yet, so nothing may be pushed.'
    if (/\s-C\s/.test(options)) return 'story-loop: push from the repo root without -C, so the branch can be checked.'
    const tokens = rest.trim().split(/\s+/).filter(Boolean).map(t => t.replace(/^["']|["']$/g, ''))
    const flag = tokens.find(t => FORBIDDEN_PUSH_FLAGS.test(t))
    if (flag) return `story-loop: "git push ${flag}" is not allowed during a run.`
    const [remote, ...refs] = tokens.filter(t => !t.startsWith('-'))
    if (remote && remote !== 'origin') return `story-loop: pushes go to origin only, not "${remote}".`
    const onBranch = currentBranch === branch
    const ok = ref => ref === branch
      ? true
      : ref === 'HEAD' ? onBranch
      : [`HEAD:${branch}`, `${branch}:${branch}`, `HEAD:refs/heads/${branch}`].includes(ref) && (onBranch || !ref.startsWith('HEAD'))
    if (!refs.length && !onBranch)
      return `story-loop: you are on "${currentBranch}", not the story branch "${branch}".`
    const bad = refs.find(ref => !ok(ref))
    if (bad) return `story-loop: only "${branch}" may be pushed, not "${bad}".`
  }
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
  if (/^(story-loop:)?worker-/.test(type)) return null
  if (/fable/i.test(type)) return `story-loop: "${type}" runs on the conductor's model; use a story-loop worker instead.`
  if (!model) return `story-loop: "${type}" would inherit the conductor's model. Add model: ${allowed.join(' | ')} to the Agent call (opus for anything that needs judgment).`
  return null
}

function main() {
  const input = JSON.parse(readFileSync(0, 'utf8') || '{}')
  const event = input.hook_event_name

  // Remember the session's model whenever Claude Code tells us; no other event carries it.
  if (event === 'SessionStart' && input.model) writeFileSync(modelFile(input.session_id), String(input.model))
  if (event === 'PostModelSwitch' && input.to_model) writeFileSync(modelFile(input.session_id), String(input.to_model))
  // A run is started and advanced on the conductor's model only. An unknown model passes: we cannot see it.
  if (event === 'PreToolUse' && input.tool_name === 'Bash' && !input.agent_id &&
      /loop\.mjs["']?\s+(init|start)\b/.test(String(input.tool_input?.command ?? ''))) {
    const model = knownModel(input.session_id)
    if (model && !isConductorModel(model)) {
      console.error(`story-loop: the conductor runs on ${MODELS.conductor}, this session is on ${model}. Ask the human to switch with /model, then continue.`)
      process.exit(2)
    }
  }

  const root = findRoot(input.cwd || process.cwd())
  if (!root) return
  const run = load(root)
  const ours = !run.session || run.session === input.session_id
  // The human cannot switch the conductor away mid-run by accident; ending the run lifts this.
  if (event === 'PreModelSwitch' && ours && current(run)) {
    const to = String(input.to_model ?? input.requested_model ?? '')
    if (to && !isConductorModel(to)) {
      console.error(`story-loop: a run is active (${run.story}) and its conductor stays on ${MODELS.conductor}. End the run first (loop.mjs end) to switch.`)
      process.exit(2)
    }
    return
  }
  const agent = input.agent_type || 'conductor'
  const agent_id = input.agent_id || 'conductor'

  switch (event) {
    case 'PreToolUse': {
      const tool = input.tool_name
      const ti = input.tool_input ?? {}
      if (tool === 'Bash') {
        let currentBranch = ''
        try { currentBranch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim() } catch {}
        const deny = checkCommand(String(ti.command ?? ''), { branch: run.branch, currentBranch })
        if (deny) { console.error(deny); process.exit(2) }
      }
      if (!run.session && input.session_id) save(root, { ...load(root), session: input.session_id })
      if (tool === 'Agent' || tool === 'Task') {
        const deny = ours && checkAgent(ti)
        if (deny) { console.error(deny); process.exit(2) }
        appendFileSync(join(root, '.start-story', 'spawns.jsonl'),
          JSON.stringify({ agent: ti.subagent_type ?? 'general-purpose', title: ti.description }) + '\n')
        return
      }
      const file = ti.file_path ? relative(root, resolve(root, ti.file_path)) : undefined
      emit(root, { kind: 'tool', agent, agent_id, tool, file, text: tool === 'Bash' ? String(ti.command ?? '').slice(0, 140) : undefined })
      return
    }
    case 'SubagentStart':
      return emit(root, { kind: 'agent', phase: 'start', agent, agent_id, text: claimTitle(root, input.agent_type) })
    case 'SubagentStop':
      return emit(root, { kind: 'agent', phase: 'stop', agent, agent_id })
    case 'PostToolUse': {
      // Notes typed on the board reach the conductor between two of its tool
      // calls. Never a worker: it would act on them without the plan.
      if (input.agent_id || (run.session && run.session !== input.session_id)) return
      const notes = deliver(root, 'while working')
      if (notes) console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: notes } }))
      return
    }
    case 'Stop': {
      if (run.session && run.session !== input.session_id) return
      const notes = deliver(root, 'before stopping')
      if (notes) return console.log(JSON.stringify({ decision: 'block', reason: notes }))
      const reason = stopReason(run)
      if (!reason) return emit(root, { kind: 'session', phase: 'idle' })
      if ((run.stop_blocks ?? 0) >= MAX_STOP_BLOCKS)
        return emit(root, { kind: 'note', text: 'stop gate gave way after three tries; the run is unfinished' })
      save(root, { ...run, stop_blocks: (run.stop_blocks ?? 0) + 1 })
      console.log(JSON.stringify({ decision: 'block', reason }))
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // A broken hook must never take the session down with it; only a deliberate deny exits 2.
  try { main() } catch (error) { console.error(`story-loop hook: ${error.message}`); process.exit(0) }
}
