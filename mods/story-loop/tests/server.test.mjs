// The board server with a fake `claude` on PATH: what the explainer may use, and that cancelling stops it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { repo, withRun } from './helpers.mjs'

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
