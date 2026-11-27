// The board's replay: an ended run played back from its record, never touching the repo's own state.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { repo } from './helpers.mjs'
import { newRun } from '../skills/story-loop/scripts/loop.mjs'
import { recording, stateAt } from '../skills/story-loop/board/replay.mjs'

const SERVER = fileURLToPath(new URL('../skills/story-loop/board/server.mjs', import.meta.url))
const wait = ms => new Promise(ok => setTimeout(ok, ms))
const at = s => `2026-11-26T07:${String(s).padStart(2, '0')}:00.000Z`

// An ended run of sc-1: contract and build passed, second review sent it back once, then passed.
function ended(dir, { feed = true } = {}) {
  const run = { ...newRun('sc-1', at(0)), title: 'Thing', base: 'main', checks: [{ id: '1', step: 1 }],
    tasks: [{ title: 't', status: 'accepted' }], findings: [{ id: 'r1', verdict: 'fixed' }, { id: 'r12', verdict: 'parked' }], report: { state: 'confirmed' },
    evidence: { quality: { commit: 'x' }, mutants: { killed: 1 } } }
  const events = [
    { ts: at(0), kind: 'stage', text: 'run started for sc-1' },
    { ts: at(1), kind: 'stage', stage: 'contract', verb: 'start' },
    { ts: at(2), kind: 'stage', stage: 'contract', verb: 'pass', text: 'signed off' },
    { ts: at(3), kind: 'stage', stage: 'build', verb: 'start' },
    { ts: at(4), kind: 'tool', agent: 'a1', tool: 'Edit', file: 'a.txt' },
    { ts: at(5), kind: 'stage', stage: 'build', verb: 'pass' },
    { ts: at(6), kind: 'stage', stage: 'quality', verb: 'start' },
    { ts: at(7), kind: 'stage', stage: 'quality', verb: 'pass' },
    { ts: at(8), kind: 'stage', stage: 'test_review', verb: 'start' },
    { ts: at(9), kind: 'stage', stage: 'second_review', verb: 'start' },
    { ts: at(10), kind: 'stage', stage: 'second_review', verb: 'back', to: 'build', text: 'r1' },
  ]
  run.stages.contract = { status: 'passed', started_at: at(1), ended_at: at(2), attempt: 1, rounds: 0 }
  run.stages.build = { status: 'running', started_at: at(11), attempt: 2, rounds: 1 }
  const story = join(dir, '.start-story', 'sc-1')
  mkdirSync(story, { recursive: true })
  writeFileSync(join(story, 'run-100.json'), JSON.stringify(run))
  if (feed) writeFileSync(join(story, 'events-100.jsonl'), events.map(e => JSON.stringify(e)).join('\n') + '\n')
  writeFileSync(join(story, 'results.json'), JSON.stringify({ request: 'q', results: [] }))
  return { run, events }
}

test('a replayed run shows what each stage produced only once that stage has ended', () => {
  const { dir } = repo()
  ended(dir)
  const rec = recording(dir, 'sc-1')
  assert.equal(rec.from, 'archived feed')
  const before = stateAt(rec.run, rec.events, 2)
  assert.equal(before.stages.contract.status, 'running')
  assert.equal(before.checks, undefined, 'the check list belongs to the signed contract')
  assert.equal(before.tasks, undefined)
  assert.equal(before.report, undefined, 'the final report never shows early')
  assert.deepEqual(before.evidence, {})
  const built = stateAt(rec.run, rec.events, 8)
  assert.equal(built.stages.build.status, 'passed')
  assert.deepEqual(built.checks, rec.run.checks)
  assert.deepEqual(built.evidence, { quality: { commit: 'x' } }, 'mutants belong to test review, not yet ended')
  assert.deepEqual(built.findings, [])
  const back = stateAt(rec.run, rec.events, rec.events.length)
  assert.equal(back.stages.build.status, 'pending', 'the send-back reopened build, as the loop did')
  assert.deepEqual(back.findings.map(f => f.id), ['r1'], 'a finding shows once the feed names it; r12 waits for the review to pass')
})

test('a run that kept no feed is played from the times its stages kept', () => {
  const { dir } = repo()
  ended(dir, { feed: false })
  const rec = recording(dir, 'sc-1')
  assert.equal(rec.from, 'stage times only')
  assert.deepEqual(rec.events.map(e => `${e.stage}:${e.verb}`), ['contract:start', 'contract:pass', 'build:start'])
})

test('the replay server steps stage by stage and never writes into the repo', async t => {
  const { dir } = repo()
  ended(dir)
  const own = readdirSync(join(dir, '.start-story'))
  const port = 44000 + (process.pid % 1000)
  const server = spawn('node', [SERVER, '--replay', 'sc-1', '--root', dir, '--port', String(port), '--no-open'], { stdio: 'ignore' })
  t.after(() => server.kill())
  await wait(700)
  const base = `http://127.0.0.1:${port}`
  const act = action => fetch(`${base}/api/replay`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action }) }).then(r => r.json())

  let s = await act('next')
  assert.deepEqual([s.at, s.stage, s.verb], [2, 'contract', 'start'], 'next stops on the next stage move')
  assert.match(s.explain, /contract|plan/i)
  s = await act('next'); s = await act('next')
  assert.deepEqual([s.at, s.stage, s.verb], [4, 'build', 'start'])
  s = await act('next')
  assert.deepEqual([s.at, s.stage, s.verb], [6, 'build', 'pass'], 'the tool event in between plays on the way')
  s = await act('back')
  assert.deepEqual([s.at, s.stage, s.verb], [4, 'build', 'start'])
  s = await act('restart')
  assert.equal(s.at, 0)
  assert.equal((await fetch(`${base}/api/replay`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"action":"jump"}' })).status, 400)
  const explain = await fetch(`${base}/api/explain`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: 'quiz' }) })
  assert.equal(explain.status, 503, 'explanations would read today\'s code, not the run\'s')

  assert.deepEqual(readdirSync(join(dir, '.start-story')), own, 'the repo\'s .start-story is untouched')
  assert.equal(existsSync(join(dir, '.start-story', 'active.json')), false)
})
