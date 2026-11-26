// The walkthrough: what loop.mjs accepts, what it records, and what the board serves for it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { changedRanges, walkthroughProblem, load, update, runDir } from '../skills/story-loop/scripts/loop.mjs'
import { repo, withRun } from './helpers.mjs'

const LOOP = fileURLToPath(new URL('../skills/story-loop/scripts/loop.mjs', import.meta.url))
const SERVER = fileURLToPath(new URL('../skills/story-loop/board/server.mjs', import.meta.url))
const cli = (cwd, ...args) => spawnSync('node', [LOOP, ...args], { cwd, encoding: 'utf8' })
const wait = ms => new Promise(ok => setTimeout(ok, ms))
const lines = n => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n') + '\n'

// A story branch that changes line 12 of app.rb and adds a spec.
function story() {
  const r = repo()
  r.commit('app.rb', lines(30))
  r.git('checkout', '-q', 'main'); r.git('merge', '-q', '--ff-only', 'feat/sc-1-thing'); r.git('checkout', '-q', 'feat/sc-1-thing')
  r.commit('app.rb', lines(30).replace('line 12\n', 'line twelve\n'))
  mkdirSync(join(r.dir, 'spec'))
  r.commit('spec/app_spec.rb', 'it works\n')
  withRun(r.dir)
  return r
}
const valid = () => ({
  summary: [{ label: 'Goal', text: 'Line 12 reads better.' }, { label: 'Guard left behind', text: 'A spec.', basis: 'proven', evidence: 'spec/app_spec.rb:1' }],
  chapters: [{ step: 1, title: 'Line 12 reads better', changes: [{ file: 'app.rb', what: 'Renames line 12.', notes: [{ lines: [12, 12], text: 'The new name.', basis: 'claim' }] }] }],
  tests: [{ file: 'spec/app_spec.rb', proves: 'It works.' }],
})

test('changed ranges are new-side line numbers per file', () => {
  const { dir } = story()
  assert.deepEqual(changedRanges(dir, 'main'), { 'app.rb': [[12, 12]], 'spec/app_spec.rb': [[1, 1]] })
})

test('a walkthrough covers every changed file, anchors notes near changed lines and cites what it calls proven', () => {
  const { dir } = story()
  const ranges = changedRanges(dir, 'main')
  assert.equal(walkthroughProblem(valid(), ranges), null)
  const w = valid()
  w.chapters[0].changes[0].notes[0] = { lines: [12, 12], text: 'x', basis: 'proven' }
  assert.match(walkthroughProblem(w, ranges), /says proven: name the evidence/)
  w.chapters[0].changes[0].notes[0] = { lines: [25, 26], text: 'x', basis: 'claim' }
  assert.match(walkthroughProblem(w, ranges), /not near any changed line of app.rb \(changed: 12\)/)
  const noSpec = { ...valid(), tests: [] }
  assert.match(walkthroughProblem(noSpec, ranges), /not in the walkthrough: spec\/app_spec.rb/)
  const other = valid(); other.chapters[0].changes[0].file = 'nope.rb'
  assert.match(walkthroughProblem(other, ranges), /nope.rb is not part of this change/)
  const bare = valid(); bare.chapters[0].changes[0].notes = []
  assert.match(walkthroughProblem(bare, ranges), /add notes on its lines, or "fold"/)
  bare.chapters[0].changes[0].fold = 'One rename.'
  assert.equal(walkthroughProblem(bare, ranges), null)
  const held = { ...valid(), hypotheses: { facts: ['a', 'b'], rows: [{ text: 'x', fits: [true, false], held: true }] } }
  assert.match(walkthroughProblem(held, ranges), /marked held but contradicts a fact/)
})

test('loop.mjs walkthrough records it for committed code only, and only when it is complete', () => {
  const { dir, commit } = story()
  const file = join(dir, '.start-story', 'w.json')
  writeFileSync(file, JSON.stringify(valid()))
  writeFileSync(join(dir, 'app.rb'), 'dirty\n')
  assert.match(cli(dir, 'walkthrough', file).stderr, /commit first/)
  spawnSync('git', ['checkout', '--', 'app.rb'], { cwd: dir })
  const out = cli(dir, 'walkthrough', file)
  assert.equal(out.status, 0, out.stderr)
  const run = load(dir)
  assert.equal(run.walkthrough.tree, spawnSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: dir, encoding: 'utf8' }).stdout.trim())
  assert.equal(JSON.parse(readFileSync(join(runDir(dir, run), 'walkthrough.json'), 'utf8')).commit, run.walkthrough.commit)
  writeFileSync(file, JSON.stringify({ ...valid(), tests: [] }))
  assert.match(cli(dir, 'walkthrough', file).stderr, /not in the walkthrough/)
})

test('the board serves the walkthrough with the code from git and the mutant outcomes per line', async t => {
  const { dir, commit } = story()
  const file = join(dir, '.start-story', 'w.json')
  writeFileSync(file, JSON.stringify(valid()))
  assert.equal(cli(dir, 'walkthrough', file).status, 0)
  update(dir, r => ({ ...r, evidence: { ...r.evidence, mutants: { outcomes: { 'app.rb:12:abc123': 'survived' }, dispositions: { 'app.rb:12:abc123': 'cosmetic' } } } }))
  const port = 44000 + (process.pid % 1000)
  const server = spawn('node', [SERVER, '--root', dir, '--port', String(port), '--no-open'], { stdio: 'ignore' })
  t.after(() => server.kill())
  await wait(600)
  const get = () => fetch(`http://127.0.0.1:${port}/api/walkthrough`).then(r => r.json())
  const data = await get()
  assert.equal(data.current, true)
  assert.match(data.diffs['app.rb'], /\+line twelve/)
  assert.ok(data.diffs['spec/app_spec.rb'])
  assert.deepEqual(data.mutants, [{ file: 'app.rb', line: 12, outcome: 'survived', accepted: 'cosmetic' }])
  commit('app.rb', lines(30).replace('line 12\n', 'line 12, again\n'))
  const later = await get()
  assert.equal(later.current, false, 'a walkthrough for older code is shown as such')
  assert.match(later.diffs['app.rb'], /\+line 12, again/, 'the code is always the code now')
})
