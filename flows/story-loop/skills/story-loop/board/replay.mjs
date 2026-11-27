// A finished run, played back on the board from what it recorded: the run state it
// ended with and its feed. The stages are rebuilt move by move from the feed; what a
// stage produced (findings, screenshots, the walkthrough) shows once that stage ends,
// so the board looks at each step as it did then, only faster.
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { GRAPH, newRun, move, paths, runDir, migrate } from '../scripts/loop.mjs'

const jsonl = file => readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap(l => { try { return [JSON.parse(l)] } catch { return [] } })

// What one stage says on screen while the replay stands on it: what happens and why it matters.
export const EXPLAIN = {
  contract: 'The agent reads the story, drafts the plan and one Test Step per thing a user must be able to do, asks about the gaps and proposes a lane (how careful this change has to be). Nothing is built until you sign.',
  build: 'The plan is split into tasks. Worker agents of different strengths (Haiku, Sonnet, Opus) write the code test-first; the conductor accepts or returns each task.',
  quality: 'Linters run on the changed files only, and the diff is searched for shortcuts (skipped tests, swallowed errors, TODOs). Each signal is decided one by one.',
  test_review: 'Every changed line is broken on purpose (mutants). A test must fail for each one; a mutant that survives is a line no test protects.',
  verify: 'A second agent that never saw the code gets only the Test Steps, opens the app in a real browser, checks each one and keeps a screenshot as proof.',
  second_review: 'Another model, ideally from another company, tries to break the change and holds it to the repo\'s own standards. Real defects send the work back to build.',
  push: 'Only now is the story branch pushed, and only that branch.',
  copilot_review: 'GitHub Copilot reviews the pushed PR, and CI runs. The loop waits for both.',
  fix_comments: 'Clear defects from Copilot and CI are fixed and go back through the loop; open questions are parked for the human.',
  report: 'The evidence goes onto the PR: what was built, what proves it, what is still open. A human merges, never the agent.',
  retro: 'Every correction in this run (a send-back, a fixed finding) becomes a lesson in the ledger, with the check that would have caught it earlier.',
  human_review: 'After the run: a colleague\'s review comments are picked up with /story-loop review <story> and settled like any other finding.',
}
export const VERBS = { start: 'starts', pass: 'passed', skip: 'skipped', wait: 'waits', block: 'is blocked', back: 'sends the work back' }

// Fields of the final state that exist only once their stage has ended (passed, skipped or sent back).
const REVEAL = {
  contract: ['checks', 'checks_revision', 'lane', 'web_guidance', 'evidence_sharing'],
  build: ['tasks'],
  verify: ['browser', 'environment', 'verify_prior'],
  second_review: ['reviewer', 'review', 'reviews'],
  push: ['pushed', 'remote_url', 'pr_state', 'ready'],
  copilot_review: ['copilot', 'ci'],
  fix_comments: ['replies'],
  report: ['report'],
  retro: ['lessons'],
  human_review: ['human_review'],
}
const HIDDEN = new Set([...Object.values(REVEAL).flat(), 'findings', 'stages', 'history', 'owner', 'live_workers', 'ops', 'evidence'])
// Evidence keys by the stage that produced them; any other key belongs to verify.
const EVIDENCE_AT = { quality: 'quality', mutants: 'test_review' }
// The stage a finding's source reports in; any other source is a review angle or reviewer.
const FINDING_AT = { verify: 'verify', copilot: 'copilot_review', human: 'human_review' }

// The newest ended run of a story in <root>/.start-story/<story>/, with the feed it was
// archived with. An older run kept no feed: the shared feed is taken when it is this
// run's, else the stage moves are made from the start and end times each stage kept.
export function recording(root, story) {
  const dir = runDir(root, { story })
  let names = []
  try { names = readdirSync(dir) } catch { throw new Error(`no record of ${story} in ${dir}`) }
  const at = names.map(n => /^run-(\d+)\.json$/.exec(n)?.[1]).filter(Boolean).sort((a, b) => b - a)[0]
  if (!at) throw new Error(`${story} has no ended run in ${dir} (a run is kept there by loop.mjs end)`)
  const run = migrate(JSON.parse(readFileSync(join(dir, `run-${at}.json`), 'utf8')))
  const kept = join(dir, `events-${at}.jsonl`)
  const shared = paths(root).events
  let events = existsSync(kept) ? jsonl(kept) : []
  let from = 'archived feed'
  if (!events.length && existsSync(shared)) {
    const all = jsonl(shared)
    if (all[0]?.text === `run started for ${story}`) { events = all; from = 'shared feed' }
  }
  if (!events.some(e => e.kind === 'stage' && e.verb)) { events = stageMoves(run); from = 'stage times only' }
  return { run, events: events.filter(e => e.ts).sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts)), dir, from }
}

// No feed: one start and one end per stage, from the times the final state kept.
function stageMoves(run) {
  return GRAPH.stages.flatMap(({ id }) => {
    const st = run.stages?.[id]
    if (!st?.started_at) return []
    const end = { passed: 'pass', skipped: 'skip' }[st.status]
    return [{ ts: st.started_at, kind: 'stage', stage: id, verb: 'start' },
      ...(end && st.ended_at ? [{ ts: st.ended_at, kind: 'stage', stage: id, verb: end, text: st.reason }] : [])]
  })
}

const STATUS = { start: 'running', pass: 'passed', skip: 'skipped', wait: 'waiting', block: 'blocked' }
// The run as it stood after the first `upto` events: stages rebuilt by the same moves the
// loop made, the final state's other fields shown only once their stage has ended.
export function stateAt(final, events, upto) {
  let run = newRun(final.story, final.started_at)
  run.id = final.id
  const ended = new Set(), passed = new Set()
  for (const e of events.slice(0, upto)) {
    if (e.kind !== 'stage' || !e.verb || !e.stage) continue
    try { run = move(run, e.verb, e.stage, e.to, e.text, e.ts) } catch {
      // A move the graph refuses today (an older loop recorded it): show the status it reported.
      if (STATUS[e.verb]) run.stages[e.stage] = { ...run.stages[e.stage], status: STATUS[e.verb], waiting_on: e.verb === 'wait' ? e.to : undefined, reason: e.text, [e.verb === 'start' ? 'started_at' : 'ended_at']: e.ts }
    }
    if (['pass', 'skip', 'back'].includes(e.verb)) ended.add(e.stage)
    if (e.verb === 'pass') passed.add(e.stage)
  }
  const shown = Object.fromEntries(Object.entries(final).filter(([k]) => !HIDDEN.has(k)))
  for (const [stage, keys] of Object.entries(REVEAL)) if (ended.has(stage)) for (const k of keys) if (k in final) shown[k] = final[k]
  // Findings keep no time of their own. One shows once the feed names it (a send-back names
  // what it sends back), else once the stage it came from has passed. Its verdict is the final one.
  const said = events.slice(0, upto).filter(e => e.kind === 'stage' || e.kind === 'note').map(e => e.text ?? '').join(' ')
  const findings = (final.findings ?? []).filter(f => new RegExp(`(^|[^\\w])${String(f.id).replace(/[^\w-]/g, '')}($|[^\\w])`).test(said) ||
    passed.has(FINDING_AT[f.source] ?? 'second_review'))
  const evidence = Object.fromEntries(Object.entries(final.evidence ?? {}).filter(([k]) => ended.has(EVIDENCE_AT[k] ?? 'verify')))
  return { ...shown, stages: run.stages, history: run.history, evidence, findings, ended: [...ended] }
}
