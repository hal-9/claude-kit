import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newRun, move, current, stopReason, GRAPH, verifyProblem, resultsFile, evidenceDir, storyId } from '../skills/story-loop/scripts/loop.mjs'

const done = (run, ...stages) => stages.reduce((r, s) => move(move(r, 'start', s), 'pass', s), run)

test('a run starts from a Shortcut story or a GitHub issue', () => {
  for (const input of ['SC-123', 'sc-123', '123', 'https://app.shortcut.com/acme/story/123/some-title']) assert.equal(storyId(input), 'sc-123', input)
  for (const input of ['gh-45', 'GH-45', '#45', 'https://github.com/acme/app/issues/45']) assert.equal(storyId(input), 'gh-45', input)
  for (const input of ['', 'setup', 'https://github.com/acme/app/pull/45']) assert.equal(storyId(input), null, input)
})

test('stages run in graph order only', () => {
  const run = newRun('sc-1')
  assert.equal(current(run), 'contract')
  assert.throws(() => move(run, 'start', 'build'), /not the current stage/)
  assert.throws(() => move(run, 'pass', 'contract'), /not running/)
  assert.equal(current(done(run, 'contract')), 'build')
})

test('back follows graph edges, resets later stages and is capped', () => {
  let run = done(newRun('sc-1'), 'contract', 'build', 'test_review', 'verify')
  run = move(run, 'start', 'second_review')
  assert.throws(() => move(run, 'back', 'second_review', 'contract', 'x'), /no edge/)
  assert.throws(() => move(run, 'back', 'second_review', 'build'), /needs a reason/)
  run = move(run, 'back', 'second_review', 'build', 'nil guard missing')
  assert.equal(current(run), 'build')
  assert.equal(run.stages.verify.status, 'pending')
  assert.equal(run.stages.build.rounds, 1)
  run.stages.build.rounds = GRAPH.maxRounds
  run = move(done(run, 'build'), 'start', 'test_review')
  assert.throws(() => move(run, 'back', 'test_review', 'build', 'again'), /show the human/)
})

test('a human can send a finished run back, and is not capped', () => {
  let run = done(newRun('sc-1'), ...GRAPH.stages.map(s => s.id))
  assert.throws(() => move(run, 'back', 'verify', 'build', 'human: x'), /not the current stage/)
  run.stages.build.rounds = GRAPH.maxRounds
  run = move(run, 'back', 'report', 'build', 'human: use a scope')
  assert.equal(current(run), 'build')
  assert.equal(run.stages.build.rounds, GRAPH.maxRounds)
})

test('verify and second_review cannot be skipped by the agent on its own', () => {
  let run = done(newRun('sc-1'), 'contract', 'build', 'test_review')
  assert.throws(() => move(run, 'skip', 'verify', undefined, 'no browser available'), /a wait, not a skip/)
  run = move(run, 'skip', 'verify', undefined, 'human: migration only, no page')
  assert.throws(() => move(run, 'skip', 'second_review', undefined, 'human: skip it'), /never skipped/)
})

test('verify only passes on results where every check passed and has its screenshot', () => {
  const root = mkdtempSync(join(tmpdir(), 'sl-verify-'))
  const run = newRun('sc-1')
  const write = results => writeFileSync(resultsFile(root, run), JSON.stringify(results))
  mkdirSync(evidenceDir(root, run), { recursive: true })
  assert.match(verifyProblem(root, run), /has not reported/)
  write([{ step: 1, verdict: 'fail', evidence: ['a.png'] }])
  assert.match(verifyProblem(root, run), /step 1 is "fail"/)
  write([{ step: 1, case: 'UK', verdict: 'pass', evidence: [] }])
  assert.match(verifyProblem(root, run), /step 1 \(UK\) has no screenshot/)
  write([{ step: 1, verdict: 'pass', evidence: ['a.png'] }])
  assert.match(verifyProblem(root, run), /a\.png does not exist/)
  writeFileSync(join(evidenceDir(root, run), 'a.png'), 'x')
  assert.equal(verifyProblem(root, run), null)
})

test('the stop gate holds until a stage waits, blocks, or all are done', () => {
  let run = newRun('sc-1')
  assert.match(stopReason(run), /stage "contract" is pending/)
  run = move(run, 'wait', 'contract', 'human', 'sign-off')
  assert.equal(stopReason(run), null)
  assert.throws(() => move(run, 'wait', 'contract', 'nobody', 'x'), /human \| copilot/)
  const all = done(newRun('sc-1'), ...GRAPH.stages.map(s => s.id))
  assert.equal(current(all), null)
  assert.equal(stopReason(all), null)
})
