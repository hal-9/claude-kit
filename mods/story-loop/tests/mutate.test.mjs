import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, readFileSync, readdirSync, symlinkSync, mkdirSync, mkdtempSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { spawn, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mutantsFor, changedLines, classify } from '../skills/story-loop/scripts/mutate.mjs'
import { load, mutantsProblem } from '../skills/story-loop/scripts/loop.mjs'
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

for (const ext of ['.ts', '.tsx', '.jsx']) {
  test(`H07: an unparsable ${ext} mutant that fails the tests is not a kill`, () => {
    const r = repo()
    const file = `pad${ext}`
    // The "test" stands in for any runner that only loads the file: it fails exactly when the file no longer parses.
    writeFileSync(join(r.dir, 'load.cjs'), `if (/"\\\\[1-9]"/.test(require('fs').readFileSync(${JSON.stringify(file)}, 'utf8'))) { console.error('SyntaxError: octal escape'); process.exit(1) }\n`)
    writeFileSync(join(r.dir, file), 'export const padding = ""\n')
    r.git('add', '.'); r.git('commit', '-qm', 'base'); r.git('branch', 'base')
    writeFileSync(join(r.dir, file), 'export const padding = "\\0"\n')
    r.git('commit', '-qam', 'change')
    withRun(r.dir)
    // without the project's typescript nothing can tell a parse error from a caught change
    let run = mutate(r.dir, '--test', 'node load.cjs', file)
    assert.equal(run.status, 0, run.stderr)
    assert.deepEqual([result(run.stdout).killed, result(run.stdout).valid, result(run.stdout).unverified], [0, 0, 1])
    assert.match(mutantsProblem(load(r.dir).evidence.mutants), /no valid mutant ran/)
    // with it, the mutant is recognised as invalid code
    let typescript = null
    for (const from of [import.meta.url, process.env.STORY_LOOP_TEST_NODE_MODULES && join(process.env.STORY_LOOP_TEST_NODE_MODULES, 'x.js')].filter(Boolean))
      try { typescript ??= createRequire(from).resolve('typescript/package.json') } catch {}
    if (!typescript) return
    mkdirSync(join(r.dir, 'node_modules'))
    symlinkSync(join(typescript, '..'), join(r.dir, 'node_modules', 'typescript'))
    run = mutate(r.dir, '--test', 'node load.cjs', file)
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
