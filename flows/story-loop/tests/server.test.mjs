// The board server with a fake `claude` on PATH: what the explainer may use, and that cancelling stops it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, existsSync, rmSync, symlinkSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { repo, withRun, PNG, ENV, META } from './helpers.mjs'
import { mkdirSync } from 'node:fs'
import { resultsFile, evidenceDir, runDir, load, update, addNote, readInbox, verifyRequest, verifyProblem } from '../skills/story-loop/scripts/loop.mjs'

const SERVER = fileURLToPath(new URL('../skills/story-loop/board/server.mjs', import.meta.url))
const bin = mkdtempSync(join(tmpdir(), 'sl-fakeclaude-'))
const ARGS = join(bin, 'args.json')
const PID = join(bin, 'pid')
const LOGGED_OUT = join(bin, 'logged-out')
writeFileSync(join(bin, 'claude'), `#!/usr/bin/env node
if (process.argv[2] === 'auth') { process.stdout.write(JSON.stringify({ loggedIn: !require('fs').existsSync(${JSON.stringify(LOGGED_OUT)}) })); process.exit(0) }
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
  const server = spawn('node', [SERVER, '--root', dir, '--port', String(port), '--no-open'], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, stdio: 'ignore' })
  t.after(() => server.kill())
  await wait(600)
  const base = `http://127.0.0.1:${port}`

  const foreign = await fetch(`${base}/api/steer`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: '{}' })
  assert.equal(foreign.status, 403)

  // A CLI with no login of its own is said plainly, before anything is started; a no is not remembered.
  const ask = () => fetch(`${base}/api/explain`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ file: 'a.txt', question: 'explain' }) })
  writeFileSync(LOGGED_OUT, '')
  const out = await ask()
  assert.equal(out.status, 503)
  assert.match(await out.text(), /claude auth login/)
  assert.equal(existsSync(ARGS), false, 'no explainer was started')
  rmSync(LOGGED_OUT)

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
async function board(t, dir, offset, env = process.env) {
  const port = 44000 + offset + (process.pid % 1000)
  const server = spawn('node', [SERVER, '--root', dir, '--port', String(port), '--no-open'], { env, stdio: 'ignore' })
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

test('the board answers a stage waiting on the human: yes, or no with what to do instead, and only for that wait', async t => {
  const { dir } = repo()
  withRun(dir)
  update(dir, r => { r.stages.contract.status = 'passed'; r.stages.build.status = 'passed'; r.stages.quality = { ...r.stages.quality, status: 'waiting', waiting_on: 'human', reason: 'accept the new size of 1058 lines?' }; return r })
  const { base } = await board(t, dir, 4)
  // What the page rendered the question with: the run, the stage's attempt and the question's id.
  const { run } = await snapshot(base)
  const bound = { run: run.run_key, attempt: run.stages.quality.attempt, question_id: run.stages.quality.question_id }
  const send = payload => fetch(`${base}/api/answer`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...bound, ...payload }) })

  assert.equal((await send({ stage: 'build', verdict: 'yes' })).status, 409, 'build is not waiting on the human')
  assert.equal((await send({ stage: 'quality', verdict: 'maybe' })).status, 400)
  const bareNo = await send({ stage: 'quality', verdict: 'no', text: '  ' })
  assert.equal(bareNo.status, 400)
  assert.match(await bareNo.text(), /what the agent should do instead/)
  const foreign = await fetch(`${base}/api/answer`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: JSON.stringify({ ...bound, stage: 'quality', verdict: 'yes' }) })
  assert.equal(foreign.status, 403)
  assert.equal(readInbox(dir, load(dir)).length, 0, 'nothing reached the inbox')

  const yes = await send({ stage: 'quality', verdict: 'yes' })
  assert.equal(yes.status, 200)
  const [note] = readInbox(dir, load(dir))
  assert.deepEqual([note.kind, note.stage, note.verdict, note.question, note.status], ['answer', 'quality', 'yes', 'accept the new size of 1058 lines?', 'queued'])
  const no = await send({ stage: 'quality', verdict: 'no', text: 'split the story instead' })
  assert.equal(no.status, 200)
  assert.equal(readInbox(dir, load(dir))[1].text, 'split the story instead')
})

test('an answer is bound to the question it answers: run, stage, attempt and question id; a repeat is one note', async t => {
  const { dir } = repo()
  withRun(dir)
  const ask = reason => update(dir, r => { r.stages.contract.status = 'passed'; r.stages.build.status = 'passed'; r.stages.quality = { ...r.stages.quality, status: 'waiting', waiting_on: 'human', reason }; return r })
  ask('accept the new size of 1058 lines?')
  const { base } = await board(t, dir, 6)
  const page = await fetch(`${base}/`)
  assert.equal(page.headers.get('x-frame-options'), 'DENY')
  assert.match(page.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/)
  assert.match(await page.text(), /question_id: item\.question_id/, 'the page sends the id of the question it rendered')

  const { run } = await snapshot(base)
  const bound = { stage: 'quality', run: run.run_key, attempt: run.stages.quality.attempt, question_id: run.stages.quality.question_id }
  assert.ok(bound.run && bound.attempt && /^[0-9a-f]{64}$/.test(bound.question_id), 'the board receives what identifies the question')
  const send = payload => fetch(`${base}/api/answer`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })

  for (const wrong of [{ run: 'another-run' }, { attempt: bound.attempt + 1 }, { question_id: 'f'.repeat(64) }, { question_id: undefined }, { run: undefined }]) {
    const res = await send({ ...bound, ...wrong, verdict: 'yes' })
    assert.equal(res.status, 409, JSON.stringify(wrong))
  }
  assert.equal(readInbox(dir, load(dir)).length, 0, 'no mismatched answer reached the inbox')

  const first = await send({ ...bound, verdict: 'yes' })
  assert.equal(first.status, 200)
  const again = await send({ ...bound, verdict: 'yes' })
  assert.equal(again.status, 200)
  assert.deepEqual(await again.json(), await first.json(), 'the repeat names the same note')
  const notes = readInbox(dir, load(dir))
  assert.equal(notes.length, 1, 'a repeated answer is one note')
  assert.deepEqual([notes[0].run, notes[0].attempt, notes[0].question_id], [bound.run, bound.attempt, bound.question_id])

  // The stage now asks something else: an answer to the old question no longer fits.
  ask('accept 1200 lines?')
  assert.equal((await send({ ...bound, verdict: 'no', text: 'split it' })).status, 409)
  assert.equal(readInbox(dir, load(dir)).length, 1)
})

test('the evidence route serves only real images inside the run\'s evidence folder', async t => {
  const { dir } = repo()
  const run = withRun(dir)
  const ev = evidenceDir(dir, run)
  mkdirSync(ev, { recursive: true })
  writeFileSync(join(ev, 'ok.png'), PNG)
  const outside = mkdtempSync(join(tmpdir(), 'sl-outside-'))
  writeFileSync(join(outside, 'secret.png'), PNG)
  symlinkSync(join(outside, 'secret.png'), join(ev, 'link.png'))
  writeFileSync(join(ev, 'fake.png'), 'not an image at all, only text with a png name '.repeat(4))
  // A real PNG header and end, over the size cap.
  writeFileSync(join(ev, 'huge.png'), Buffer.concat([PNG, Buffer.alloc(21 << 20), PNG.subarray(-12)]))
  writeFileSync(join(runDir(dir, run), 'up.png'), PNG)
  const { base } = await board(t, dir, 7)
  const get = name => fetch(`${base}/evidence/${name}`)

  const ok = await get('ok.png')
  assert.equal(ok.status, 200)
  assert.equal(ok.headers.get('content-type'), 'image/png')
  assert.deepEqual(Buffer.from(await ok.arrayBuffer()), PNG)
  for (const name of ['link.png', 'fake.png', 'huge.png', '..%2Fup.png', 'missing.png']) {
    const res = await get(name)
    assert.equal(res.status, 404, name)
    await res.arrayBuffer()
  }
})

// A fake `claude` whose auth check is slow, so requests pile up while it runs.
function slowClaude() {
  const dir = mkdtempSync(join(tmpdir(), 'sl-slowclaude-'))
  const f = { dir, starts: join(dir, 'starts'), auths: join(dir, 'auths'), out: join(dir, 'logged-out') }
  writeFileSync(join(dir, 'claude'), `#!/usr/bin/env node
const fs = require('fs')
if (process.argv[2] === 'auth') { fs.appendFileSync(${JSON.stringify(f.auths)}, 'x\\n'); setTimeout(() => process.stdout.write(JSON.stringify({ loggedIn: !fs.existsSync(${JSON.stringify(f.out)}) })), 400); return }
fs.appendFileSync(${JSON.stringify(f.starts)}, process.pid + '\\n')
process.stdout.write('thinking...')
setTimeout(() => {}, 60000)
`)
  chmodSync(join(dir, 'claude'), 0o755)
  const lines = file => existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : []
  return { ...f, env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }, startPids: () => lines(f.starts).map(Number), authCount: () => lines(f.auths).length }
}
function explainer(base) {
  return () => {
    const abort = new AbortController()
    const res = fetch(`${base}/api/explain`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ file: 'a.txt', question: 'explain' }), signal: abort.signal })
    return { res, abort: () => abort.abort() }
  }
}

test('at most two explainers run however many requests arrive during the auth check, and every path hands its slot back', async t => {
  const { dir, commit } = repo()
  withRun(dir)
  commit('a.txt', 'changed')
  const fake = slowClaude()
  const { base } = await board(t, dir, 8, fake.env)
  const ask = explainer(base)

  // Auth fails: the two that got a slot say so, the rest are turned away, nothing starts.
  writeFileSync(fake.out, '')
  const out = [ask(), ask(), ask()]
  const outStatus = await Promise.all(out.map(async r => { const res = await r.res; await res.text(); return res.status }))
  assert.deepEqual(outStatus.sort(), [429, 503, 503])
  assert.equal(fake.authCount(), 1, 'simultaneous auth checks are one check')
  assert.deepEqual(fake.startPids(), [])
  rmSync(fake.out)

  // Six at once while the auth check runs: two start, four are turned away.
  const six = Array.from({ length: 6 }, ask)
  const responses = await Promise.all(six.map(r => r.res))
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 200, 429, 429, 429, 429])
  await wait(800)
  assert.equal(fake.startPids().length, 2, 'only two explainers started')
  assert.equal(fake.authCount(), 2)

  // A bad request and the cancelled two hand their slots back.
  for (const r of six) r.abort()
  for (let i = 0; i < 30 && fake.startPids().some(alive); i++) await wait(100)
  assert.equal(fake.startPids().some(alive), false)
  await wait(200)
  const bad = await fetch(`${base}/api/explain`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: 'nope' }) })
  assert.equal(bad.status, 400)
  const next = [ask(), ask(), ask()]
  const nextStatus = await Promise.all(next.map(async r => (await r.res).status))
  assert.deepEqual(nextStatus.sort(), [200, 200, 429], 'all slots came back: two run again, the third waits')
  for (const r of next) r.abort()
  for (let i = 0; i < 30 && fake.startPids().some(alive); i++) await wait(100)
})

test('an explanation cancelled while the auth check runs starts nothing and hands its slot back', async t => {
  const { dir, commit } = repo()
  withRun(dir)
  commit('a.txt', 'changed')
  const fake = slowClaude()
  const { base } = await board(t, dir, 9, fake.env)
  const ask = explainer(base)
  const gone = ask()
  gone.res.catch(() => {})
  await wait(100)
  gone.abort()
  await wait(800)
  assert.deepEqual(fake.startPids(), [], 'nothing started for a page that left')
  const both = [ask(), ask()]
  assert.deepEqual(await Promise.all(both.map(async r => (await r.res).status)), [200, 200])
  for (const r of both) r.abort()
  for (let i = 0; i < 30 && fake.startPids().some(alive); i++) await wait(100)
})

test('the board opens itself in the browser when no page connects, and not when one does', async t => {
  const fakes = mkdtempSync(join(tmpdir(), 'sl-fakeopen-'))
  const OPENED = join(fakes, 'opened')
  for (const name of ['open', 'xdg-open']) {
    writeFileSync(join(fakes, name), `#!/bin/sh\necho "$1" >> ${JSON.stringify(OPENED)}\n`)
    chmodSync(join(fakes, name), 0o755)
  }
  const env = { ...process.env, PATH: `${fakes}:${process.env.PATH}` }
  const start = (port, ...extra) => { const s = spawn('node', [SERVER, '--root', repo().dir, '--port', String(port), ...extra], { env, stdio: 'ignore' }); t.after(() => s.kill()); return s }
  const port = 45500 + (process.pid % 1000)

  start(port, '--open-after', '0.5')
  await wait(1500)
  assert.equal(readFileSync(OPENED, 'utf8').trim(), `http://127.0.0.1:${port}`)

  rmSync(OPENED)
  start(port + 1, '--open-after', '1')
  await wait(400)
  const res = await fetch(`http://127.0.0.1:${port + 1}/events`)
  await wait(1200)
  await res.body.cancel()
  assert.equal(existsSync(OPENED), false)
})

test('before a run the board serves the setup check as data, to its own page only', async t => {
  const { dir } = repo()
  const { base } = await board(t, dir, 70)
  const foreign = await fetch(`${base}/api/setup`, { method: 'POST', headers: { origin: 'https://evil.example' } })
  assert.equal(foreign.status, 403)
  assert.equal((await fetch(`${base}/api/setup`)).status, 404)
  const res = await fetch(`${base}/api/setup?source=github`, { method: 'POST' })
  assert.equal(res.status, 200)
  const { results, confirm } = await res.json()
  assert.ok(results.some(r => r.name === 'Inside a git repository' && r.status === 'ok'))
  assert.equal(results.find(r => r.name === 'Shortcut CLI 5 or newer').detail, 'not needed for GitHub issues')
  assert.ok(results.every(r => ['ok', 'blocker', 'warning'].includes(r.status)))
  assert.ok(confirm.length > 0)
})
