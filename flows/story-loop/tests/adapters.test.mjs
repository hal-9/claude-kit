// Mutation evidence must distinguish behavioural detection from harness failure
// (2026-11-26 audit). Real node:test fixtures through the structured node adapter, and the
// jest/vitest and rspec report readers on their documented JSON shapes.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, readFileSync, mkdtempSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { load, mutantsProblem } from '../skills/story-loop/scripts/loop.mjs'
import { parseReport, judge, settle, detectAdapter } from '../skills/story-loop/scripts/adapters.mjs'
import { repo, withRun } from './helpers.mjs'

const SCRIPT = fileURLToPath(new URL('../skills/story-loop/scripts/mutate.mjs', import.meta.url))
const NODE = 'node --test --test-reporter=$STORY_LOOP_NODE_REPORTER --test-reporter-destination=$STORY_LOOP_REPORT'
const mutate = (dir, ...args) => spawnSync('node', [SCRIPT, '--base', 'base', ...args], { cwd: dir, encoding: 'utf8' })
const result = out => JSON.parse(out.match(/RESULT (.*)/)[1])

// base: `before` files; the story's commit: `after` files.
function project(before, after, { run = true } = {}) {
  const r = repo()
  for (const [f, t] of Object.entries(before)) writeFileSync(join(r.dir, f), t)
  r.git('add', '.'); r.git('commit', '-qm', 'base'); r.git('branch', 'base')
  for (const [f, t] of Object.entries(after)) writeFileSync(join(r.dir, f), t)
  r.git('add', '.'); r.git('commit', '-qm', 'story')
  if (run) withRun(r.dir, { base: 'base' })
  return r
}
const BIG = "import { test } from 'node:test'\nimport assert from 'node:assert'\nimport { big } from './calc.mjs'\ntest('big', () => { assert.equal(big(11), true); assert.equal(big(5), false) })\n"

test('a dependency outage after a healthy baseline earns no kill: the failures are infra', () => {
  const flag = join(mkdtempSync(join(tmpdir(), 'sl-outage-')), 'ran-once')
  const outage = `import { test, before } from 'node:test'
import assert from 'node:assert'
import { existsSync, writeFileSync } from 'node:fs'
import { big } from './calc.mjs'
before(() => {
  if (existsSync(${JSON.stringify(flag)})) { const e = new Error('connect ECONNREFUSED 127.0.0.1:5432'); e.code = 'ECONNREFUSED'; throw e }
  writeFileSync(${JSON.stringify(flag)}, '')
})
test('big', () => { assert.equal(big(11), true); assert.equal(big(5), false) })
`
  const { dir } = project({ 'calc.mjs': 'export const big = n => false\n', 'calc.test.mjs': outage }, { 'calc.mjs': 'export const big = n => n > 10\n' })
  const out = mutate(dir, '--test', `${NODE} calc.test.mjs`, 'calc.mjs')
  assert.equal(out.status, 0, out.stderr)
  const r = result(out.stdout)
  assert.deepEqual([r.killed, r.valid, r.infra], [0, 0, 2], 'no assertion ran, so nothing is a kill')
  assert.equal(r.stats.rechecks, 2, 'each setup failure was checked against clean code, which failed too')
  assert.match(mutantsProblem(load(dir).evidence.mutants), /inconclusive/)
})

test('assertion failures and application runtime failures are detected; an equivalent mutant survives on healthy code', () => {
  const source = "export const big = n => n > 10\nexport const pick = o => o === null ? 'none' : o.name\nexport const same = n => n * 1\n"
  const tests = `import { test } from 'node:test'
import assert from 'node:assert'
import { big, pick, same } from './calc.mjs'
test('big', () => { assert.equal(big(11), true); assert.equal(big(5), false) })
test('pick', () => { assert.equal(pick(null), 'none'); assert.equal(pick({ name: 'a' }), 'a') })
test('same', () => { assert.equal(same(4), 4) })
`
  const { dir } = project({ 'calc.mjs': 'export const big = n => false\n', 'calc.test.mjs': tests }, { 'calc.mjs': source })
  const out = mutate(dir, '--test', `${NODE} calc.test.mjs`, 'calc.mjs')
  assert.equal(out.status, 0, out.stderr)
  const m = load(dir).evidence.mutants
  const kind = line => Object.entries(m.kill_kinds).filter(([id]) => id.startsWith(`calc.mjs:${line}:`)).map(([, k]) => k)
  assert.ok(kind(1).includes('assertion'), 'a broken comparison fails an assertion')
  assert.ok(kind(2).includes('runtime'), 'o !== null throws a TypeError in the test body: the clean recheck passed, so it counts')
  // n * 1 -> n * 2 is caught; nothing on healthy code is called broken
  assert.equal(m.infra, 0)
  assert.equal(m.inconclusive, 0)
  const r = result(out.stdout)
  assert.equal(r.killed + r.survived, r.valid)
})

test('a mutant that breaks loading is a collection failure and never enters the score; no tests selected blocks', () => {
  const boot = "export const ready = true\nif (!true) throw new Error('boot failed')\n"
  const tests = "import { test } from 'node:test'\nimport assert from 'node:assert'\nimport { ready } from './boot.mjs'\ntest('ready', () => assert.equal(ready, true))\n"
  const { dir } = project({ 'boot.mjs': 'export const ready = true\n', 'boot.test.mjs': tests }, { 'boot.mjs': boot })
  const out = mutate(dir, '--test', `${NODE} boot.test.mjs`, 'boot.mjs')
  assert.equal(out.status, 0, out.stderr)
  const r = result(out.stdout)
  assert.ok(r.collection >= 1, out.stdout)
  assert.equal(r.valid, r.killed + r.survived)
  assert.ok(!Object.entries(load(dir).evidence.mutants.outcomes).some(([id, o]) => id.startsWith('boot.mjs:2:') && o === 'killed'), 'the load failure is not a kill')

  // A command that selects no tests: the baseline is refused, so no mutant can count.
  const none = mutate(dir, '--test', `${NODE} --test-name-pattern=nothing-matches boot.test.mjs`, 'boot.mjs')
  assert.equal(none.status, 1)
  assert.match(none.stderr, /fails on unmutated code .*no readable report or no tests/)
})

test('an unsupported command is never read by its exit code silently', () => {
  const { dir } = project({ 'calc.mjs': 'export const big = n => false\n', 'calc.test.mjs': BIG }, { 'calc.mjs': 'export const big = n => n > 10\n' })
  assert.match(mutate(dir, '--test', 'node --test calc.test.mjs', 'calc.mjs').stderr, /say how to read this test command's results: --adapter/)
  // A structured adapter whose command writes no report: inconclusive at the baseline, never a kill.
  const silent = mutate(dir, '--adapter', 'node', '--test', 'node --test calc.test.mjs', 'calc.mjs')
  assert.match(silent.stderr, /no readable report or no tests.*\$STORY_LOOP_REPORT/s)
  assert.equal(detectAdapter(`${NODE} x.test.mjs`), 'node')
  assert.equal(detectAdapter('bundle exec rspec --format json --out $STORY_LOOP_REPORT'), 'rspec')
  assert.equal(detectAdapter('npx jest'), null, 'a jest command without a report destination is not assumed')
})

test('a result names the command, subject, adapter and runtime it ran under', () => {
  const { dir, git } = project({ 'calc.mjs': 'export const big = n => false\n', 'calc.test.mjs': BIG }, { 'calc.mjs': 'export const big = n => n > 10\n' })
  assert.equal(mutate(dir, '--test', `${NODE} calc.test.mjs`, 'calc.mjs').status, 0)
  const m = load(dir).evidence.mutants
  const [identity] = Object.values(m.identity)
  assert.deepEqual([identity.command, identity.adapter, identity.tree, identity.merge_base, identity.runtime.node], [`${NODE} calc.test.mjs`, 'node', git('rev-parse', 'HEAD^{tree}'), git('rev-parse', 'base'), process.version])
  const log = JSON.parse(readFileSync(m.logs[0], 'utf8'))
  assert.equal(log.identity.adapter, 'node')
})

test('per-file calls merge in either order; a retry for one file replaces only that file', () => {
  const files = { 'a.mjs': 'export const a = n => n > 1\n', 'b.mjs': 'export const b = n => n < 9\n' }
  const tests = "import { test } from 'node:test'\nimport assert from 'node:assert'\nimport { a } from './a.mjs'\nimport { b } from './b.mjs'\ntest('ab', () => { assert.equal(a(2), true); assert.equal(a(1), false); assert.equal(b(8), true); assert.equal(b(9), false) })\n"
  const aggregates = [['a.mjs', 'b.mjs'], ['b.mjs', 'a.mjs']].map(order => {
    const { dir } = project({ 'a.mjs': 'export const a = n => 0\n', 'b.mjs': 'export const b = n => 0\n', 'ab.test.mjs': tests }, files)
    for (const f of order) assert.equal(mutate(dir, '--test', `${NODE} ab.test.mjs`, f).status, 0)
    const m = load(dir).evidence.mutants
    return { outcomes: m.outcomes, covered: [...m.covered].sort() }
  })
  assert.deepEqual(aggregates[0], aggregates[1])
  assert.deepEqual(aggregates[0].covered, ['a.mjs', 'b.mjs'])
})

// The documented report shapes of the other supported runners.
test('jest/vitest and rspec reports are read by what failed, not by the exit code', () => {
  const jest = (results) => JSON.stringify({ numTotalTests: 1, testResults: results })
  const assertion = parseReport('jest', jest([{ name: 'a.test.js', status: 'failed', assertionResults: [{ fullName: 'a', status: 'failed', failureMessages: ['Error: expect(received).toBe(expected)'], failureDetails: [{ matcherResult: { pass: false } }] }] }]))
  assert.deepEqual(judge({ code: 1 }, 'jest', assertion), { outcome: 'killed', kill_kind: 'assertion' })
  const suite = parseReport('vitest', jest([{ name: 'a.test.ts', status: 'failed', message: 'Test suite failed to run\nerror TS2304: Cannot find name', assertionResults: [] }]))
  assert.equal(judge({ code: 1 }, 'vitest', suite).outcome, 'build')
  const collect = parseReport('jest', jest([{ name: 'a.test.js', status: 'failed', message: 'Test suite failed to run: boom', assertionResults: [] }]))
  assert.deepEqual([judge({ code: 1 }, 'jest', collect).outcome, judge({ code: 1 }, 'jest', collect).recheck], ['collection', true])
  const runtime = parseReport('jest', jest([{ name: 'a', status: 'failed', assertionResults: [{ fullName: 'a', status: 'failed', failureMessages: ["TypeError: Cannot read properties of undefined (reading 'id')"] }] }]))
  const judged = judge({ code: 1 }, 'jest', runtime)
  assert.deepEqual([settle(judged, true).outcome, settle(judged, false).outcome], ['killed', 'infra'])

  const rspec = (examples, outside = 0) => JSON.stringify({ examples, summary: { example_count: examples.length, errors_outside_of_examples_count: outside } })
  assert.equal(judge({ code: 1 }, 'rspec', parseReport('rspec', rspec([{ full_description: 'x', status: 'failed', exception: { class: 'RSpec::Expectations::ExpectationNotMetError', message: 'expected true' } }]))).kill_kind, 'assertion')
  const db = parseReport('rspec', rspec([{ full_description: 'x', status: 'failed', exception: { class: 'PG::ConnectionBad', message: 'could not connect to server' } }]))
  assert.match(judge({ code: 1 }, 'rspec', db).why, /dependency outage/)
  assert.equal(settle(judge({ code: 1 }, 'rspec', db), false).outcome, 'infra')
  assert.equal(judge({ code: 1 }, 'rspec', parseReport('rspec', rspec([], 1))).outcome, 'collection')
  // An unreadable report, or one that contradicts the exit code, is inconclusive.
  assert.throws(() => parseReport('rspec', 'not json'))
  assert.equal(judge({ code: 1 }, 'rspec', null).outcome, 'inconclusive')
  assert.equal(judge({ code: 1 }, 'rspec', { tests: 3, failures: [] }).outcome, 'inconclusive')
  assert.equal(judge({ code: 0 }, 'rspec', { tests: 0, failures: [] }).outcome, 'no_tests')
  assert.equal(judge({ code: 0 }, 'exit', null).outcome, 'survived')
  assert.equal(judge({ code: 3 }, 'exit', null).recheck, true)
})
