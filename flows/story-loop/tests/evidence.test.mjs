// Regressions for the 2026-11-25 audit of story-loop 0.15.0: evidence that described
// other inputs than it was accepted for, and a publisher that trusted a loose URL match.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  remoteRepo, issueRepo, storyId, load, update, staleStages, passProblem, verifyCarry, reviewScope, parallelWorktree, verifyRequest, headTree, headCommit,
} from '../skills/story-loop/scripts/loop.mjs'
import { destinationProblem } from '../skills/story-loop/scripts/publish.mjs'
import { carriedKills } from '../skills/story-loop/scripts/mutate.mjs'
import { acquire, release } from '../skills/story-loop/scripts/lease.mjs'
import { repo, withRun, ENV } from './helpers.mjs'

const script = name => fileURLToPath(new URL(`../skills/story-loop/scripts/${name}`, import.meta.url))
const cli = (cwd, ...args) => spawnSync('node', [script('loop.mjs'), ...args], { cwd, encoding: 'utf8' })

// ---- 4.1 publication target ------------------------------------------------------

test('only a real github.com remote of the run\'s repository is a publication target', () => {
  const hostile = [
    'https://notgithub.com/acme/app.git',
    'https://attacker.invalid/github.com/acme/app.git',
    '/tmp/x/github.com/acme/app.git',
    'file:///tmp/github.com/acme/app.git',
    'https://github.com.attacker.invalid/acme/app.git',
    'https://github.com/acme/app.git?x=1',
    'https://github.com/acme/app.git#frag',
    'https://github.com/acme/app/extra',
    'https://github.com/acme/%61pp.git',
    'http://github.com/acme/app.git',
    'git://github.com/acme/app.git',
    'https://github.com:8443/acme/app.git',
    'ssh://evil@github.com/acme/app.git',
    'ssh://git@github.com:2222/acme/app.git',
    'ssh://git@github.com:22/acme/app.git',
    'evil@github.com:acme/app.git',
    'git@github.com:acme/app.git/../other',
    'git@github.com:../acme/app.git',
    'https://github.com/acme/..',
    'https://github.com/-acme/app',
    'ext::sh -c touch% /tmp/pwned',
  ]
  // The tests' switch for local bare remotes is off here: a path is refused like any unknown host.
  const local = process.env.STORY_LOOP_LOCAL_REMOTE
  delete process.env.STORY_LOOP_LOCAL_REMOTE
  try {
    for (const url of hostile) {
      assert.equal(remoteRepo(url), null, url)
      assert.ok(destinationProblem({ repo: 'acme/app' }, url), url)
    }
  } finally { process.env.STORY_LOOP_LOCAL_REMOTE = local }
  for (const url of ['git@github.com:acme/app.git', 'git@github.com:Acme/App', 'ssh://git@github.com/acme/app.git',
    'https://github.com/acme/app', 'https://github.com/acme/app.git', 'https://github.com/acme/app/', 'https://x-access-token@github.com/acme/app.git']) {
    assert.equal(remoteRepo(url), 'acme/app', url)
    assert.equal(destinationProblem({ repo: 'acme/app' }, url), null, url)
  }
  assert.match(destinationProblem({ repo: 'acme/app' }, 'git@github.com:acme/fork.git'), /pushes to acme\/fork/)
})

test('an issue URL is a github.com issue of one repository, nothing that merely contains one', () => {
  assert.equal(issueRepo('https://github.com/acme/app/issues/12'), 'acme/app')
  assert.equal(storyId('https://github.com/acme/app/issues/12'), 'gh-12')
  for (const url of ['https://attacker.invalid/github.com/acme/app/issues/12', 'https://notgithub.com/acme/app/issues/12', 'https://github.com/acme/app/issues/12?x=1']) {
    assert.equal(issueRepo(url), null, url)
    assert.equal(storyId(url), null, url)
  }
})

// ---- 4.2 quality checks the subject it froze ------------------------------------

test('a commit made while lint runs is not certified by that lint', () => {
  const { dir, commit } = repo()
  commit('app.js', 'one\n')
  withRun(dir)
  update(dir, r => { r.stages.contract.status = 'passed'; r.stages.build.status = 'passed'; r.stages.quality.status = 'running'; return r })
  // The "linter" commits new code while it runs, then reports clean.
  const sneaky = `printf 'two\\n' > app.js && git add app.js && git -c commit.gpgsign=false commit -qm sneak && exit 0`
  const out = spawnSync('node', [script('quality.mjs'), '--lint', sneaky], { cwd: dir, encoding: 'utf8' })
  assert.notEqual(out.status, 0, out.stdout)
  assert.match(out.stderr, /moved|changed while|stale/i)
  assert.ok(passProblem(dir, load(dir), 'quality'), 'the gate must not pass on code lint never saw')
})

test('quality evidence for another lint command set or policy does not stand', () => {
  const { dir, commit } = repo()
  commit('app.js', 'one\n')
  withRun(dir)
  update(dir, r => { r.stages.contract.status = 'passed'; r.stages.build.status = 'passed'; r.stages.quality.status = 'running'; return r })
  assert.equal(spawnSync('node', [script('quality.mjs'), '--lint', 'true'], { cwd: dir, encoding: 'utf8' }).status, 0)
  assert.equal(passProblem(dir, load(dir), 'quality'), null)
  // A changed lint configuration is a changed input.
  commit('.eslintrc.json', '{}\n')
  assert.ok(passProblem(dir, load(dir), 'quality'))
})

// ---- 4.3 the approved matrix ------------------------------------------------------

function verifiedWhileSiblingRuns(dir) {
  update(dir, r => {
    for (const id of ['contract', 'build', 'quality']) r.stages[id].status = 'passed'
    r.stages.test_review.status = 'running'
    const tree = headTree(dir), commit = headCommit(dir)
    r.stages.verify = { ...r.stages.verify, status: 'passed', tree, commit, request: verifyRequest(r, tree, commit) }
    r.stages.second_review = { ...r.stages.second_review, status: 'passed', tree, commit }
    return r
  })
}

test('a check added while a parallel sibling runs reopens verify; publication stays blocked', () => {
  const { dir } = repo()
  withRun(dir, { checks: [{ id: 'a', step: 1 }], checks_revision: 1, environment: ENV })
  verifiedWhileSiblingRuns(dir)
  const set = cli(dir, 'checks', 'set', '[{"id":"a","step":1},{"id":"b","step":2}]')
  assert.equal(set.status, 0, set.stderr)
  const run = load(dir)
  assert.notEqual(run.stages.verify.status, 'passed', 'verify cannot stay passed on the old matrix')
  // Even if a state file says passed, the old request no longer covers the matrix.
  update(dir, r => { r.stages.verify.status = 'passed'; r.stages.test_review.status = 'passed'; r.stages.push.status = 'running'; return r })
  assert.ok(staleStages(dir, load(dir)).includes('verify'))
  assert.match(passProblem(dir, load(dir), 'push'), /verify/)
})

test('a changed environment makes a passed verify stale', () => {
  const { dir } = repo()
  withRun(dir, { checks: [{ id: 'a', step: 1 }], checks_revision: 1, environment: ENV })
  verifiedWhileSiblingRuns(dir)
  assert.equal(cli(dir, 'put', 'environment', JSON.stringify({ url: 'http://127.0.0.1:4000', kind: 'local' })).status, 0)
  const run = load(dir)
  assert.ok(run.stages.verify.status !== 'passed' || staleStages(dir, run).includes('verify'))
})

// ---- 4.4 mutation reuse ------------------------------------------------------------

test('kills from another tree are never carried, even on unchanged lines', () => {
  const run = { evidence: {}, history: [{ evidence: { mutants: { tree: 'old', base: 'b', outcomes: { 'f.js:1:aa': 'killed', 'f.js:2:bb': 'killed' } } } }] }
  const carry = carriedKills(run, { tree: 'new', base: 'b', changedSince: () => [{ status: 'M', file: 'caller.js', deleted: 1 }], linesSince: () => [] })
  assert.equal(carry.holds('f.js:1:aa', 'f.js', 1), false)
  assert.equal(carry.ids.size, 0)
})

test('a changed caller turns earlier kills into survivors: warm and cold runs agree', () => {
  const { dir, git } = repo()
  writeFileSync(join(dir, 'calc.mjs'), 'export const big = n => false\n')
  writeFileSync(join(dir, 'use.mjs'), "import { big } from './calc.mjs'\nexport const use = n => big(n)\n")
  writeFileSync(join(dir, 'check.mjs'), "import { use } from './use.mjs'\nif (!use(11) || use(5)) process.exit(1)\n")
  git('add', '.'); git('commit', '-qm', 'base'); git('branch', 'base')
  writeFileSync(join(dir, 'calc.mjs'), 'export const big = n => n > 10\n')
  git('commit', '-qam', 'change')
  withRun(dir)
  const mutate = () => spawnSync('node', [script('mutate.mjs'), '--base', 'base', '--test', 'node check.mjs', 'calc.mjs'], { cwd: dir, encoding: 'utf8' })
  const killed = out => JSON.parse(out.match(/RESULT (.*)/)[1]).killed
  assert.ok(killed(mutate().stdout) > 0)
  update(dir, r => ({ ...r, history: [...(r.history ?? []), { evidence: r.evidence }], evidence: {} }))
  // The caller stops exercising big(); the mutated file and the test are unchanged.
  writeFileSync(join(dir, 'use.mjs'), "import { big } from './calc.mjs'\nexport const use = n => n > 10\n")
  git('commit', '-qam', 'caller')
  const warm = killed(mutate().stdout)
  update(dir, r => ({ ...r, history: [], evidence: {} }))
  const cold = killed(mutate().stdout)
  assert.equal(warm, cold)
})

// ---- 4.5 conservative browser and review reuse ---------------------------------

test('a production-code change reruns the whole approved matrix', () => {
  const checks = [{ id: 'a', step: 1 }, { id: 'b', step: 2 }]
  const prior = { checks_revision: 1, environment: ENV.url, results: [{ id: 'a' }, { id: 'b' }] }
  // The shared component served both journeys before; the latest task names one.
  const tasks = [{ files: ['app/shared.tsx'], steps: [1, 2], attempt: 1 }, { files: ['app/shared.tsx'], steps: [1], attempt: 2 }]
  const plan = verifyCarry({ checks, checksRevision: 1, environment: ENV.url, prior, delta: ['app/shared.tsx'], tasks, attempt: 2 })
  assert.deepEqual(plan.rerun, ['a', 'b'])
  // Only tests changed: the application the browser saw is the same.
  assert.deepEqual(verifyCarry({ checks, checksRevision: 1, environment: ENV.url, prior, delta: ['spec/x_spec.rb'], tasks, attempt: 2 }).carry, ['a', 'b'])
})

test('test-only commits keep verify but not the second review', () => {
  const { dir, commit } = repo()
  commit('app.js', 'one\n')
  withRun(dir, { checks: [], checks_revision: 1 })
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).stdout.trim()
  const tree = spawnSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: dir, encoding: 'utf8' }).stdout.trim()
  update(dir, r => {
    for (const id of ['verify', 'second_review']) r.stages[id] = { ...r.stages[id], status: 'passed', tree, commit: head, request: { checks_revision: 1 } }
    return r
  })
  commit('app.test.js', 'test\n')
  assert.deepEqual(staleStages(dir, load(dir)).filter(s => ['verify', 'second_review'].includes(s)), ['second_review'])
  // A review of only the new tests is a delta review, not a full blind one.
  assert.equal(reviewScope({ prior: { commit: head }, delta: { files: ['app.test.js'], lines: 1, commits: ['c'] }, branchLines: 100, findings: [] }).scope, 'delta')
})

// ---- 6.1 resources -------------------------------------------------------------------

test('a removed worktree never hands its live neighbour\'s ports to a new story', () => {
  const { dir } = repo()
  const a = parallelWorktree(dir, 'sc-1', { fetch: false })
  const b = parallelWorktree(dir, 'sc-2', { fetch: false })
  spawnSync('git', ['worktree', 'remove', '--force', a.dir], { cwd: dir })
  rmSync(a.dir, { recursive: true, force: true })
  const c = parallelWorktree(dir, 'sc-3', { fetch: false })
  assert.notDeepEqual(c.ports, b.ports)
  assert.notEqual(c.ports.app, b.ports.app)
  assert.notEqual(c.ports.board, b.ports.board)
})

test('a lease has one live owner; a dead owner\'s lease is reclaimed', () => {
  const { dir } = repo()
  const one = acquire(dir, 'slot', { pid: process.pid })
  const two = acquire(dir, 'slot', { pid: process.pid })
  assert.notEqual(one, two)
  release(dir, 'slot', one)
  assert.equal(acquire(dir, 'slot', { pid: process.pid }), one)
  // A pid that no longer runs holds nothing.
  const dead = spawnSync('node', ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout
  const held = acquire(dir, 'other', { pid: Number(dead) })
  assert.equal(acquire(dir, 'other', { pid: process.pid }), held)
})
