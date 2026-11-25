import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, readFileSync, readdirSync, symlinkSync, mkdirSync, mkdtempSync, existsSync, renameSync } from 'node:fs'
import { createRequire } from 'node:module'
import { spawn, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mutantsFor, changedLines, classify } from '../skills/story-loop/scripts/mutate.mjs'
import { load, update, mutantsProblem } from '../skills/story-loop/scripts/loop.mjs'
import { readEvents, diagDir } from '../skills/story-loop/scripts/diag.mjs'
import { repo, withRun } from './helpers.mjs'

const SCRIPT = fileURLToPath(new URL('../skills/story-loop/scripts/mutate.mjs', import.meta.url))

// A repo where calc.mjs changed against branch "base".
function fixture(source, check) {
  const r = repo()
  writeFileSync(join(r.dir, 'calc.mjs'), 'export const big = n => false\n')
  writeFileSync(join(r.dir, 'check.mjs'), check)
  r.git('add', '.'); r.git('commit', '-qm', 'base'); r.git('branch', 'base')
  writeFileSync(join(r.dir, 'calc.mjs'), source)
  r.git('commit', '-qam', 'change')
  return r
}
const mutate = (dir, ...args) => spawnSync('node', [SCRIPT, '--base', 'base', ...args], { cwd: dir, encoding: 'utf8' })
const result = stdout => JSON.parse(stdout.match(/RESULT (.*)/)[1])

test('mutantsFor breaks one thing per variant and leaves comments alone', () => {
  assert.deepEqual(mutantsFor('  return a >= 10 && b', '.js'), ['  return a > 10 && b', '  return a >= 10 || b', '  return a >= 11 && b'])
  assert.deepEqual(mutantsFor('if (a === b) x()', '.js'), ['if (a !== b) x()'])
  assert.ok(mutantsFor('  return nil unless user.present?', '.rb').includes('  return nil if user.present?'))
  assert.deepEqual(mutantsFor('  # if x == 1', '.rb'), [])
  assert.deepEqual(mutantsFor('x == 1', '.haml'), [])
})

test('changedLines reads new-file line numbers from a -U0 diff', () => {
  assert.deepEqual(changedLines('@@ -3 +3,2 @@\n+a\n+b\n@@ -9,2 +10 @@\n+c\n@@ -20,3 +20,0 @@\n'), [3, 4, 10])
})

test('only a real test failure is a kill', () => {
  assert.equal(classify({ code: 1 }), 'killed')
  assert.equal(classify({ code: 0 }), 'survived')
  assert.equal(classify({ code: null, timedOut: true }), 'timeout')
  assert.equal(classify({ code: 127 }), 'infra')
  assert.equal(classify({ error: new Error('spawn') }), 'infra')
  assert.equal(classify({ code: null, signal: 'SIGSEGV' }), 'inconclusive')
  assert.equal(classify({ code: 143 }), 'inconclusive') // SIGTERM as a shell reports it
})

test('a weak test lets a boundary mutant survive; the checkout is untouched and the result is evidence', () => {
  const source = 'export const big = n => n > 10\n'
  const { dir } = fixture(source, "import { big } from './calc.mjs'\nif (!big(11) || big(5)) process.exit(1)\n")
  withRun(dir)
  const run = mutate(dir, '--test', 'node check.mjs', 'calc.mjs')
  assert.equal(run.status, 0, run.stderr)
  assert.match(run.stdout, /SURVIVED calc\.mjs:1 .*n > 10\s+->\s+.*n >= 10/)
  assert.deepEqual([result(run.stdout).killed, result(run.stdout).survived, result(run.stdout).total], [1, 1, 2])
  assert.equal(readFileSync(join(dir, 'calc.mjs'), 'utf8'), source)
  const mutants = load(dir).evidence.mutants
  assert.equal(mutants.killed, 1)
  assert.equal(mutants.tree, spawnSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: dir, encoding: 'utf8' }).stdout.trim())
  assert.equal(readdirSync(tmpdir()).filter(n => n.startsWith(`story-loop-mut-${run.pid}`)).length, 0)
})

test('--jobs runs mutants side by side in separate copies and reports exactly what one slot would', () => {
  const source = 'export const big = n => n > 10 && n < 100\nexport const small = n => n <= 3 || n === 7\n'
  const probe = mkdtempSync(join(tmpdir(), 'sl-slots-'))
  // Each run says which slot it is and how many runs were going at that moment.
  const check = `import { big, small } from './calc.mjs'
import { writeFileSync, readdirSync, rmSync, appendFileSync } from 'node:fs'
const me = ${JSON.stringify(probe)} + '/running-' + process.env.STORY_LOOP_SLOT
writeFileSync(me, '')
await new Promise(r => setTimeout(r, 250))
appendFileSync(${JSON.stringify(probe)} + '/log', process.env.STORY_LOOP_SLOT + ':' + JSON.stringify(process.env.TEST_ENV_NUMBER) + ':' + readdirSync(${JSON.stringify(probe)}).filter(n => n.startsWith('running-')).length + '\\n')
rmSync(me)
if (!big(11) || big(5) || !small(2) || small(5)) process.exit(1)
`
  const { dir } = fixture(source, check)
  const serial = mutate(dir, '--test', 'node check.mjs', 'calc.mjs')
  assert.equal(serial.status, 0, serial.stderr)
  writeFileSync(join(probe, 'log'), '')
  const parallel = mutate(dir, '--test', 'node check.mjs', '--jobs', '3', 'calc.mjs')
  assert.equal(parallel.status, 0, parallel.stderr)
  const lines = out => out.split('\n').filter(l => /^(killed|SURVIVED|invalid|timeout|not run)/.test(l)).join('\n')
  assert.equal(lines(parallel.stdout), lines(serial.stdout), 'same mutants, same outcomes, same order')
  assert.deepEqual(result(parallel.stdout), result(serial.stdout))

  const seen = readFileSync(join(probe, 'log'), 'utf8').trim().split('\n').map(l => l.split(':'))
  assert.deepEqual([...new Set(seen.map(([slot]) => slot))].sort(), ['1', '2', '3'], 'every slot ran')
  assert.ok(seen.some(([, , running]) => Number(running) > 1), 'runs overlapped')
  assert.deepEqual([...new Set(seen.map(([slot, env]) => `${slot}=${env}`))].sort(), ['1=""', '2="2"', '3="3"'], 'TEST_ENV_NUMBER in the parallel_tests convention')
  assert.equal(readFileSync(join(dir, 'calc.mjs'), 'utf8'), source)
  assert.equal(readdirSync(tmpdir()).filter(n => n.startsWith(`story-loop-mut-${parallel.pid}`)).length, 0, 'every slot copy removed')
})

test('--jobs: a slot that cannot run green next to the others stops the call before any mutant counts', () => {
  const { dir } = fixture('export const big = n => n > 10\n', "if (process.env.STORY_LOOP_SLOT === '2') process.exit(1)\n")
  withRun(dir)
  const run = mutate(dir, '--test', 'node check.mjs', '--jobs', '2', 'calc.mjs')
  assert.notEqual(run.status, 0)
  assert.match(run.stderr, /fails on unmutated code.*--jobs 1/s)
  assert.equal(load(dir).evidence?.mutants, undefined, 'no evidence from a run whose slots disagree')
  for (const bad of ['0', '2.5', '9'])
    assert.match(mutate(dir, '--test', 'node check.mjs', '--jobs', bad, 'calc.mjs').stderr, /--jobs/)
})

test('the lane sets the budget: light mutates up to 10 front-end mutants, heavy has no cap, a changed lane needs a new run', async () => {
  const { passProblem } = await import('../skills/story-loop/scripts/loop.mjs')
  const { LANE } = await import('./helpers.mjs')
  // 4 lines, each with several operators: more than 10 mutants.
  const source = 'export const big = n => n > 10 && n < 100\nexport const a = n => n >= 2 || n === 7\nexport const b = n => n <= 3 && n !== 9\nexport const c = n => n < 5 || true\n'
  const r = fixture(source, "import { big } from './calc.mjs'\nif (!big(11)) process.exit(1)\n")
  writeFileSync(join(r.dir, 'model.rb'), 'def big(n) = n > 10\n'); r.git('add', '.'); r.git('commit', '-qm', 'ruby too')
  const { dir } = r

  withRun(dir, { lane: { ...LANE, lane: 'light' } })
  const light = mutate(dir, '--test', 'node check.mjs', 'calc.mjs', 'model.rb')
  assert.equal(light.status, 0, light.stderr)
  const l = result(light.stdout)
  assert.equal(l.killed + l.survived + l.invalid + l.unverified + l.timeout, 10, 'light runs 10')
  assert.ok(l.skipped > 0, 'the rest is visible as not run')
  assert.match(light.stdout, /skip model\.rb \(the light lane mutates/)
  const m = load(dir).evidence.mutants
  assert.deepEqual([m.lane, m.lane_skipped, m.scope], ['light', ['model.rb'], ['calc.mjs']])
  assert.doesNotMatch(passProblem(dir, load(dir), 'test_review') ?? '', /not mutated: model\.rb/, 'a file the lane leaves out does not block')

  // The story is re-signed as standard: the light results say nothing about it.
  update(dir, run => ({ ...run, lane: { ...LANE, lane: 'standard' } }))
  assert.match(passProblem(dir, load(dir), 'test_review'), /ran under the light lane, the story is now standard/)

  update(dir, run => ({ ...run, lane: { ...LANE, lane: 'heavy' }, evidence: {} }))
  const heavy = mutate(dir, '--test', 'node check.mjs', 'calc.mjs', 'model.rb')
  assert.equal(heavy.status, 0, heavy.stderr)
  assert.equal(result(heavy.stdout).skipped, 0, 'heavy runs every mutant')
  assert.ok(result(heavy.stdout).total > 10)
  assert.deepEqual(load(dir).evidence.mutants.lane_skipped, [])
})

test('an import-only test gets no kill credit from unparsable mutants', () => {
  const { dir } = fixture('export const same = (a, b) => a === b && 10\n', "import './calc.mjs'\n")
  const run = mutate(dir, '--test', 'node check.mjs', 'calc.mjs')
  assert.equal(run.status, 0, run.stderr)
  const r = result(run.stdout)
  assert.equal(r.killed, 0)
  assert.equal(r.survived, r.total - r.invalid)
})

test('timeouts and a missing test command are inconclusive, never kills', () => {
  const { dir } = fixture('export const big = n => n > 10\n', "import { big } from './calc.mjs'\nif (big(10)) setInterval(() => {}, 1000)\n")
  const run = mutate(dir, '--test', 'node check.mjs', '--timeout', '2', 'calc.mjs')
  assert.equal(run.status, 0, run.stderr)
  assert.ok(result(run.stdout).timeout >= 1)
  assert.equal(result(run.stdout).killed + result(run.stdout).timeout + result(run.stdout).survived, result(run.stdout).total)
  const missing = mutate(dir, '--test', 'definitely-not-a-command-xyz', 'calc.mjs')
  assert.equal(missing.status, 1)
  assert.match(missing.stderr, /fails on unmutated code.*infra/s)
})

test('over-budget mutants and unsupported files stay visible', () => {
  const { dir } = fixture('export const big = n => n > 10 && n < 99\n', "import { big } from './calc.mjs'\nif (!big(11)) process.exit(1)\n")
  writeFileSync(join(dir, 'page.haml'), '%p x == 1\n')
  spawnSync('git', ['add', '.'], { cwd: dir }); spawnSync('git', ['commit', '-qm', 'haml'], { cwd: dir })
  const run = mutate(dir, '--test', 'node check.mjs', '--max', '1', 'calc.mjs', 'page.haml')
  const r = result(run.stdout)
  assert.equal(r.total, 1)
  assert.ok(r.skipped >= 1)
  assert.deepEqual(r.unsupported, ['page.haml'])
})

for (const signal of ['SIGTERM', 'SIGKILL']) {
  test(`${signal} mid-run never changes the checkout`, async () => {
    const source = 'export const big = n => n > 10\n'
    const { dir, git } = fixture(source, "import { big } from './calc.mjs'\nsetTimeout(() => { if (!big(11)) process.exit(1) }, 3000)\n")
    const child = spawn('node', [SCRIPT, '--base', 'base', '--test', 'node check.mjs', 'calc.mjs'], { cwd: dir })
    await new Promise(ok => setTimeout(ok, 4500)) // baseline done, first mutant running
    child.kill(signal)
    await new Promise(ok => child.on('close', ok))
    assert.equal(readFileSync(join(dir, 'calc.mjs'), 'utf8'), source)
    assert.equal(git('status', '--porcelain'), '')
    if (signal === 'SIGTERM') assert.equal(readdirSync(tmpdir()).filter(n => n.startsWith(`story-loop-mut-${child.pid}-`)).length, 0)
    else {
      // the next run removes what a hard kill left behind
      mutate(dir, '--test', 'node -e 0', 'calc.mjs')
      assert.equal(readdirSync(tmpdir()).filter(n => n.startsWith(`story-loop-mut-${child.pid}-`)).length, 0)
    }
  })
}

// ---- regressions from the 0.7.0 reliability review ------------------------------
const LOOP = fileURLToPath(new URL('../skills/story-loop/scripts/loop.mjs', import.meta.url))
const WEAK = "import { big } from './calc.mjs'\nif (!big(11) || big(5)) process.exit(1)\n"

test('H06: a changed source file left out of the call, and a surviving mutant, block test review until decided', () => {
  const { dir, git } = fixture('export const big = n => n > 10\n', WEAK)
  writeFileSync(join(dir, 'other.mjs'), 'export const small = n => n < 3\n')
  writeFileSync(join(dir, 'notes.md'), 'docs\n')
  git('add', '.'); git('commit', '-qm', 'second file')
  withRun(dir)
  const run = mutate(dir, '--test', 'node check.mjs', 'calc.mjs')
  assert.match(run.stdout, /Changed source files not mutated in this call: other\.mjs/)
  assert.match(run.stdout, /cannot mutate.*notes\.md/)
  let m = load(dir).evidence.mutants
  assert.deepEqual([m.scope, m.covered, m.outside], [['calc.mjs', 'other.mjs'], ['calc.mjs'], ['notes.md']])
  assert.match(mutantsProblem(m), /changed source files were not mutated: other\.mjs/)
  assert.equal(mutate(dir, '--test', 'node check.mjs', 'other.mjs').status, 0)
  m = load(dir).evidence.mutants
  assert.deepEqual(m.covered, ['calc.mjs', 'other.mjs'])
  const survivors = Object.entries(m.outcomes).filter(([, o]) => o === 'survived').map(([id]) => id)
  assert.ok(survivors.length >= 2) // nothing tests other.mjs at all
  assert.match(mutantsProblem(m), new RegExp(`${survivors.length} mutants need a decision`))
  const cli = (...args) => spawnSync('node', [LOOP, ...args], { cwd: dir, encoding: 'utf8' })
  assert.match(cli('mutant', 'accept', 'no-such-id', 'x').stderr, /neither a mutant id nor a changed source file/)
  for (const id of survivors) assert.equal(cli('mutant', 'accept', id, 'equivalent: the caller never passes the boundary value').status, 0)
  m = load(dir).evidence.mutants
  assert.equal(mutantsProblem(m), null)
  assert.equal(m.survived, survivors.length, 'an accepted mutant is still a survivor, not a kill')
})

// A repo where pad<ext> changed to a line whose only mutant no longer parses, with a "test"
// that stands in for any runner that only loads the file: it fails exactly then.
function unparsable(ext) {
  const r = repo()
  const file = `pad${ext}`
  writeFileSync(join(r.dir, 'load.cjs'), `if (/"\\\\[1-9]"/.test(require('fs').readFileSync(${JSON.stringify(file)}, 'utf8'))) { console.error('SyntaxError: octal escape'); process.exit(1) }\n`)
  writeFileSync(join(r.dir, file), 'export const padding = ""\n')
  r.git('add', '.'); r.git('commit', '-qm', 'base'); r.git('branch', 'base')
  writeFileSync(join(r.dir, file), 'export const padding = "\\0"\n')
  r.git('commit', '-qam', 'change')
  withRun(r.dir)
  return { ...r, file }
}
// The compiler-present branch needs a typescript package. story-loop has no dependencies, so it
// comes from wherever these tests run, or from STORY_LOOP_TEST_NODE_MODULES=<a node_modules with typescript>.
let typescript = null
for (const from of [import.meta.url, process.env.STORY_LOOP_TEST_NODE_MODULES && join(process.env.STORY_LOOP_TEST_NODE_MODULES, 'x.js')].filter(Boolean))
  try { typescript ??= createRequire(from).resolve('typescript/package.json') } catch {}

for (const ext of ['.ts', '.tsx', '.jsx']) {
  test(`H07: without a compiler, an unparsable ${ext} mutant that fails the tests is unverified, not a kill`, () => {
    const { dir, file } = unparsable(ext)
    // nothing can tell a parse error from a caught change
    const run = mutate(dir, '--test', 'node load.cjs', file)
    assert.equal(run.status, 0, run.stderr)
    assert.deepEqual([result(run.stdout).killed, result(run.stdout).valid, result(run.stdout).unverified], [0, 0, 1])
    assert.match(mutantsProblem(load(dir).evidence.mutants), /no valid mutant ran/)
  })
  // Its own test, so a machine without typescript reports a skip instead of a pass that checked nothing.
  test(`H07: with the project's typescript, an unparsable ${ext} mutant is recognised as invalid code`, t => {
    if (!typescript) return t.skip('typescript is not installed here; set STORY_LOOP_TEST_NODE_MODULES=<a node_modules that has typescript> to run this branch')
    const { dir, file } = unparsable(ext)
    mkdirSync(join(dir, 'node_modules'))
    symlinkSync(join(typescript, '..'), join(dir, 'node_modules', 'typescript'))
    const run = mutate(dir, '--test', 'node load.cjs', file)
    assert.equal(run.status, 0, run.stderr)
    assert.deepEqual([result(run.stdout).killed, result(run.stdout).invalid, result(run.stdout).unverified], [0, 1, 0])
  })
}

test('H08: a test run that dies of a signal behind a shell is inconclusive, not a kill', () => {
  // The runner is the shell's child here, so the signal reaches us as exit code 143.
  const { dir } = fixture('export const big = n => n > 10\n', "import { big } from './calc.mjs'\nif (!big(11) || big(10)) process.kill(process.pid, 'SIGTERM')\n")
  withRun(dir)
  const run = mutate(dir, '--test', 'node check.mjs && true', 'calc.mjs')
  assert.equal(run.status, 0, run.stderr)
  const r = result(run.stdout)
  assert.equal(r.killed, 0)
  assert.ok(r.inconclusive >= 1)
  assert.match(mutantsProblem(load(dir).evidence.mutants), /inconclusive/)
})

test('H09: a source symlink that leaves the disposable copy is never written through', () => {
  for (const escape of ['absolute', 'relative']) {
    const source = 'export const big = n => n > 10\n'
    const { dir, git } = fixture(source, WEAK)
    const outside = join(mkdtempSync(join(tmpdir(), 'sl-shared-')), 'shared.mjs')
    writeFileSync(outside, source)
    // absolute: into the real checkout; relative: up and out of the repository
    symlinkSync(escape === 'absolute' ? join(dir, 'calc.mjs') : join('..', '..', '..', '..', '..', '..', '..', '..', outside), join(dir, 'link.mjs'))
    git('add', 'link.mjs'); git('commit', '-qm', 'link')
    const run = mutate(dir, '--test', 'node check.mjs', 'link.mjs')
    assert.equal(run.status, 0, run.stderr)
    assert.match(run.stdout, /skip link\.mjs \(it resolves outside the disposable copy/)
    assert.deepEqual([result(run.stdout).total, result(run.stdout).unsupported], [0, ['link.mjs']])
    assert.equal(readFileSync(join(dir, 'calc.mjs'), 'utf8'), source)
    assert.equal(readFileSync(outside, 'utf8'), source)
    assert.equal(git('status', '--porcelain'), '')
  }
})

test('H19: a retry on the same code replaces the earlier outcome of each mutant; the first log stays', () => {
  const { dir } = fixture('export const big = n => n > 10\n', WEAK)
  withRun(dir)
  const flag = join(mkdtempSync(join(tmpdir(), 'sl-flag-')), 'baseline-done')
  // first call: the baseline passes, then the "infrastructure" is down for every mutant
  const first = mutate(dir, '--test', `if [ -f ${flag} ]; then exit 127; fi; touch ${flag}`, 'calc.mjs')
  assert.equal(first.status, 0, first.stderr)
  let m = load(dir).evidence.mutants
  assert.deepEqual([m.infra, m.valid, m.total], [2, 0, 2])
  assert.match(mutantsProblem(m), /inconclusive/)
  // the cause is fixed and the same mutants run again
  assert.equal(mutate(dir, '--test', 'node check.mjs', 'calc.mjs').status, 0)
  m = load(dir).evidence.mutants
  assert.deepEqual([m.infra, m.killed, m.survived, m.total], [0, 1, 1, 2], 'no failure carried over, no mutant counted twice')
  assert.doesNotMatch(mutantsProblem(m), /inconclusive/)
  assert.equal(m.logs.length, 2)
  assert.ok(m.logs.every(log => existsSync(log)))
  assert.equal(JSON.parse(readFileSync(m.logs[0], 'utf8')).infra, 2, 'the first attempt is kept as history')
})

// ---- regressions from the 0.8.0 review -------------------------------------------

// Tests that take a moment, so there is time to change the run while the mutants are out.
const SLOW = "import { big } from './calc.mjs'\nsetTimeout(() => { if (!big(11) || big(5)) process.exit(1) }, 700)\n"
const wait = ms => new Promise(ok => setTimeout(ok, ms))
const storyDir = (dir, story = 'sc-1') => join(dir, '.start-story', story)
const logs = (dir, story) => readdirSync(storyDir(dir, story)).filter(n => /^mutants-.*\.json$/.test(n)).map(n => JSON.parse(readFileSync(join(storyDir(dir, story), n), 'utf8')))
// Starts mutate.mjs and resolves `started` once it is listed in the run (its baseline is about to run).
function background(dir, { inRun = true } = {}) {
  const child = spawn('node', [SCRIPT, '--base', 'base', '--test', 'node check.mjs', 'calc.mjs'], { cwd: dir })
  let stderr = ''
  child.stderr.on('data', chunk => { stderr += chunk })
  const closed = new Promise(ok => child.on('close', (code, signal) => ok({ code, signal, stderr })))
  const started = (async () => {
    for (let i = 0; inRun && i < 100 && !Object.keys(load(dir).ops ?? {}).length; i++) await wait(30)
    await wait(200)
  })()
  return { child, closed, started }
}

test('R2: mutants that finish after their run was replaced are not the new run\'s evidence', async () => {
  const { dir } = fixture('export const big = n => n > 10\n', SLOW)
  const first = withRun(dir)
  const { closed, started } = background(dir)
  await started
  assert.match(spawnSync('node', [LOOP, 'status'], { cwd: dir, encoding: 'utf8' }).stdout, /outstanding: mutate \w+ for test_review attempt 1.*still running/)
  // The run is replaced without anyone asking the helper to stop (the race `end` cannot close by signalling).
  mkdirSync(storyDir(dir), { recursive: true })
  renameSync(join(dir, '.start-story', 'active.json'), join(storyDir(dir), 'run-1.json'))
  assert.equal(spawnSync('node', [LOOP, 'init', 'gh-2'], { cwd: dir }).status, 0)
  const done = await closed
  assert.equal(done.code, 4, done.stderr)
  assert.match(done.stderr, /this mutate finished for sc-1 run .* but run .* is no longer the active run; gh-2 run .* is/)
  const now = load(dir)
  assert.deepEqual([now.story, now.evidence, now.ops], ['gh-2', {}, undefined], 'the new run has no mutation evidence')
  assert.equal(existsSync(storyDir(dir, 'gh-2')), false, 'and nothing was written into its folder')
  const [log] = logs(dir)
  assert.deepEqual([log.status, log.run, log.attempt], ['finished', first.id, 1], 'the log stays with the run it was for')
  const [stale] = readdirSync(join(storyDir(dir), 'stale'))
  assert.match(JSON.parse(readFileSync(join(storyDir(dir), 'stale', stale), 'utf8')).why, /no longer the active run/)
})

test('R2: ending a run asks its mutation helper to stop, and what it had is kept as interrupted, not as evidence', async () => {
  const { dir, git } = fixture('export const big = n => n > 10\n', SLOW)
  withRun(dir)
  const { child, closed, started } = background(dir)
  await started
  const ended = spawnSync('node', [LOOP, 'end'], { cwd: dir, encoding: 'utf8' })
  assert.match(ended.stdout, /1 helper was still working for it \(mutate\) and asked to stop/)
  const done = await closed
  assert.notEqual(done.code, 0)
  assert.equal(spawnSync('node', [LOOP, 'init', 'gh-2'], { cwd: dir }).status, 0)
  assert.deepEqual(load(dir).evidence, {})
  assert.deepEqual(logs(dir).map(l => [l.status, l.signal]), [['interrupted', 'SIGTERM']])
  assert.equal(git('status', '--porcelain'), '')
  assert.equal(readdirSync(tmpdir()).filter(n => n.startsWith(`story-loop-mut-${child.pid}-`)).length, 0)
})

test('R2: mutants from before a return to build are not the next attempt\'s evidence; a stale error changes nothing either', async () => {
  const { dir } = fixture('export const big = n => n > 10\n', SLOW)
  withRun(dir)
  const { closed, started } = background(dir)
  await started
  // back to build: the same run, every stage from build on is on its next attempt
  update(dir, r => { for (const id of ['build', 'test_review']) r.stages[id].attempt = 2; r.evidence = {}; return r })
  const done = await closed
  assert.equal(done.code, 4, done.stderr)
  assert.match(done.stderr, /test_review is on attempt 2; this mutate started in attempt 1/)
  assert.deepEqual(load(dir).evidence, {})
  assert.deepEqual(load(dir).ops, {}, 'the helper is no longer listed')
})

test('R2: a mutation run started with no run active never attaches itself to one that appears later', async () => {
  const { dir } = fixture('export const big = n => n > 10\n', SLOW)
  const { closed } = background(dir, { inRun: false })
  await wait(500)
  withRun(dir)
  const done = await closed
  assert.equal(done.code, 0, done.stderr)
  assert.deepEqual([load(dir).evidence, load(dir).ops], [{}, undefined])
  assert.equal(existsSync(storyDir(dir)), false)
})

test('R2: results merge only with evidence of the same run, attempt, tree and base', () => {
  const { dir } = fixture('export const big = n => n > 10\n', WEAK)
  const first = withRun(dir)
  assert.equal(mutate(dir, '--test', 'node check.mjs', 'calc.mjs').status, 0)
  const good = load(dir).evidence.mutants
  assert.deepEqual([good.run, good.attempt, good.total], [first.id, 1, 2])
  for (const patch of [{ run: 'another-run' }, { attempt: 7 }, { base: 'f'.repeat(40) }, { tree: 'e'.repeat(40) }]) {
    // evidence of another identity, with an outcome these mutants never produced
    update(dir, r => ({ ...r, evidence: { mutants: { ...good, ...patch, outcomes: { ...good.outcomes, 'ghost.mjs:1:aaaaaa': 'killed' }, covered: ['ghost.mjs'] } } }))
    assert.equal(mutate(dir, '--test', 'node check.mjs', 'calc.mjs').status, 0)
    const m = load(dir).evidence.mutants
    assert.deepEqual([Object.keys(m.outcomes).length, m.covered, m.logs.length], [2, ['calc.mjs'], 1], JSON.stringify(patch))
  }
  // the same identity still merges: a retry keeps the earlier log and adds no mutant
  assert.equal(mutate(dir, '--test', 'node check.mjs', 'calc.mjs').status, 0)
  assert.deepEqual([load(dir).evidence.mutants.total, load(dir).evidence.mutants.logs.length], [2, 2])
})

test('R10: with diagnostics on, a mutation run records its scope, its baseline, every mutant and its end', () => {
  const { dir, git } = fixture('export const big = n => n > 10\n', WEAK)
  const run = withRun(dir, { diagnostics: { enabled: true } })
  const token = `ghp_${'k'.repeat(36)}`.replace(/k/g, () => Math.floor(Math.random() * 10))
  assert.equal(mutate(dir, '--test', `API_TOKEN=${token} node check.mjs`, 'calc.mjs').status, 0)
  const { events } = readEvents(diagDir(dir, 'sc-1', run.id))
  const [start] = events.filter(e => e.kind === 'op.start')
  assert.deepEqual([start.details.kind, start.stage, start.attempt, start.tree, start.details.files, start.details.requested_base, start.details.merge_base],
    ['mutate', 'test_review', 1, git('rev-parse', 'HEAD^{tree}'), ['calc.mjs'], 'base', git('rev-parse', 'base')])
  assert.equal(JSON.stringify(events).includes(token), false, 'the test command is recorded without what looked like a token')
  assert.deepEqual(events.filter(e => e.kind === 'mutate.baseline').map(e => e.outcome), ['started', 'ok'])
  const mutants = events.filter(e => e.kind === 'mutate.mutant')
  assert.deepEqual(mutants.map(e => [e.outcome, e.details.syntax_checked]).sort(), [['killed', true], ['survived', true]])
  assert.ok(mutants.every(e => e.op === start.op && /^calc\.mjs:1:[0-9a-f]{6}$/.test(e.details.mutant) && Number.isFinite(e.elapsed_ms)))
  assert.deepEqual(events.filter(e => e.kind === 'mutate.cleanup').map(e => e.outcome), ['ok'])
  const end = events.find(e => e.kind === 'op.end')
  assert.deepEqual([end.outcome, end.reason, end.op, end.details.ownership_changed], ['ok', '1 of 2 valid killed', start.op, false])
})

test('R10: a baseline that fails is kept with its output, and leaves no evidence and no listed helper', () => {
  const { dir } = fixture('export const big = n => n > 10\n', WEAK)
  withRun(dir)
  const run = mutate(dir, '--test', 'echo the suite is broken; exit 1', 'calc.mjs')
  assert.equal(run.status, 1)
  assert.match(run.stderr, /fails on unmutated code/)
  const [log] = logs(dir)
  assert.deepEqual([log.status, log.outcome, log.code], ['baseline_failed', 'failed', 1])
  assert.match(log.output, /the suite is broken/)
  assert.deepEqual([load(dir).evidence, load(dir).ops], [{}, {}])
  for (const bad of [['--timeout', 'soon'], ['--max', '0'], ['--timeout', '-1']])
    assert.match(mutate(dir, '--test', 'node check.mjs', ...bad, 'calc.mjs').stderr, /needs a positive number/, bad.join(' '))
})

test('a second attempt on other code runs every mutant again: earlier kills are history', () => {
  const source = 'export const big = n => n > 10 && n < 100\n'
  const r = fixture(source, "import { big } from './calc.mjs'\nimport { small } from './other.mjs'\nif (!big(11) || big(5) || big(500) || !small(1)) process.exit(1)\n")
  writeFileSync(join(r.dir, 'other.mjs'), 'export const small = n => n < 3\n')
  r.git('add', '.'); r.git('commit', '-qm', 'other')
  const { dir } = r
  withRun(dir)
  const first = mutate(dir, '--test', 'node check.mjs', 'calc.mjs', 'other.mjs')
  assert.equal(first.status, 0, first.stderr)
  const killedFirst = result(first.stdout).killed
  assert.ok(killedFirst > 0)
  // The run goes back to build: the evidence becomes history, as `back` does.
  update(dir, run => ({ ...run, history: [...(run.history ?? []), { at: 'x', from: 'second_review', to: 'build', evidence: run.evidence }], evidence: {} }))
  writeFileSync(join(dir, 'other.mjs'), 'export const small = n => n < 4\n')
  r.git('commit', '-qam', 'round 2')
  const second = mutate(dir, '--test', 'node check.mjs', 'calc.mjs', 'other.mjs')
  assert.equal(second.status, 0, second.stderr)
  assert.match(second.stdout, /nothing taken over from the earlier results: kills on earlier code are history/)
  assert.doesNotMatch(second.stdout, /^carried /m)
  assert.equal(result(second.stdout).carried, 0)
  assert.deepEqual(load(dir).evidence.mutants.carried, [])
})
