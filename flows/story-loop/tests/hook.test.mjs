import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkCommand, checkAgent } from '../skills/story-loop/scripts/hook.mjs'
import { newRun, save, load, move, readInbox, writeInbox, LEASE_MS } from '../skills/story-loop/scripts/loop.mjs'
import { B } from './helpers.mjs'

const HOOK = fileURLToPath(new URL('../skills/story-loop/scripts/hook.mjs', import.meta.url))
const fire = (cwd, input, env = {}) => spawnSync('node', [HOOK], { input: JSON.stringify({ cwd, session_id: 's1', ...input }), encoding: 'utf8', env: { ...process.env, ...env } })
const bash = command => ({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } })
function runDirWith(patch = {}) {
  const root = mkdtempSync(join(tmpdir(), 'sl-run-'))
  mkdirSync(join(root, '.start-story'))
  save(root, { ...newRun('sc-1'), branch: B, ...patch })
  return root
}
const owned = (session = 's1', heartbeat = Date.now()) => ({ owner: { session, since: 'x', heartbeat } })

test('raw pushes are refused during a run; publish.mjs is the way', () => {
  for (const cmd of ['git push', 'git push origin', `git push -u origin ${B}`, `git push -uf origin ${B}`, 'git push --follow-tags',
    `git -C ../other push`, `git -c push.default=matching push`, 'git --git-dir .git push', 'git --work-tree . push origin', `cd x; git push origin main`, `git add a && git push origin ${B}`])
    assert.match(checkCommand(cmd), /publish\.mjs/, cmd)
  for (const cmd of ['git status && git log --oneline', 'git stash push -m wip', 'git commit -m "fix the push guard"', 'node publish.mjs', 'git merge origin/main'])
    assert.equal(checkCommand(cmd), null, cmd)
})

test('merging and marking ready are refused in every plain spelling', () => {
  for (const cmd of ['gh pr merge 12 --squash', 'gh --repo a/b pr merge 1', 'gh -R a/b pr merge 1 --auto', 'gh pr ready 12',
    'gh api -X PUT repos/o/r/pulls/12/merge', 'gh api graphql -f query="mutation{markPullRequestReadyForReview(input:{})}"',
    'gh api graphql -f query="mutation{mergePullRequest(input:{})}"'])
    assert.match(checkCommand(cmd), /never merges/, cmd)
  assert.equal(checkCommand('gh pr view 12'), null)
  assert.equal(checkCommand('gh pr edit 12 --add-reviewer @copilot'), null)
})

test('the hook denies with exit 2, gates Stop, and is silent without a run', () => {
  const empty = mkdtempSync(join(tmpdir(), 'sl-none-'))
  assert.equal(fire(empty, { hook_event_name: 'Stop' }).stdout, '')
  const root = runDirWith()
  const denied = fire(root, bash('gh pr merge 1'))
  assert.equal(denied.status, 2)
  assert.match(denied.stderr, /never merges/)
  fire(root, bash('node loop.mjs status'))
  assert.equal(load(root).owner.session, 's1')
  fire(root, { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: join(root, 'app/a.rb') } })
  assert.match(readFileSync(join(root, '.start-story', 'events.jsonl'), 'utf8'), /"file":"app\/a.rb"/)
  assert.match(fire(root, { hook_event_name: 'Stop' }).stdout, /"decision":"block"/)
  assert.equal(fire(root, { hook_event_name: 'Stop', session_id: 'other' }).stdout, '')
})

test('an unrelated session or the board explainer never claims the run', () => {
  const root = runDirWith()
  fire(root, { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: join(root, 'a') } })
  assert.equal(load(root).owner, null)
  fire(root, bash('node loop.mjs status'), { STORY_LOOP_EXPLAINER: '1' })
  assert.equal(load(root).owner, null)
})

test('the conductor may go idle while its workers run, and is held again once they are done', () => {
  const root = runDirWith(owned())
  fire(root, { hook_event_name: 'SubagentStart', agent_id: 'w1', agent_type: 'story-loop:worker-opus' })
  fire(root, { hook_event_name: 'SubagentStart', agent_id: 'w2', agent_type: 'story-loop:worker-opus' })
  assert.equal(fire(root, { hook_event_name: 'Stop' }).stdout, '', 'two workers running: idle is how it waits for their reports')
  fire(root, { hook_event_name: 'SubagentStop', agent_id: 'w1' })
  assert.equal(fire(root, { hook_event_name: 'Stop' }).stdout, '')
  fire(root, { hook_event_name: 'SubagentStop', agent_id: 'w2' })
  assert.match(fire(root, { hook_event_name: 'Stop' }).stdout, /"decision":"block"/, 'all reports are in: review them now')
  assert.equal(load(root).stop_blocks, 1, 'waiting on workers never counted toward the stop gate')

  // A worker that died without a SubagentStop stops holding the gate open after an hour.
  const stale = runDirWith({ ...owned(), live_workers: { ghost: Date.now() - 61 * 60_000 } })
  assert.match(fire(stale, { hook_event_name: 'Stop' }).stdout, /"decision":"block"/)
})

test('another session in the checkout neither shows on the board nor is refused for reading the scripts', () => {
  const root = runDirWith(owned('owner'))
  const events = () => { try { return readFileSync(join(root, '.start-story', 'events.jsonl'), 'utf8') } catch { return '' } }
  fire(root, { ...bash('grep -n reply scripts/github.mjs scripts/quality.mjs'), session_id: 'visitor' })
  assert.doesNotMatch(events(), /grep -n reply/)
  assert.equal(fire(root, { ...bash('sed -n 1,20p scripts/mutate.mjs'), session_id: 'visitor' }).status, 0)
  const write = fire(root, { ...bash('node scripts/github.mjs reply --map r.json'), session_id: 'visitor' })
  assert.equal(write.status, 2)
  assert.match(write.stderr, /acquire first/)
  fire(root, { hook_event_name: 'SubagentStart', agent_id: 'w9', session_id: 'visitor' })
  assert.equal(load(root).live_workers, undefined, 'a visitor\'s helpers are not the run\'s workers')
})

test('a fourth unproductive Stop gives way and records the stage as blocked', () => {
  const root = runDirWith(owned())
  for (let i = 0; i < 3; i++) assert.match(fire(root, { hook_event_name: 'Stop' }).stdout, /"decision":"block"/)
  assert.equal(fire(root, { hook_event_name: 'Stop' }).stdout, '')
  const run = load(root)
  assert.equal(run.stages.contract.status, 'blocked')
  assert.match(run.stages.contract.reason, /stop gate/)
})

test('ownership: a live owner cannot be displaced silently; an expired lease or an explicit takeover moves it', () => {
  const root = runDirWith(owned('old'))
  for (const cmd of ['node loop.mjs start contract', 'node /p/publish.mjs', 'node /p/github.mjs report --body-file r.md', 'node /p/mutate.mjs --test x a.js']) {
    const write = fire(root, bash(cmd))
    assert.equal(write.status, 2, cmd)
    assert.match(write.stderr, /belongs to session old/)
  }
  const refused = fire(root, bash('node loop.mjs acquire'))
  assert.equal(refused.status, 2)
  assert.match(refused.stderr, /--takeover/)
  assert.equal(load(root).owner.session, 'old')
  assert.equal(fire(root, bash('node loop.mjs acquire --takeover "old session crashed"')).status, 0)
  assert.equal(load(root).owner.session, 's1')

  const expired = runDirWith(owned('old', Date.now() - LEASE_MS - 1000))
  assert.match(JSON.parse(fire(expired, { hook_event_name: 'SessionStart' }).stdout).hookSpecificOutput.additionalContext, /lease expired.*acquire/)
  assert.equal(fire(expired, { hook_event_name: 'Stop' }).stdout, '')
  assert.equal(fire(expired, bash('node loop.mjs acquire')).status, 0)
  assert.equal(load(expired).owner.session, 's1')
  assert.match(fire(expired, { hook_event_name: 'Stop' }).stdout, /"decision":"block"/)
})

test('a fresh session that acquired the run gets its notes', () => {
  const root = runDirWith(owned('old', 0))
  writeInbox(root, load(root), [{ id: 'n1', kind: 'note', text: 'hello', status: 'queued' }])
  assert.equal(fire(root, { hook_event_name: 'PostToolUse' }).stdout, '')
  fire(root, bash('node loop.mjs acquire'))
  assert.match(fire(root, { hook_event_name: 'PostToolUse' }).stdout, /hello/)
})

test('an unreadable state refuses outward commands and keeps harmless ones working', () => {
  const root = runDirWith()
  writeFileSync(join(root, '.start-story', 'active.json'), '{oops')
  const push = fire(root, bash('gh pr merge 1'))
  assert.equal(push.status, 2)
  assert.match(push.stderr, /unreadable.*recovered/)
  assert.equal(fire(root, bash('gh pr create --draft')).status, 2)
  assert.equal(fire(root, bash('git status')).status, 0)
  assert.equal(fire(root, bash('node loop.mjs recover')).status, 0)
})

test('a board note reaches the conductor once, never a worker', () => {
  const root = runDirWith(owned())
  const run = load(root)
  const once = input => fire(root, input).stdout
  const note = { id: 'n1', kind: 'change', file: 'app/a.rb', text: 'Use a scope instead', status: 'queued' }

  writeInbox(root, run, [note])
  assert.equal(once({ hook_event_name: 'PostToolUse', agent_id: 'worker-1' }), '')
  const injected = JSON.parse(once({ hook_event_name: 'PostToolUse' })).hookSpecificOutput.additionalContext
  assert.match(injected, /\[n1\] change request · app\/a\.rb\n  Use a scope instead/)
  assert.equal(readInbox(root, run)[0].status, 'delivered')
  assert.equal(once({ hook_event_name: 'PostToolUse' }), '')

  writeInbox(root, run, [note])
  save(root, move(load(root), 'wait', 'contract', 'human', 'sign-off'))
  assert.match(JSON.parse(once({ hook_event_name: 'Stop' })).reason, /Use a scope instead/)
  assert.equal(once({ hook_event_name: 'Stop' }), '')
  assert.match(readFileSync(join(root, '.start-story', 'events.jsonl'), 'utf8'), /"phase":"idle"/)
})

test('work is delegated to the four worker profiles or a named delegate model, never the conductor\'s', () => {
  assert.equal(checkAgent({ subagent_type: 'story-loop:worker-opus-max' }), null)
  assert.equal(checkAgent({ subagent_type: 'worker-haiku' }), null)
  assert.equal(checkAgent({ subagent_type: 'worker-sonnet', model: 'sonnet' }), null)
  assert.equal(checkAgent({ subagent_type: 'general-purpose', model: 'opus' }), null)
  assert.equal(checkAgent({ subagent_type: 'Explore', model: 'haiku' }), null)
  assert.match(checkAgent({ subagent_type: 'worker-opus-max', model: 'haiku' }), /defined on opus/)
  assert.match(checkAgent({ subagent_type: 'worker-evil' }), /would inherit/)
  assert.match(checkAgent({ subagent_type: 'general-purpose' }), /would inherit/)
  assert.match(checkAgent({}), /would inherit/)
  assert.match(checkAgent({ subagent_type: 'story-loop:worker-opus', model: 'fable' }), /opus, sonnet, haiku only/)
  assert.match(checkAgent({ subagent_type: 'general-purpose', model: 'fable' }), /opus, sonnet, haiku only.*advisor-fable/)
  assert.match(checkAgent({ subagent_type: 'savvy-flow:savvy-fable' }), /use story-loop:advisor-fable/)
  // Fable thinks only as the read-only advisor.
  assert.equal(checkAgent({ subagent_type: 'story-loop:advisor-fable' }), null)
  assert.equal(checkAgent({ subagent_type: 'advisor-fable', model: 'fable' }), null)
  assert.match(checkAgent({ subagent_type: 'story-loop:advisor-fable', model: 'opus' }), /defined on fable/)
})

test('the conductor stays on its model: runs start on it and cannot switch away', () => {
  const root = mkdtempSync(join(tmpdir(), 'sl-model-'))
  const as = (session_id, input) => fire(root, { session_id, ...input })
  const init = bash('node /x/scripts/loop.mjs init SC-1')
  const sid = `t${process.pid}`

  assert.equal(as(`${sid}-unknown`, init).status, 0)
  as(`${sid}-fable`, { hook_event_name: 'SessionStart', model: 'claude-fable-5-2' })
  assert.match(as(`${sid}-fable`, init).stderr, /conductor runs on opus/)
  as(`${sid}-fable`, { hook_event_name: 'PostModelSwitch', to_model: 'claude-opus-5-5' })
  assert.equal(as(`${sid}-fable`, init).status, 0)

  mkdirSync(join(root, '.start-story'))
  save(root, { ...newRun('sc-1'), branch: B, ...owned(sid) })
  assert.equal(as(sid, { hook_event_name: 'PreModelSwitch', to_model: 'claude-fable-5-2' }).status, 2)
  assert.equal(as(sid, { hook_event_name: 'PreModelSwitch', to_model: 'claude-opus-5-5' }).status, 0)
  assert.equal(as('someone-else', { hook_event_name: 'PreModelSwitch', to_model: 'claude-fable-5-2' }).status, 0)
  const spawn = model => as(sid, { hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { subagent_type: 'general-purpose', description: 'verify', model } })
  assert.equal(spawn(undefined).status, 2)
  assert.equal(spawn('opus').status, 0)
})

test('the session that ran init owns the new run at once', () => {
  const root = runDirWith()
  fire(root, { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'node /x/loop.mjs init SC-1' } })
  assert.equal(load(root).owner.session, 's1')
  assert.match(fire(root, { hook_event_name: 'Stop' }).stdout, /"decision":"block"/)
})

// ---- regressions from the 0.7.0 reliability review ------------------------------

test('H17: a worker\'s activity renews the lease, and after a takeover the old session\'s edits are refused', () => {
  const stale = Date.now() - LEASE_MS + 60_000 // one quiet minute from expiring
  const root = runDirWith(owned('s1', stale))
  const edit = (session, agent_id) => fire(root, { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: join(root, 'app/a.rb') }, session_id: session, agent_id })
  // the conductor waits on a worker; only the worker makes tool calls
  fire(root, { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: join(root, 'a') }, agent_id: 'w1', agent_type: 'story-loop:worker-opus' })
  assert.ok(load(root).owner.heartbeat > Date.now() - 5000, 'the worker call renewed the lease')
  assert.equal(load(root).owner.session, 's1')
  const refused = fire(root, bash('node loop.mjs acquire'), { }) // from s1 itself: nothing to do
  assert.equal(refused.status, 0)
  const other = spawnSync('node', [HOOK], { input: JSON.stringify({ cwd: root, session_id: 's2', ...bash('node loop.mjs acquire') }), encoding: 'utf8' })
  assert.equal(other.status, 2, 'an active run is not taken silently')
  assert.equal(edit('s1', 'w1').status, 0)
  // the human moves the run to s2
  spawnSync('node', [HOOK], { input: JSON.stringify({ cwd: root, session_id: 's2', ...bash('node loop.mjs acquire --takeover "human: continue here"') }), encoding: 'utf8' })
  assert.deepEqual([load(root).owner.session, load(root).retired], ['s2', ['s1']])
  const late = edit('s1', 'w1')
  assert.equal(late.status, 2)
  assert.match(late.stderr, /session s2 took over run sc-1; this session and its workers no longer change its code/)
  assert.equal(edit('s1', undefined).status, 2, 'the old conductor too')
  assert.equal(fire(root, { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: join(root, 'a') } }).status, 0, 'reading is still fine')
  assert.equal(edit('s2', 'w9').status, 0)
  assert.equal(edit('s3', undefined).status, 0, 'a session that never owned the run is not retired')
  // taking it back un-retires it
  fire(root, bash('node loop.mjs acquire --takeover "human: back to the first session"'))
  assert.deepEqual([load(root).owner.session, load(root).retired], ['s1', ['s2']])
  assert.equal(edit('s1', 'w1').status, 0)
})

// ---- regressions from the 0.8.0 review -------------------------------------------

test('R7: a note handed to a session that never finished it is handed to the next owner, once', () => {
  const LOOP = fileURLToPath(new URL('../skills/story-loop/scripts/loop.mjs', import.meta.url))
  const root = runDirWith(owned('A'))
  writeInbox(root, load(root), [
    { id: 'n1', kind: 'change', text: 'Use a scope instead', status: 'queued' },
    { id: 'n2', kind: 'note', text: 'Already handled', status: 'done', result: 'renamed it' }])
  const post = session => fire(root, { hook_event_name: 'PostToolUse', session_id: session }).stdout
  const take = session => fire(root, { ...bash(`node loop.mjs acquire --takeover "human: continue in ${session}"`), session_id: session })
  const inbox = () => spawnSync('node', [LOOP, 'inbox'], { cwd: root, encoding: 'utf8' }).stdout
  // the reviewed reproduction: delivered to A, not done, then B acquires the run
  assert.match(post('A'), /Use a scope instead/)
  assert.equal(post('A'), '')
  assert.deepEqual([readInbox(root, load(root))[0].status, readInbox(root, load(root))[0].delivered_to], ['delivered', 'A'])
  assert.equal(take('B').status, 0)
  assert.equal(load(root).owner.generation, 1)
  const again = JSON.parse(post('B')).hookSpecificOutput.additionalContext
  assert.match(again, /\[n1\] change request\n  Use a scope instead/, 'the same id, so a note handled twice is recognised')
  assert.doesNotMatch(again, /n2|Already handled/, 'a finished note is never handed over as new work')
  assert.equal(post('B'), '', 'once per owner')
  assert.equal(readInbox(root, load(root))[0].delivered_to, 'B')
  assert.match(inbox(), /\[n1\]/, 'and loop.mjs inbox lists it either way')
  // B stops without handling it and C takes over: the stop gate hands it to C as well
  assert.equal(take('C').status, 0)
  assert.match(JSON.parse(fire(root, { hook_event_name: 'Stop', session_id: 'C' }).stdout).reason, /Use a scope instead/)
  assert.equal(post('C'), '')
  // handled: no later owner hears of it again
  assert.equal(spawnSync('node', [LOOP, 'note', 'done', 'n1', 'used a scope'], { cwd: root }).status, 0)
  assert.equal(take('D').status, 0)
  assert.equal(post('D'), '')
  assert.equal(inbox(), 'no open notes\n')
})

test('H20: notes the hook cannot read are said to the conductor, not treated as none', () => {
  const root = runDirWith(owned())
  writeInbox(root, load(root), [{ id: 'n1', status: 'queued', kind: 'note', text: 'use a scope' }])
  writeFileSync(join(root, '.start-story', 'sc-1', 'inbox.json'), '[{"id":"n1","te')
  const out = fire(root, { hook_event_name: 'PostToolUse', tool_name: 'Read' })
  assert.equal(out.status, 0)
  assert.match(JSON.parse(out.stdout).hookSpecificOutput.additionalContext, /notes file .* is unreadable.*Tell the human/s)
})

test('the conductor may also go idle while the loop\'s own helpers run, or when it records a background wait', () => {
  // A helper whose process lives (this test process) holds the gate open; a dead one does not.
  const helping = runDirWith({ ...owned(), ops: { op1: { kind: 'mutate', stage: 'contract', attempt: 1, pid: process.pid, started_at: 'x' } } })
  assert.equal(fire(helping, { hook_event_name: 'Stop' }).stdout, '', 'mutants running in the background: idle is how it waits')
  const gone = runDirWith({ ...owned(), ops: { op1: { kind: 'mutate', stage: 'contract', attempt: 1, pid: 2 ** 22 + 12345, started_at: 'x' } } })
  assert.match(fire(gone, { hook_event_name: 'Stop' }).stdout, /"decision":"block"/)
  // Anything else in the background is recorded as a wait, which the gate accepts.
  const codex = runDirWith(owned())
  const run = move(move(load(codex), 'start', 'contract'), 'wait', 'contract', 'background', 'codex review running')
  save(codex, run)
  assert.equal(fire(codex, { hook_event_name: 'Stop' }).stdout, '')
  assert.throws(() => move(load(gone), 'wait', 'contract', 'nobody', 'x'), /human \| copilot \| background/)
})
