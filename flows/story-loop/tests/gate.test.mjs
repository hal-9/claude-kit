// Regressions for the 2026-11-26 audit of story-loop 0.20.0: one gate decision for stage
// gates, publication, readiness, the report and the board. Each test drives the real CLI
// and helper scripts against a disposable repository and a local bare remote.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { load, update, gateProblems, staleStages, passProblem, opStart, opUpdate, opEnd, claimKey } from '../skills/story-loop/scripts/loop.mjs'
import { publish } from '../skills/story-loop/scripts/publish.mjs'
import { repo, withRun, greenEvidence, B } from './helpers.mjs'

const script = name => fileURLToPath(new URL(`../skills/story-loop/scripts/${name}`, import.meta.url))
const cli = (cwd, ...args) => spawnSync('node', [script('loop.mjs'), ...args], { cwd, encoding: 'utf8' })
const quality = (cwd, ...args) => spawnSync('node', [script('quality.mjs'), ...args], { cwd, encoding: 'utf8' })
const remoteHead = (origin) => spawnSync('git', ['ls-remote', origin, `refs/heads/${B}`], { encoding: 'utf8' }).stdout.trim()
const ok = r => { assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`); return r }

// Contract and build through the CLI, quality through quality.mjs: a run standing at quality.
function atQuality({ remote = true } = {}) {
  const r = repo({ remote })
  r.commit('feature.js', 'export const f = () => 1\n')
  withRun(r.dir)
  ok(cli(r.dir, 'start', 'contract')); ok(cli(r.dir, 'pass', 'contract'))
  ok(cli(r.dir, 'put', 'tasks', '[{"id":"t1","title":"feature","status":"accepted"}]'))
  ok(cli(r.dir, 'start', 'build')); ok(cli(r.dir, 'pass', 'build'))
  ok(cli(r.dir, 'start', 'quality'))
  return r
}
// The remaining evidence stages from controlled fixture evidence, then the push stage started.
function toPush(dir, keepQuality = true) {
  update(dir, r => {
    const quality = r.evidence.quality
    for (const id of ['test_review', 'verify', 'second_review']) r.stages[id].status = 'passed'
    greenEvidence(r, dir)
    if (keepQuality) r.evidence.quality = quality
    r.stages.push.status = 'running'
    return r
  })
}

test('A: a failed quality rerun after a pass leaves nothing publishable; the remote is untouched', () => {
  const { dir, origin } = atQuality()
  ok(quality(dir, '--lint', 'true'))
  ok(cli(dir, 'pass', 'quality'))
  // Same committed tree, the lint now fails.
  assert.equal(quality(dir, '--lint', 'echo offense; exit 1').status, 1)
  const run = load(dir)
  assert.equal(run.stages.quality.status, 'passed', 'the stage stays passed in history')
  assert.match(gateProblems(dir, run).quality, /lint failed/, 'but its gate is decided from the newest result')
  toPush(dir)
  const before = remoteHead(origin)
  assert.throws(() => publish(dir), /quality: lint failed.*nothing was pushed/)
  assert.equal(remoteHead(origin), before, 'no ref reached the remote')
  // The board, the CLI status and the stage gate say the same.
  assert.deepEqual(staleStages(dir, load(dir)), ['quality'])
  assert.match(cli(dir, 'status').stdout, /NOT CURRENT: quality: lint failed/)
  assert.match(passProblem(dir, load(dir), 'push'), /quality: lint failed/)
  // A clean replacement makes it publishable again.
  ok(quality(dir, '--lint', 'true'))
  assert.equal(publish(dir).length, 40)
  assert.notEqual(remoteHead(origin), before)
})

test('A: a failing rerun after every review finished, right before publication, is refused too', () => {
  const { dir, origin } = atQuality()
  ok(quality(dir, '--lint', 'true'))
  ok(cli(dir, 'pass', 'quality'))
  toPush(dir)
  assert.equal(quality(dir, '--lint', 'exit 2').status, 1)
  assert.throws(() => publish(dir), /quality: lint failed/)
  assert.equal(remoteHead(origin), '')
})

test('a required replacement still running holds the gate; a crashed one too', () => {
  const { dir, origin } = atQuality()
  ok(quality(dir, '--lint', 'true'))
  ok(cli(dir, 'pass', 'quality'))
  toPush(dir)
  // A replacement started and is running (its process is alive).
  update(dir, r => ({ ...r, claims: { ...r.claims, [claimKey('quality', 'quality')]: { op: 'q2', kind: 'quality', seq: 99, state: 'running', pid: process.pid } } }))
  assert.throws(() => publish(dir), /replacement quality for quality is still running/)
  // Its process died without a result.
  update(dir, r => ({ ...r, claims: { ...r.claims, [claimKey('quality', 'quality')]: { ...r.claims['quality:quality'], pid: 2 ** 22 + 7 } } }))
  assert.throws(() => publish(dir), /was interrupted/)
  assert.equal(remoteHead(origin), '')
})

test('A starts, B replaces it, B fails, A finishes late: B decides', () => {
  const { dir } = atQuality({ remote: false })
  // A: a slow clean lint, started first.
  const a = spawn('node', [script('quality.mjs'), '--lint', 'sleep 1.5; exit 0'], { cwd: dir })
  let aErr = ''
  a.stderr.on('data', d => { aErr += d })
  for (let i = 0; i < 100 && !Object.keys(load(dir).claims ?? {}).length; i++) spawnSync('sleep', ['0.05'])
  // B: started after A, fails fast.
  assert.equal(quality(dir, '--lint', 'exit 1').status, 1)
  return new Promise(done => a.on('close', code => {
    assert.equal(code, 4, `A's late result is refused as stale: ${aErr}`)
    assert.match(aErr, /newer quality .* replaced quality/)
    const run = load(dir)
    assert.equal(run.evidence.quality.lint[0].exit, 1, 'the evidence is still B\'s')
    assert.match(passProblem(dir, run, 'quality'), /lint failed/)
    done()
  }))
})

test('out-of-order completion in-process: the newest claim of a unit is its authority', () => {
  const { dir } = repo()
  withRun(dir)
  const write = (ctx, exit) => opUpdate(dir, ctx, r => ({ ...r, evidence: { ...r.evidence, quality: { exit, op: ctx.op } } }), {})
  const A = opStart(dir, 'quality', 'quality', {}, ['quality'])
  const Bctx = opStart(dir, 'quality', 'quality', {}, ['quality'])
  write(Bctx, 1)
  opEnd(dir, Bctx, 'ok')
  assert.throws(() => write(A, 0), e => e.kind === 'stale')
  opEnd(dir, A, 'stale')
  assert.equal(load(dir).evidence.quality.exit, 1)
  assert.equal(load(dir).claims['quality:quality'].state, 'done')
  // A replacement that ends without a result leaves the unit failed, whatever came before.
  const C = opStart(dir, 'quality', 'quality', {}, ['quality'])
  opEnd(dir, C, 'failed', 'git broke')
  assert.match(load(dir).claims['quality:quality'].reason, /git broke/)
})

test('B: retargeting the base invalidates every diff-scoped result; a fresh scan against the new base decides', () => {
  const r = repo({ remote: false })
  const { dir, git } = r
  // release has app.js with a lint-disable; main does not.
  git('checkout', '-q', 'main'); git('checkout', '-qb', 'release')
  writeFileSync(join(dir, 'app.js'), '// eslint-disable-next-line\nexport const a = 1\n')
  git('add', '.'); git('commit', '-qm', 'release work')
  git('checkout', '-q', B); git('reset', '-q', '--hard', 'release')
  r.commit('feature.js', 'export const f = () => 1\n')
  withRun(dir, { base: 'release' })
  update(dir, x => { x.stages.contract.status = 'passed'; x.stages.build.status = 'passed'; x.stages.quality.status = 'running'; return x })
  ok(quality(dir, '--lint', 'true'))
  ok(cli(dir, 'pass', 'quality'))
  update(dir, x => { for (const id of ['test_review', 'verify', 'second_review']) x.stages[id].status = 'passed'; greenEvidence(x, dir); x.evidence.quality = load(dir).evidence.quality; return x })
  for (const id of ['quality', 'test_review', 'second_review']) assert.equal(gateProblems(dir, load(dir))[id], undefined, id)
  // Retarget through the supported CLI: every diff-scoped gate is decided again, and reports why.
  const put = ok(cli(dir, 'put', 'base', 'main'))
  assert.match(put.stdout, /NOT CURRENT: quality: the quality results diffed against/)
  const gates = gateProblems(dir, load(dir))
  assert.match(gates.quality, /diffed against .* gives .* now/)
  assert.match(gates.test_review, /diffed against/)
  assert.match(gates.second_review, /review covered the diff from/)
  // The helper refuses a --base that is not the run's.
  assert.match(quality(dir, '--base', 'release', '--lint', 'true').stderr, /is not the run's base main/)
  // A fresh scan against main sees app.js and its directive.
  update(dir, x => { x.stages.quality.status = 'running'; return x })
  assert.equal(quality(dir, '--lint', 'true').status, 1)
  assert.ok(Object.keys(load(dir).evidence.quality.flags).some(id => id.startsWith('app.js:1:lint-disable')))
  // Reused evidence never permits what a fresh evaluation rejects: the gate agrees with the fresh scan.
  assert.match(passProblem(dir, load(dir), 'quality'), /slop signals need a decision: app\.js/)
})

test('a base tip that moves without changing the diff invalidates nothing; a message-only amend keeps local checks', () => {
  const { dir, git } = repo({ remote: false })
  git('commit', '-q', '--allow-empty', '-m', 'story work')
  writeFileSync(join(dir, 'f.js'), 'x\n'); git('add', '.'); git('commit', '-qm', 'f')
  withRun(dir)
  update(dir, r => { for (const id of ['contract', 'build', 'quality', 'test_review', 'verify', 'second_review']) r.stages[id].status = 'passed'; return greenEvidence(r, dir) })
  assert.deepEqual(gateProblems(dir, load(dir)), {})
  git('commit', '-q', '--amend', '-m', 'f, reworded')
  assert.deepEqual(Object.keys(gateProblems(dir, load(dir))), [], 'same tree, same merge base')
})

test('missing or corrupt artifacts are an honest unsatisfied decision', () => {
  const { dir } = repo({ remote: false })
  withRun(dir)
  update(dir, r => { for (const id of ['contract', 'build', 'quality', 'test_review', 'verify', 'second_review']) r.stages[id].status = 'passed'; return greenEvidence(r, dir) })
  writeFileSync(load(dir).review.output, '{"tampered":true}')
  assert.match(gateProblems(dir, load(dir)).second_review, /missing or changed since it was recorded/)
  update(dir, r => { delete r.evidence.mutants; return r })
  assert.match(gateProblems(dir, load(dir)).test_review, /no mutation results/)
})

test('a verification plan is enforced by the trusted runner, on this tree', () => {
  const { dir, commit } = repo({ remote: false })
  withRun(dir)
  ok(cli(dir, 'verification', 'set', '[{"id":"unit","command":"test -f a.txt","version":1}]'))
  update(dir, r => { r.tasks = [{ id: 't', status: 'accepted' }]; r.stages.contract.status = 'passed'; r.stages.build.status = 'running'; return r })
  assert.match(passProblem(dir, load(dir), 'build'), /required check unit has not run on this code/)
  ok(cli(dir, 'verification', 'run', 'unit'))
  assert.equal(passProblem(dir, load(dir), 'build'), null)
  ok(cli(dir, 'pass', 'build'))
  commit('a.txt', 'changed')
  assert.match(gateProblems(dir, load(dir)).build, /ran on older code/)
  // A changed plan is a new revision: earlier records do not count for it.
  ok(cli(dir, 'verification', 'set', '[{"id":"unit","command":"false","version":2}]'))
  assert.equal(cli(dir, 'verification', 'run', 'unit').status, 1)
  assert.match(gateProblems(dir, load(dir)).build, /failed on this code/)
})

test('the board shows the same gate decision as the publisher and the CLI', async t => {
  const { dir } = atQuality({ remote: false })
  ok(quality(dir, '--lint', 'true'))
  ok(cli(dir, 'pass', 'quality'))
  assert.equal(quality(dir, '--lint', 'exit 1').status, 1)
  const port = 45000 + (process.pid % 1000)
  const server = spawn('node', [fileURLToPath(new URL('../skills/story-loop/board/server.mjs', import.meta.url)), '--root', dir, '--port', String(port), '--no-open'], { stdio: 'ignore' })
  t.after(() => server.kill())
  await new Promise(r => setTimeout(r, 700))
  const res = await fetch(`http://127.0.0.1:${port}/events`)
  const reader = res.body.getReader()
  let text = ''
  for (let i = 0; i < 40 && !/"type":"snapshot".*\n\n/s.test(text); i++) { const { value, done } = await reader.read(); if (done) break; text += Buffer.from(value).toString() }
  reader.cancel().catch(() => {})
  const snap = JSON.parse(text.match(/data: (.*)/)[1])
  const run = snap.run ?? snap.state ?? snap
  assert.deepEqual(run.stale, ['quality'])
  assert.equal(run.gates.quality, gateProblems(dir, load(dir)).quality)
  assert.match(run.gates.quality, /lint failed/)
})
