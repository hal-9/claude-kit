// Two stories at once: a worktree beside the checkout, its own ports, one shared ledger.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, lstatSync, realpathSync, rmSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { worktreeEntries, sharedTestDatabase, portsFor } from '../skills/story-loop/scripts/loop.mjs'
import { appendLedger, readLedger, ledgerFile, localLedgerFile } from '../skills/story-loop/scripts/ledger.mjs'
import { repo, withRun } from './helpers.mjs'

const LOOP = fileURLToPath(new URL('../skills/story-loop/scripts/loop.mjs', import.meta.url))
const SERVER = fileURLToPath(new URL('../skills/story-loop/board/server.mjs', import.meta.url))
const cli = (cwd, ...args) => spawnSync('node', [LOOP, ...args], { cwd, encoding: 'utf8' })

test('a second story gets a worktree beside the checkout, with its files, its ports and one shared ledger', t => {
  const { dir } = repo()
  const home = `${dir}-story-loop`
  t.after(() => rmSync(home, { recursive: true, force: true }))
  mkdirSync(join(dir, 'node_modules', 'x'), { recursive: true })
  withRun(dir)

  // init beside an active run points at the worktree command
  const refused = cli(dir, 'init', 'SC-2')
  assert.equal(refused.status, 1)
  assert.match(refused.stderr, /another run is active here \(sc-1\); run this story beside it with: loop\.mjs worktree sc-2/)

  const made = cli(dir, 'worktree', 'SC-2')
  assert.equal(made.status, 0, made.stderr)
  const wt = join(home, 'sc-2')
  assert.match(made.stdout, /Worktree ready for sc-2/)
  assert.match(made.stdout, /set up: node_modules \(link\)/)
  assert.match(made.stdout, /ports: board 4318, app 3001/)
  assert.ok(lstatSync(join(wt, 'node_modules')).isSymbolicLink())
  assert.deepEqual(JSON.parse(readFileSync(join(wt, '.start-story', 'ports.json'), 'utf8')), portsFor(1))
  assert.equal(cli(wt, 'init', 'SC-2').status, 0, 'the worktree takes its own run')
  assert.match(cli(dir, 'worktree', 'SC-2').stdout, /Worktree already there for sc-2/)

  // both checkouts write to and read from one ledger
  appendLedger(wt, JSON.parse(readFileSync(join(wt, '.start-story', 'active.json'), 'utf8')))
  assert.equal(realpathSync(ledgerFile(dir)), realpathSync(ledgerFile(wt)))
  assert.deepEqual(readLedger(dir).map(e => e.story), ['sc-2'])
  // a line an older version wrote into the checkout is still read
  writeFileSync(localLedgerFile(dir), JSON.stringify({ run: 'old', story: 'sc-0' }) + '\n')
  assert.deepEqual(readLedger(dir).map(e => e.story).sort(), ['sc-0', 'sc-2'])
})

test('worktree entries come from .devloops, and a single test database is named', () => {
  const { dir } = repo()
  assert.deepEqual(worktreeEntries(dir), [{ path: 'node_modules', mode: 'link' }])
  writeFileSync(join(dir, '.devloops'), 'review:\n  angles: []\nworktree:\n  entries:\n    - path: config/database.yml\n      mode: copy\n    - path: node_modules\n      mode: link\nother: 1\n')
  assert.deepEqual(worktreeEntries(dir), [{ path: 'config/database.yml', mode: 'copy' }, { path: 'node_modules', mode: 'link' }])

  assert.equal(sharedTestDatabase(dir), null, 'no Rails, nothing to say')
  mkdirSync(join(dir, 'config'))
  writeFileSync(join(dir, 'config', 'database.yml'), 'development:\n  database: app_dev\ntest:\n  database: app_test\n')
  assert.match(sharedTestDatabase(dir), /one test database for every checkout/)
  writeFileSync(join(dir, 'config', 'database.yml'), 'test:\n  database: app_test<%= ENV["TEST_ENV_NUMBER"] %>\n')
  assert.equal(sharedTestDatabase(dir), null)
})

test('the board takes the port ports.json gives it, and the next free one when another board holds it', async t => {
  const { dir } = repo()
  const port = 44000 + (process.pid % 1000)
  const held = createServer().listen(port, '127.0.0.1')
  t.after(() => held.close())
  mkdirSync(join(dir, '.start-story'), { recursive: true })
  writeFileSync(join(dir, '.start-story', 'ports.json'), JSON.stringify({ board: port, app: 3001 }))
  const board = spawn('node', [SERVER, '--root', dir, '--no-open'], { stdio: ['ignore', 'pipe', 'pipe'] })
  t.after(() => board.kill())
  const line = await new Promise((ok, fail) => {
    board.stdout.on('data', d => ok(String(d)))
    board.on('exit', code => fail(new Error(`board exited ${code}`)))
  })
  assert.match(line, new RegExp(`http://127\\.0\\.0\\.1:${port + 1}`))
})
