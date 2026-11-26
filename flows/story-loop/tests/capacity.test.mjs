// Mutation concurrency across calls (2026-11-26 audit): slots are opened for runnable work
// only, and every mutate call in every checkout of a repository draws them from one budget.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, readFileSync, mkdtempSync, existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { load } from '../skills/story-loop/scripts/loop.mjs'
import { acquire, release, registry } from '../skills/story-loop/scripts/lease.mjs'
import { repo, withRun } from './helpers.mjs'

const SCRIPT = fileURLToPath(new URL('../skills/story-loop/scripts/mutate.mjs', import.meta.url))
const NODE = 'node --test --test-reporter=$STORY_LOOP_NODE_REPORTER --test-reporter-destination=$STORY_LOOP_REPORT'
const start = (cwd, env, ...args) => {
  const child = spawn('node', [SCRIPT, '--base', 'base', '--test', `${NODE} t.test.mjs`, ...args], { cwd, env: { ...process.env, ...env } })
  let out = '', err = ''
  child.stdout.on('data', d => { out += d }); child.stderr.on('data', d => { err += d })
  return { child, done: new Promise(ok => child.on('close', code => ok({ code, out, err }))) }
}
const result = out => JSON.parse(out.match(/RESULT (.*)/)[1])

// Three files changed, one mutant each; the test records how many test processes run at once.
function fixture(probe) {
  const r = repo()
  const t = `import { test } from 'node:test'
import assert from 'node:assert'
import { writeFileSync, appendFileSync, readdirSync, rmSync } from 'node:fs'
import { a } from './a.mjs'
import { b } from './b.mjs'
import { c } from './c.mjs'
test('abc', async () => {
  const me = ${JSON.stringify(probe)} + '/run-' + process.pid
  writeFileSync(me, '')
  appendFileSync(${JSON.stringify(probe)} + '/log', readdirSync(${JSON.stringify(probe)}).filter(n => n.startsWith('run-')).length + '\\n')
  await new Promise(r => setTimeout(r, 300))
  rmSync(me)
  assert.equal(a(), true); assert.equal(b(), true); assert.equal(c(), true)
})
`
  for (const f of ['a', 'b', 'c']) writeFileSync(join(r.dir, `${f}.mjs`), `export const ${f} = () => null\n`)
  writeFileSync(join(r.dir, 't.test.mjs'), t)
  r.git('add', '.'); r.git('commit', '-qm', 'base'); r.git('branch', 'base')
  for (const f of ['a', 'b', 'c']) writeFileSync(join(r.dir, `${f}.mjs`), `export const ${f} = () => true\n`)
  r.git('commit', '-qam', 'story')
  withRun(r.dir, { base: 'base' })
  return r
}
const peak = probe => Math.max(0, ...readFileSync(join(probe, 'log'), 'utf8').trim().split('\n').map(Number))

test('three concurrent one-mutant calls with --jobs 4: one slot and one baseline each, under the shared cap', async () => {
  const probe = mkdtempSync(join(tmpdir(), 'sl-cap-'))
  writeFileSync(join(probe, 'log'), '')
  const { dir } = fixture(probe)
  const calls = ['a.mjs', 'b.mjs', 'c.mjs'].map(f => start(dir, { STORY_LOOP_MUTATION_CAPACITY: '4' }, '--jobs', '4', f))
  const done = await Promise.all(calls.map(c => c.done))
  for (const d of done) assert.equal(d.code, 0, d.err)
  const stats = done.map(d => result(d.out).stats)
  const sum = k => stats.reduce((n, s) => n + s[k], 0)
  // Measured on 0.20.0 with this fixture: 3 mutant runs, 12 baseline runs, 12 test processes at once.
  assert.deepEqual([sum('mutant_runs'), sum('baseline_runs'), sum('slots')], [3, 3, 3])
  assert.ok(peak(probe) <= 4, `peak ${peak(probe)} test processes`)
  const m = load(dir).evidence.mutants
  assert.deepEqual([m.killed, m.valid, [...m.covered].sort()], [3, 3, ['a.mjs', 'b.mjs', 'c.mjs']], 'three calls, one aggregate')
  console.log(`capacity: ${JSON.stringify({ mutant_runs: sum('mutant_runs'), baseline_runs: sum('baseline_runs'), peak_test_processes: peak(probe), elapsed_ms: Math.max(...stats.map(s => s.elapsed_ms)) })}`)
})

test('the cap holds across calls and worktrees; outcomes equal a serial run; nothing deadlocks', async () => {
  const probe = mkdtempSync(join(tmpdir(), 'sl-cap2-'))
  writeFileSync(join(probe, 'log'), '')
  const { dir, git } = fixture(probe)
  const other = join(mkdtempSync(join(tmpdir(), 'sl-wt-')), 'wt')
  git('worktree', 'add', '-q', '--detach', other, 'HEAD')
  git('-C', other, 'branch', '-f', 'base', 'base')
  const env = { STORY_LOOP_MUTATION_CAPACITY: '2' }
  // Each call has two mutants per file (true -> false is one; the fixture's other lines none), so three calls want 3 x 4 slots.
  const calls = [start(dir, env, '--jobs', '4', 'a.mjs', 'b.mjs'), start(other, env, '--jobs', '4', '--explore', 'a.mjs', 'b.mjs', 'c.mjs'), start(dir, env, '--jobs', '4', 'c.mjs')]
  const done = await Promise.all(calls.map(c => c.done))
  for (const d of done) assert.equal(d.code, 0, d.err)
  assert.ok(peak(probe) <= 2, `peak ${peak(probe)} test processes with a capacity of 2`)
  const parallel = load(dir).evidence.mutants.outcomes
  // The same corpus, one slot at a time: the same classifications.
  const serial = await start(other, { STORY_LOOP_MUTATION_CAPACITY: '1' }, '--explore', 'a.mjs', 'b.mjs', 'c.mjs').done
  const lines = out => out.split('\n').filter(l => /^(killed|SURVIVED|infra|unclear|collect|NO TESTS)/.test(l)).sort()
  assert.deepEqual(lines(done[1].out), lines(serial.out))
  assert.deepEqual(Object.keys(parallel).sort(), lines(serial.out).map(l => l.match(/(\S+:\d+)/)[1]).map(k => Object.keys(parallel).find(id => id.startsWith(`${k}:`))).sort())
  assert.ok(!existsSync(join(registry(dir), 'mutation-capacity-1')), 'every capacity lease was given back')
})

test('a cancelled call releases only its own leases; an old owner never removes a newer owner\'s lease', async () => {
  const { dir } = repo()
  const n = acquire(dir, 'mutation-capacity', { pid: process.pid }, { max: 2 })
  // The lease was reclaimed and re-taken by someone else meanwhile (a new token in its owner file).
  writeFileSync(join(registry(dir), `mutation-capacity-${n}`, 'owner.json'), JSON.stringify({ pid: 1, token: 'newer-owner' }))
  release(dir, 'mutation-capacity', n)
  assert.ok(existsSync(join(registry(dir), `mutation-capacity-${n}`)), 'the newer owner keeps it')

  const probe = mkdtempSync(join(tmpdir(), 'sl-cap3-'))
  writeFileSync(join(probe, 'log'), '')
  const f = fixture(probe)
  const env = { STORY_LOOP_MUTATION_CAPACITY: '1' }
  const first = start(f.dir, env, 'a.mjs')
  await new Promise(ok => setTimeout(ok, 400))
  const waiting = start(f.dir, env, 'b.mjs')
  first.child.kill('SIGTERM')
  const [killed, after] = await Promise.all([first.done, waiting.done])
  assert.notEqual(killed.code, 0)
  assert.equal(after.code, 0, after.err)
  assert.match(after.out, /1 of 1 valid mutants killed/)
})
