import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mutantsFor, changedLines, classify } from '../skills/story-loop/scripts/mutate.mjs'
import { load } from '../skills/story-loop/scripts/loop.mjs'
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
