import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkCommand, checkAgent } from '../skills/story-loop/scripts/hook.mjs'
import { newRun, save, load, move, readInbox, writeInbox } from '../skills/story-loop/scripts/loop.mjs'

const B = 'feat/sc-1-thing'
const on = { branch: B, currentBranch: B }
const off = { branch: B, currentBranch: 'main' }

test('pushes to the story branch pass', () => {
  for (const cmd of ['git push', 'git push origin', `git push -u origin ${B}`, `git push origin HEAD:${B}`, 'git push origin HEAD', `git add a && git push origin ${B}`])
    assert.equal(checkCommand(cmd, on), null, cmd)
  assert.equal(checkCommand(`git push origin ${B}`, off), null)
  assert.equal(checkCommand('git status && git log --oneline', on), null)
})

test('every other push is refused', () => {
  for (const cmd of ['git push origin main', `git push --force origin ${B}`, `git push -f`, `git push --force-with-lease origin ${B}`,
    'git push --all', 'git push --tags', `git push origin :${B}`, `git push origin --delete ${B}`, `git push upstream ${B}`,
    `git push origin ${B} main`, `git push origin HEAD:main`, `git -C ../other push`, `cd x; git push origin main`])
    assert.ok(checkCommand(cmd, on), cmd)
  for (const cmd of ['git push', 'git push origin HEAD', `git push origin HEAD:${B}`]) assert.ok(checkCommand(cmd, off), cmd)
  assert.match(checkCommand(`git push origin ${B}`, { branch: undefined, currentBranch: B }), /no story branch/)
})

test('merging is refused', () => {
  for (const cmd of ['gh pr merge 12 --squash', 'gh api -X PUT repos/o/r/pulls/12/merge'])
    assert.match(checkCommand(cmd, on), /never merges/)
  assert.equal(checkCommand('git merge origin/main', on), null)
  assert.equal(checkCommand('gh pr view 12', on), null)
})

test('the hook denies with exit 2, gates Stop, and is silent without a run', () => {
  const hook = fileURLToPath(new URL('../skills/story-loop/scripts/hook.mjs', import.meta.url))
  const fire = (cwd, input) => spawnSync('node', [hook], { input: JSON.stringify({ cwd, session_id: 's1', ...input }), encoding: 'utf8' })
  const empty = mkdtempSync(join(tmpdir(), 'sl-none-'))
  assert.equal(fire(empty, { hook_event_name: 'Stop' }).stdout, '')

  const root = mkdtempSync(join(tmpdir(), 'sl-run-'))
  mkdirSync(join(root, '.start-story'))
  save(root, { ...newRun('sc-1'), branch: B })
  const denied = fire(root, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'gh pr merge 1' } })
  assert.equal(denied.status, 2)
  assert.match(denied.stderr, /never merges/)
  fire(root, { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: join(root, 'app/a.rb') } })
  assert.equal(load(root).session, 's1')
  assert.match(readFileSync(join(root, '.start-story', 'events.jsonl'), 'utf8'), /"file":"app\/a.rb"/)
  assert.match(fire(root, { hook_event_name: 'Stop' }).stdout, /"decision":"block"/)
  assert.equal(fire(root, { hook_event_name: 'Stop', session_id: 'other' }).stdout, '')
})

test('a board note reaches the conductor once, never a worker', () => {
  const hook = fileURLToPath(new URL('../skills/story-loop/scripts/hook.mjs', import.meta.url))
  const root = mkdtempSync(join(tmpdir(), 'sl-note-'))
  mkdirSync(join(root, '.start-story'))
  save(root, { ...newRun('sc-1'), branch: B, session: 's1' })
  const fire = input => spawnSync('node', [hook], { input: JSON.stringify({ cwd: root, session_id: 's1', ...input }), encoding: 'utf8' }).stdout
  const note = { id: 'n1', kind: 'change', file: 'app/a.rb', text: 'Use a scope instead', status: 'queued' }

  writeInbox(root, [note])
  assert.equal(fire({ hook_event_name: 'PostToolUse', agent_id: 'worker-1' }), '')
  const injected = JSON.parse(fire({ hook_event_name: 'PostToolUse' })).hookSpecificOutput.additionalContext
  assert.match(injected, /\[n1\] change request · app\/a\.rb\n  Use a scope instead/)
  assert.equal(readInbox(root)[0].status, 'delivered')
  assert.equal(fire({ hook_event_name: 'PostToolUse' }), '')

  writeInbox(root, [note])
  save(root, move(load(root), 'wait', 'contract', 'human', 'sign-off'))
  assert.match(JSON.parse(fire({ hook_event_name: 'Stop' })).reason, /Use a scope instead/)
  assert.equal(fire({ hook_event_name: 'Stop' }), '')
  assert.match(readFileSync(join(root, '.start-story', 'events.jsonl'), 'utf8'), /"phase":"idle"/)
})

test('work is delegated to opus, sonnet or haiku, never to the conductor\'s model', () => {
  assert.equal(checkAgent({ subagent_type: 'story-loop:worker-opus-max' }), null)
  assert.equal(checkAgent({ subagent_type: 'worker-haiku' }), null)
  assert.equal(checkAgent({ subagent_type: 'general-purpose', model: 'opus' }), null)
  assert.equal(checkAgent({ subagent_type: 'Explore', model: 'haiku' }), null)
  assert.match(checkAgent({ subagent_type: 'general-purpose' }), /would inherit/)
  assert.match(checkAgent({}), /would inherit/)
  assert.match(checkAgent({ subagent_type: 'story-loop:worker-opus', model: 'fable' }), /opus, sonnet, haiku only/)
  assert.match(checkAgent({ subagent_type: 'savvy-flow:savvy-fable' }), /conductor's model/)
})

test('the conductor stays on its model: runs start on it and cannot switch away', () => {
  const hook = fileURLToPath(new URL('../skills/story-loop/scripts/hook.mjs', import.meta.url))
  const root = mkdtempSync(join(tmpdir(), 'sl-model-'))
  const fire = (session_id, input) => spawnSync('node', [hook], { input: JSON.stringify({ cwd: root, session_id, ...input }), encoding: 'utf8' })
  const init = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'node /x/scripts/loop.mjs init SC-1' } }
  const sid = `t${process.pid}`

  assert.equal(fire(`${sid}-unknown`, init).status, 0)
  fire(`${sid}-opus`, { hook_event_name: 'SessionStart', model: 'claude-opus-5-5' })
  assert.match(fire(`${sid}-opus`, init).stderr, /conductor runs on fable/)
  fire(`${sid}-opus`, { hook_event_name: 'PostModelSwitch', to_model: 'claude-fable-5-2' })
  assert.equal(fire(`${sid}-opus`, init).status, 0)

  mkdirSync(join(root, '.start-story'))
  save(root, { ...newRun('sc-1'), branch: B, session: sid })
  assert.equal(fire(sid, { hook_event_name: 'PreModelSwitch', to_model: 'claude-opus-5-5' }).status, 2)
  assert.equal(fire(sid, { hook_event_name: 'PreModelSwitch', to_model: 'claude-fable-5-2' }).status, 0)
  assert.equal(fire('someone-else', { hook_event_name: 'PreModelSwitch', to_model: 'claude-opus-5-5' }).status, 0)
  const spawn = model => fire(sid, { hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { subagent_type: 'general-purpose', description: 'verify', model } })
  assert.equal(spawn(undefined).status, 2)
  assert.equal(spawn('opus').status, 0)
})
