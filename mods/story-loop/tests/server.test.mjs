// The board server with a fake `claude` on PATH: what the explainer may use, and that cancelling stops it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { repo, withRun, PNG } from './helpers.mjs'
import { mkdirSync } from 'node:fs'
import { resultsFile, evidenceDir, load, addNote } from '../skills/story-loop/scripts/loop.mjs'

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
