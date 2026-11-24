// The board server with a fake `claude` on PATH: what the explainer may use, and that cancelling stops it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { repo, withRun, PNG, ENV, META } from './helpers.mjs'
import { mkdirSync } from 'node:fs'
import { resultsFile, evidenceDir, load, update, addNote, verifyRequest, verifyProblem } from '../skills/story-loop/scripts/loop.mjs'

const SERVER = fileURLToPath(new URL('../skills/story-loop/board/server.mjs', import.meta.url))
const bin = mkdtempSync(join(tmpdir(), 'sl-fakeclaude-'))
const ARGS = join(bin, 'args.json')
const PID = join(bin, 'pid')
writeFileSync(join(bin, 'claude'), `#!/usr/bin/env node
require('fs').writeFileSync(${JSON.stringify(ARGS)}, JSON.stringify({ args: process.argv.slice(2), explainer: process.env.STORY_LOOP_EXPLAINER }))
require('fs').writeFileSync(${JSON.stringify(PID)}, String(process.pid))
process.stdout.write('thinking...')
setTimeout(() => {}, 60000)
`)
chmodSync(join(bin, 'claude'), 0o755)

const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }
const wait = ms => new Promise(ok => setTimeout(ok, ms))

test('the explainer has only read tools, no MCP servers, and stops when the page cancels', async t => {
  const { dir, commit } = repo()
  withRun(dir)
  commit('a.txt', 'changed')
  const port = 43000 + (process.pid % 1000)
  const server = spawn('node', [SERVER, '--root', dir, '--port', String(port)], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, stdio: 'ignore' })
  t.after(() => server.kill())
  await wait(600)
  const base = `http://127.0.0.1:${port}`

  const foreign = await fetch(`${base}/api/steer`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: '{}' })
  assert.equal(foreign.status, 403)

  const abort = new AbortController()
  const res = await fetch(`${base}/api/explain`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ file: 'a.txt', question: 'explain' }), signal: abort.signal })
  assert.equal(res.status, 200)
  assert.ok(res.headers.get('x-story-loop-head'))
  const reader = res.body.getReader()
  await reader.read()
  const pid = Number(readFileSync(PID, 'utf8'))
  assert.ok(alive(pid))
  const { args, explainer } = JSON.parse(readFileSync(ARGS, 'utf8'))
  assert.equal(args[args.indexOf('--tools') + 1], 'Read,Grep,Glob')
  assert.ok(args.includes('--strict-mcp-config'))
  assert.equal(explainer, '1')
  abort.abort()
  for (let i = 0; i < 20 && alive(pid); i++) await wait(100)
  assert.equal(alive(pid), false)
  assert.ok(existsSync(ARGS))
})

// ---- regressions from the 0.7.0 reliability review ------------------------------

// The board's event stream, as text that grows; until() waits for something to show up in it.
async function stream(base) {
  const res = await fetch(`${base}/events`)
  const reader = res.body.getReader()
  const state = { text: '' }
  ;(async () => { try { for (;;) { const { done, value } = await reader.read(); if (done) break; state.text += Buffer.from(value).toString() } } catch {} })()
  const until = async (pattern, ms = 4000) => { for (let i = 0; i < ms / 50 && !pattern.test(state.text); i++) await wait(50); return pattern.test(state.text) }
  return { state, until, close: () => reader.cancel().catch(() => {}) }
}
async function board(t, dir, offset) {
  const port = 44000 + offset + (process.pid % 1000)
  const server = spawn('node', [SERVER, '--root', dir, '--port', String(port)], { stdio: 'ignore' })
  t.after(() => server.kill())
  await wait(600)
  return { server, base: `http://127.0.0.1:${port}` }
}

// What a page that opens now is told: the first message of a fresh stream.
async function snapshot(base) {
  const events = await stream(base)
  assert.ok(await events.until(/"type":"snapshot".*\n\n/s))
  events.close()
  return JSON.parse(events.state.text.match(/data: (.*)/)[1])
}

// ---- regressions from the 0.8.0 review -------------------------------------------

test('R6: the board counts a check only when the gate accepts it, and celebrates only on the gate\'s yes', async t => {
  const { dir, git, commit } = repo()
  const checks = [{ id: 'a', step: 1 }, { id: 'b', step: 2, case: 'mobile' }]
  let run = withRun(dir, { checks, checks_revision: 1, environment: ENV, browser: 'chrome' })
  const request = verifyRequest(run, git('rev-parse', 'HEAD^{tree}'), git('rev-parse', 'HEAD'))
  run = update(dir, r => { for (const id of ['contract', 'build', 'test_review']) r.stages[id].status = 'passed'; Object.assign(r.stages.verify, { status: 'blocked', reason: 'the verifier lost its browser', request }); return r })
  mkdirSync(evidenceDir(dir, run), { recursive: true })
  for (const id of ['a', 'b']) writeFileSync(join(evidenceDir(dir, run), `${id}.png`), PNG)
  const row = (id, more = {}) => ({ ...checks.find(c => c.id === id), verdict: 'pass', evidence: [`${id}.png`], ...META, ...more })
  const write = (id, rows) => writeFileSync(resultsFile(dir, run), JSON.stringify({ request: id, results: rows }))
  const { base } = await board(t, dir, 3)
  const seen = async () => { const s = await snapshot(base); return { tested: s.tested, rows: s.results.map(r => [r.id, r.verdict, r.accepted, r.rejected]) } }

  // the reviewed reproduction: verify is blocked, results.json holds passes written for an old request
  write('an-earlier-request', [row('a'), row('b')])
  assert.match(verifyProblem(dir, load(dir)), /belong to another attempt/, 'the gate refuses them')
  let view = await seen()
  assert.deepEqual([view.tested.accepted, view.tested.total, view.tested.reported, view.tested.current, view.tested.all_accepted], [0, 2, 2, false, false])
  assert.deepEqual([view.tested.request, view.tested.results_request], [request.id, 'an-earlier-request'])
  for (const [id, verdict, accepted, rejected] of view.rows) {
    assert.deepEqual([verdict, accepted], ['pass', false], `${id} is still shown as what the verifier reported`)
    assert.match(rejected, /carry request "an-earlier-request", not this attempt's/, 'with the reason it does not count')
  }
  // a duplicate, an invented id and a row that is no object, under the current request
  write(request.id, [row('a'), row('a'), row('a', { id: 'invented' }), 'nonsense'])
  view = await seen()
  assert.deepEqual([view.tested.accepted, view.tested.all_accepted], [0, false])
  assert.match(view.rows[0][3], /reported twice/)
  assert.match(view.rows[2][3], /not in the approved check list/)
  assert.deepEqual(view.rows[3].slice(1, 3), ['blocked', false])
  // current results, one without its screenshot and one without the URL it ended on
  write(request.id, [row('a', { evidence: ['gone.png'] }), row('b', { url: undefined })])
  view = await seen()
  assert.deepEqual([view.tested.accepted, view.tested.current, view.tested.all_accepted], [0, true, false])
  assert.match(view.rows[0][3], /screenshot gone\.png does not exist/)
  assert.match(view.rows[1][3], /does not record the URL/)
  // one of two accepted is one of two, never "all"
  write(request.id, [row('a'), row('b', { verdict: 'fail' })])
  view = await seen()
  assert.deepEqual([view.tested.accepted, view.tested.all_accepted, view.rows[1].slice(1)], [1, false, ['fail', false, null]])
  // fresh, complete, current: accepted, and the page may celebrate
  write(request.id, [row('a'), row('b')])
  assert.equal(verifyProblem(dir, load(dir)), null)
  view = await seen()
  assert.deepEqual(view.tested, { request: request.id, results_request: request.id, current: true, accepted: 2, total: 2, reported: 2, problem: null, all_accepted: true, provenance: 'local-checkout' })
  assert.deepEqual(view.rows, [['a', 'pass', true, null], ['b', 'pass', true, null]])
  // the same files after a new commit: the evidence is for older code
  update(dir, r => { Object.assign(r.stages.verify, { status: 'passed', tree: request.tree }); return r })
  assert.equal((await seen()).tested.all_accepted, true)
  commit()
  assert.equal((await seen()).tested.all_accepted, false, 'stale evidence never celebrates')
  // the page takes the count and the celebration from these fields, not from the verdicts
  const page = await (await fetch(`${base}/`)).text()
  assert.match(page, /const allPass = !stale && !extras && verify\.status !== 'running' && Boolean\(tested\?\.all_accepted\)/)
  assert.match(page, /r\.verdict === 'pass' && !r\.accepted \? \{ \.\.\.r, verdict: 'rejected' \}/)
})

test('H22: a renamed file, and a name with spaces, are real paths the diff endpoint answers for', async t => {
  const { dir, git } = repo()
  withRun(dir)
  git('mv', 'a.txt', 'new name.txt')
  writeFileSync(join(dir, 'new name.txt'), 'one\ntwo\n')
  writeFileSync(join(dir, 'tab\there.txt'), 'x\n')
  git('add', '.'); git('commit', '-qm', 'rename with an edit')
  const { base } = await board(t, dir, 1)
  const events = await stream(base)
  t.after(events.close)
  assert.ok(await events.until(/"type":"snapshot"/))
  const files = JSON.parse(events.state.text.match(/data: (.*)/)[1]).changes.map(c => c.file).sort()
  assert.deepEqual(files, ['a.txt', 'new name.txt', 'tab\there.txt'])
  for (const file of files) {
    const res = await fetch(`${base}/api/diff?file=${encodeURIComponent(file)}`)
    assert.equal(res.status, 200, file)
    assert.match(await res.text(), /^diff --git/, `${file} has a diff`)
  }
  assert.equal((await fetch(`${base}/api/diff?file=${encodeURIComponent('a.txt => new name.txt')}`)).status, 400)
})

test('H23: results of the wrong shape, half-written files and broken notes never take the board down', async t => {
  const { dir } = repo()
  const run = withRun(dir, { checks: [{ id: 'a', step: 1 }] })
  const { server, base } = await board(t, dir, 2)
  const events = await stream(base)
  t.after(events.close)
  assert.ok(await events.until(/"type":"snapshot"/))
  mkdirSync(evidenceDir(dir, run), { recursive: true })
  writeFileSync(join(evidenceDir(dir, run), 'a.png'), PNG)
  const write = text => writeFileSync(resultsFile(dir, run), text)
  // evidence as a string, a row that is no object, a row without an id
  write(JSON.stringify({ request: 'r', results: [{ id: 'a', step: 1, verdict: 'pass', evidence: 'a.png' }, 'nonsense', { step: 1, verdict: 'pass' }] }))
  assert.ok(await events.until(/Invalid result in results\.json: evidence must be a list/), 'the bad row is shown as invalid')
  assert.match(events.state.text, /this result is not an object/)
  assert.match(events.state.text, /this result has no id/)
  assert.doesNotMatch(events.state.text.slice(events.state.text.indexOf('Invalid result')), /"verdict":"pass"/, 'an invalid row never shows as passed')
  // a file caught half-written, then the complete one
  write('{"request":"r","results":[{"id":"a","st')
  await wait(900)
  write(JSON.stringify({ request: 'r', results: [{ id: 'a', step: 1, verdict: 'pass', evidence: ['a.png'] }] }))
  assert.ok(await events.until(/"evidence":\["\/evidence\/a\.png"\]/), 'the valid file is picked up afterwards')
  // a broken notes file
  addNote(dir, { kind: 'note', text: 'first' })
  writeFileSync(join(dir, '.start-story', 'sc-1', 'inbox.json'), '[{"id":"n1"')
  assert.ok(await events.until(/notes file .* is unreadable/), 'the board says the notes are unreadable')
  const steer = await fetch(`${base}/api/steer`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'note', text: 'another' }) })
  assert.equal(steer.status, 500)
  assert.match(await steer.text(), /unreadable/)
  assert.equal(server.exitCode, null, 'the server is still running')
  assert.equal((await fetch(`${base}/`)).status, 200)
  assert.equal(load(dir).story, 'sc-1')
})
