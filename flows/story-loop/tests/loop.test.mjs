import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  newRun, move, current, stopReason, GRAPH, verifyProblem, resultsFile, evidenceDir, storyId, issueRepo, remoteRepo,
  load, save, update, withLock, migrate, passProblem, findingsProblem, readInbox, addNote, deliver, staleStages,
  verifyRequest, commentsProblem, mutantsProblem, imageProblem, verifyReport, environmentProblem,
  FRESH, runProblem, laneProblem, qualityProblem, humanReviewProblem, lessonsProblem, verifyCarry, reviewScope,
} from '../skills/story-loop/scripts/loop.mjs'
import { readLedger, summary, usage } from '../skills/story-loop/scripts/ledger.mjs'
import { signalsFor } from '../skills/story-loop/scripts/quality.mjs'
import { repo, withRun, PNG, B, ENV, META, LANE } from './helpers.mjs'

const LOOP = fileURLToPath(new URL('../skills/story-loop/scripts/loop.mjs', import.meta.url))
const done = (run, ...stages) => stages.reduce((r, s) => move(move(r, 'start', s), 'pass', s), run)
const cli = (cwd, ...args) => spawnSync('node', [LOOP, ...args], { cwd, encoding: 'utf8' })
// results.json as the verifier writes it: the rows under the request id that start verify handed out
const written = (request, results) => JSON.stringify({ request, results })

test('a run starts from a Shortcut story or a GitHub issue, and keeps the issue\'s repo', () => {
  for (const input of ['SC-123', 'sc-123', '123', 'https://app.shortcut.com/acme/story/123/some-title']) assert.equal(storyId(input), 'sc-123', input)
  for (const input of ['gh-45', 'GH-45', '#45', 'https://github.com/acme/app/issues/45']) assert.equal(storyId(input), 'gh-45', input)
  for (const input of ['', 'setup', 'https://github.com/acme/app/pull/45']) assert.equal(storyId(input), null, input)
  assert.equal(issueRepo('https://github.com/Acme/App/issues/45'), 'acme/app')
  assert.equal(remoteRepo('git@github.com:acme/app.git'), 'acme/app')
  assert.equal(remoteRepo('https://github.com/acme/app'), 'acme/app')
})

test('init refuses an issue from another repository', () => {
  const { dir, git } = repo()
  git('remote', 'add', 'origin', 'git@github.com:acme/app.git')
  const other = cli(dir, 'init', 'https://github.com/other/repo/issues/12')
  assert.equal(other.status, 1)
  assert.match(other.stderr, /belongs to other\/repo.*origin is acme\/app/)
  assert.equal(existsSync(join(dir, '.start-story', 'active.json')), false)
  assert.equal(cli(dir, 'init', 'https://github.com/acme/app/issues/12').status, 0)
  assert.equal(load(dir).repo, 'acme/app')
})

test('stages run in graph order only', () => {
  const run = newRun('sc-1')
  assert.equal(current(run), 'contract')
  assert.throws(() => move(run, 'start', 'build'), /not the current stage/)
  assert.throws(() => move(run, 'pass', 'contract'), /not running/)
  assert.equal(current(done(run, 'contract')), 'build')
})

test('back follows graph edges, resets later stages, keeps old evidence as history, and is capped', () => {
  let run = done(newRun('sc-1'), 'contract', 'build', 'quality', 'test_review', 'verify')
  run.evidence = { mutants: { killed: 3 } }
  run = move(run, 'start', 'second_review')
  assert.throws(() => move(run, 'back', 'second_review', 'contract', 'x'), /no edge/)
  assert.throws(() => move(run, 'back', 'second_review', 'build'), /needs a reason/)
  run = move(run, 'back', 'second_review', 'build', 'nil guard missing')
  assert.equal(current(run), 'build')
  assert.equal(run.stages.verify.status, 'pending')
  assert.equal(run.stages.verify.attempt, 2)
  assert.equal(run.stages.build.rounds, 1)
  assert.deepEqual(run.evidence, {})
  assert.deepEqual(run.history.at(-1).evidence, { mutants: { killed: 3 } })
  run.stages.build.rounds = GRAPH.maxRounds
  run = move(done(run, 'build', 'quality'), 'start', 'test_review')
  assert.throws(() => move(run, 'back', 'test_review', 'build', 'again'), /show the human/)
})

test('a human can send a finished run back, and is not capped', () => {
  let run = done(newRun('sc-1'), ...GRAPH.stages.map(s => s.id))
  assert.throws(() => move(run, 'back', 'verify', 'build', 'human: x'), /not the current stage/)
  run.stages.build.rounds = GRAPH.maxRounds
  run = move(run, 'back', 'retro', 'build', 'human: use a scope')
  assert.equal(current(run), 'build')
  assert.equal(run.stages.build.rounds, GRAPH.maxRounds)
})

test('skips follow the per-stage policy', () => {
  assert.throws(() => move(newRun('sc-1'), 'skip', 'contract', undefined, 'already started'), /never skipped/)
  let run = done(newRun('sc-1'), 'contract', 'build', 'quality', 'test_review')
  assert.throws(() => move(run, 'skip', 'verify', undefined, 'no browser available'), /a wait, not a skip/)
  run = move(run, 'skip', 'verify', undefined, 'human: migration only, no page')
  assert.throws(() => move(run, 'skip', 'second_review', undefined, 'human: skip it'), /never skipped/)
})

test('verify counts against the approved check list, and only real screenshots in the folder count', () => {
  const root = mkdtempSync(join(tmpdir(), 'sl-verify-'))
  let run = { ...newRun('sc-1'), checks: [{ id: 'a', step: 1 }, { id: 'b', step: 1, case: 'mobile' }], checks_revision: 1, environment: ENV }
  assert.match(verifyProblem(root, run), /verify was not started on this attempt/)
  run.stages.verify.request = verifyRequest(run, 'tree-a')
  const write = (results, request = run.stages.verify.request.id) => writeFileSync(resultsFile(root, run), written(request, results))
  mkdirSync(evidenceDir(root, run), { recursive: true })
  writeFileSync(join(evidenceDir(root, run), 'a.png'), PNG)
  writeFileSync(join(evidenceDir(root, run), 'b.png'), PNG)
  const pass = (id, evidence = [`${id}.png`]) => ({ id, step: 1, ...(id === 'b' ? { case: 'mobile' } : {}), verdict: 'pass', evidence, ...META })

  assert.match(verifyProblem(root, run), /0 of 2 checks reported/)
  write([pass('a')])
  assert.match(verifyProblem(root, run), /1 of 2 checks reported; missing: b/)
  write([pass('a'), pass('a')])
  assert.match(verifyProblem(root, run), /reported twice/)
  write([pass('a'), pass('b'), pass('invented')])
  assert.match(verifyProblem(root, run), /"invented" is not in the approved check list/)
  write([pass('a'), { ...pass('b'), verdict: 'blocked' }])
  assert.match(verifyProblem(root, run), /"b" is "blocked"/)
  write([pass('a'), pass('b', ['.'])])
  assert.match(verifyProblem(root, run), /outside the evidence folder|not a file/)
  write([pass('a'), pass('b', ['../results.json'])])
  assert.match(verifyProblem(root, run), /outside the evidence folder/)
  symlinkSync(resultsFile(root, run), join(evidenceDir(root, run), 'link.png'))
  write([pass('a'), pass('b', ['link.png'])])
  assert.match(verifyProblem(root, run), /outside the evidence folder/)
  mkdirSync(join(evidenceDir(root, run), 'dir.png'))
  write([pass('a'), pass('b', ['dir.png'])])
  assert.match(verifyProblem(root, run), /not a file/)
  writeFileSync(join(evidenceDir(root, run), 'fake.png'), 'x'.repeat(200))
  write([pass('a'), pass('b', ['fake.png'])])
  assert.match(verifyProblem(root, run), /not a PNG, JPEG or WebP/)
  write([pass('a'), pass('b')])
  assert.equal(verifyProblem(root, run), null)
  // H01: passing results that were not written for this request never count
  writeFileSync(resultsFile(root, run), JSON.stringify([pass('a'), pass('b')])) // the format before 0.8: no request at all
  assert.match(verifyProblem(root, run), /carry request "none"/)
  write([pass('a'), pass('b')], verifyRequest({ ...run, id: 'earlier-run' }, 'tree-a').id)
  assert.match(verifyProblem(root, run), /belong to another attempt, check list or run/)
  write([pass('a'), pass('b')], verifyRequest(run, 'tree-b').id) // the same checks, run on other code
  assert.match(verifyProblem(root, run), /belong to another attempt/)
  write([pass('a'), pass('b')])
  assert.match(verifyProblem(root, { ...run, checks_revision: 2 }), /check list changed since verify started/) // same ids, new list
  // H24: a capture cut off mid-write keeps its header
  writeFileSync(join(evidenceDir(root, run), 'cut.png'), Buffer.concat([PNG.subarray(0, 40), Buffer.alloc(40)]))
  assert.match(imageProblem(evidenceDir(root, run), 'cut.png'), /cut off/)
  writeFileSync(join(evidenceDir(root, run), 'cut.jpg'), Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100)]))
  assert.match(imageProblem(evidenceDir(root, run), 'cut.jpg'), /cut off/)
  writeFileSync(join(evidenceDir(root, run), 'ok.jpg'), Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100), Buffer.from([0xff, 0xd9])]))
  assert.equal(imageProblem(evidenceDir(root, run), 'ok.jpg'), null)

  run = { ...run, checks: [] }
  assert.match(verifyProblem(root, run), /empty: no user journey/)
})

test('going back archives browser results, so an old attempt never passes the next one', () => {
  const { dir } = repo()
  const run = withRun(dir, { checks: [{ id: 'a', step: 1 }], environment: ENV })
  run.stages.verify.request = verifyRequest(run, 'tree-a')
  save(dir, run)
  mkdirSync(evidenceDir(dir, run), { recursive: true })
  writeFileSync(join(evidenceDir(dir, run), 'a.png'), PNG)
  writeFileSync(resultsFile(dir, run), written(run.stages.verify.request.id, [{ id: 'a', step: 1, verdict: 'pass', evidence: ['a.png'], ...META }]))
  assert.equal(verifyProblem(dir, run), null)
  update(dir, r => {
    for (const id of ['contract', 'build', 'quality', 'test_review', 'verify']) r.stages[id].status = 'passed'
    r.stages.second_review.status = 'running'
    return r
  })
  assert.equal(cli(dir, 'back', 'second_review', 'build', 'defect').status, 0)
  assert.match(verifyProblem(dir, load(dir)), /verify was not started on this attempt/)
  assert.equal(existsSync(resultsFile(dir, run)), false)
  assert.ok(existsSync(join(dir, '.start-story', 'sc-1', 'attempts', '1', 'results.json')))
  assert.ok(existsSync(join(dir, '.start-story', 'sc-1', 'attempts', '1', 'evidence', 'a.png')))
})

test('concurrent writers never lose each other\'s change', async () => {
  const { dir } = repo()
  withRun(dir)
  const url = new URL('../skills/story-loop/scripts/loop.mjs', import.meta.url).href
  const writers = Array.from({ length: 12 }, (_, i) => new Promise(ok => {
    const child = spawn('node', ['--input-type=module', '-e',
      `import { update } from ${JSON.stringify(url)}; update(${JSON.stringify(dir)}, r => ({ ...r, tasks: [...r.tasks, { id: ${i} }] }))`])
    child.on('close', ok)
  }))
  assert.deepEqual(await Promise.all(writers), Array(12).fill(0))
  const run = load(dir)
  assert.equal(run.tasks.length, 12)
  assert.equal(run.revision, 12)
})

test('a stale lock is broken once, and a live holder\'s lock is never broken', () => {
  const { dir } = repo()
  withRun(dir)
  const lock = join(dir, '.start-story', '.lock')
  mkdirSync(lock); writeFileSync(join(lock, 'pid'), '999999') // a dead holder
  update(dir, r => ({ ...r, title: 'after stale' }))
  assert.equal(load(dir).title, 'after stale')
  assert.equal(existsSync(lock), false)
  mkdirSync(lock); writeFileSync(join(lock, 'pid'), String(process.ppid)) // a live holder
  assert.throws(() => withLock(dir, () => {}, 200), /locked by another process/)
  assert.ok(existsSync(lock))
})

test('a corrupt state file is reported, not replaced, and recover restores the last good copy', () => {
  const { dir } = repo()
  withRun(dir)
  update(dir, r => ({ ...r, title: 'second' }))
  writeFileSync(join(dir, '.start-story', 'active.json'), '{"half')
  assert.throws(() => load(dir), /unreadable.*loop\.mjs recover/)
  assert.equal(cli(dir, 'status').status, 1)
  assert.equal(cli(dir, 'recover').status, 0)
  assert.equal(load(dir).title, 'Thing')
  assert.ok(readdirSync(join(dir, '.start-story')).some(f => f.startsWith('active.json.broken-')))
})

test('an old run migrates with its data and no fresh evidence', () => {
  const old = { story: 'sc-9', session: 's1', started_at: 'x', stages: Object.fromEntries(GRAPH.stages.map(s => [s.id, { status: 'passed', rounds: 0 }])), tasks: [1], findings: [], evidence: { mutants: { killed: 1 } } }
  const run = migrate(old)
  assert.equal(run.schema, 3)
  assert.equal(run.migrated_from, 1)
  assert.deepEqual(run.owner, { session: 's1', since: 'x', heartbeat: 0 })
  assert.deepEqual(run.tasks, [1])
  assert.equal(run.stages.verify.tree, undefined)
  // H18: passed stages that name no code tree prove nothing about the code now
  assert.deepEqual(staleStages(mkdtempSync(join(tmpdir(), 'sl-old-')), run, 'any-tree'), FRESH)
  // a 0.9 run (schema 2) keeps its owner and stops at the stage the graph gained since
  const { quality, human_review, retro, ...nine } = Object.fromEntries(GRAPH.stages.map(s => [s.id, { status: 'passed', rounds: 0, attempt: 1, tree: 't' }]))
  const from9 = migrate({ schema: 2, story: 'sc-9', started_at: 'x', owner: { session: 's2' }, stages: nine })
  assert.deepEqual([from9.migrated_from, from9.owner.session, current(from9), from9.stages.verify.tree], [2, 's2', 'quality', 't'])
  // something that is not a run is not turned into one
  assert.match(runProblem(migrate({ story: 'sc-9' })), /no stages/)
})

test('findings need a severity and a settled verdict with its reason or fix', () => {
  const f = over => ({ id: 'c1', severity: 'major', verdict: 'fixed', commit: 'abc', ...over })
  assert.equal(findingsProblem([f()]), null)
  assert.match(findingsProblem([f({ severity: undefined })]), /needs a severity/)
  assert.match(findingsProblem([f({ verdict: 'fix_requested' })]), /settle it first/)
  assert.match(findingsProblem([f({ commit: undefined })]), /names no commit/)
  assert.match(findingsProblem([f({ verdict: 'rejected' })]), /without a reason/)
  assert.match(findingsProblem([f({ verdict: 'parked', severity: 'blocker', note: 'later' })]), /never parked/)
  assert.equal(findingsProblem([f({ verdict: 'parked', severity: 'question', note: 'design call' })]), null)
})

test('stages pass on evidence, not on a success message', () => {
  const { dir, git, commit } = repo()
  let run = withRun(dir, { checks: null })
  assert.match(passProblem(dir, run, 'contract'), /check list/)
  run = withRun(dir)
  git('checkout', '-q', 'main')
  assert.match(passProblem(dir, { ...run, lane: undefined }, 'contract'), /record the lane/)
  assert.match(passProblem(dir, run, 'contract'), /on "main", not the story branch/)
  git('checkout', '-q', B)
  assert.equal(passProblem(dir, run, 'contract'), null)

  assert.match(passProblem(dir, run, 'build'), /no tasks/)
  run.tasks = [{ title: 'a', status: 'running' }]
  assert.match(passProblem(dir, run, 'build'), /not accepted yet: a/)
  run.tasks = [{ title: 'a', status: 'accepted' }]
  writeFileSync(join(dir, 'a.txt'), 'dirty')
  assert.match(passProblem(dir, run, 'build'), /uncommitted/)
  commit()
  assert.equal(passProblem(dir, run, 'build'), null)

  assert.match(passProblem(dir, run, 'test_review'), /no mutation results/)
  run.evidence = { mutants: { tree: 'old' } }
  assert.match(passProblem(dir, run, 'test_review'), /older code/)
  const tree = git('rev-parse', 'HEAD^{tree}')
  // the gate reads the per-mutant outcomes, never a count somebody summed up
  run.evidence = { mutants: { tree, outcomes: { 'a.js:1:aaaaaa': 'invalid' } } }
  assert.match(passProblem(dir, run, 'test_review'), /no valid mutant/)
  run.evidence = { mutants: { tree, outcomes: { 'a.js:1:aaaaaa': 'killed', 'a.js:2:bbbbbb': 'infra' } } }
  assert.match(passProblem(dir, run, 'test_review'), /inconclusive/)
  run.evidence = { mutants: { tree, outcomes: { 'a.js:1:aaaaaa': 'killed' } } }
  assert.equal(passProblem(dir, run, 'test_review'), null)

  run.findings = [{ id: 'c1', source: 'codex', severity: 'major', verdict: 'open' }]
  assert.match(passProblem(dir, run, 'second_review'), /second_review was not started on this attempt/)
  run.stages.second_review.request = { id: 'q1', attempt: 1, tree }
  assert.match(passProblem(dir, run, 'second_review'), /record the review of this code/)
  run.review = { reviewer: 'codex', request: 'q1', attempt: 1, tree: 'older' }
  assert.match(passProblem(dir, run, 'second_review'), /covered older code or an earlier attempt/)
  run.review = { reviewer: 'codex', request: 'q0', attempt: 1, tree } // the same code, answered for another request
  assert.match(passProblem(dir, run, 'second_review'), /covered older code or an earlier attempt/)
  run.review = { reviewer: 'codex', request: 'q1', attempt: 1, tree }
  assert.match(passProblem(dir, run, 'second_review'), /c1 is open/)

  assert.match(passProblem(dir, run, 'push'), /nothing published/)
  assert.match(passProblem(dir, run, 'copilot_review'), /no Copilot review/)
})

test('a code change after the reviews makes their evidence stale until the run goes back', () => {
  const { dir, git, commit } = repo()
  const tree = git('rev-parse', 'HEAD^{tree}')
  const head = git('rev-parse', 'HEAD')
  const run = withRun(dir)
  for (const id of ['contract', 'build', 'quality', 'test_review', 'verify', 'second_review', 'push', 'copilot_review']) run.stages[id].status = 'passed'
  for (const id of FRESH) run.stages[id].tree = tree
  Object.assign(run, { pushed: { state: 'confirmed', sha: head }, ci: { sha: head, state: 'pending' }, copilot: { review: { id: 9 }, comments: { review: 9, ids: [] } } })
  assert.deepEqual(staleStages(dir, run), [])
  assert.match(passProblem(dir, run, 'report'), /required CI is pending/)
  run.ci.state = 'pass'
  assert.match(passProblem(dir, run, 'report'), /report for HEAD is not posted/)
  commit()
  assert.deepEqual(staleStages(dir, run), FRESH)
  assert.match(passProblem(dir, run, 'fix_comments'), /covered older code/)
  assert.match(passProblem(dir, run, 'report'), /covered older code/)
})

test('notes belong to their run, and a copied note is still delivered', () => {
  const { dir } = repo()
  withRun(dir)
  assert.equal(addNote(dir, { kind: 'note', text: 'use a scope' }), 'n1')
  assert.match(deliver(dir, 'copied from the board'), /use a scope/)
  assert.equal(readInbox(dir, load(dir))[0].status, 'copied')
  assert.match(deliver(dir, 'while working'), /\[n1\]/)
  assert.equal(readInbox(dir, load(dir))[0].status, 'delivered')
  assert.equal(deliver(dir, 'while working'), null)
  assert.deepEqual(readInbox(dir, { story: 'sc-2' }), [])
  assert.ok(readFileSync(join(dir, '.start-story', 'sc-1', 'inbox.json'), 'utf8').includes('use a scope'))
})

test('the stop gate holds until a stage waits, blocks, or all are done', () => {
  let run = newRun('sc-1')
  assert.match(stopReason(run), /stage "contract" is pending/)
  run = move(run, 'wait', 'contract', 'human', 'sign-off')
  assert.equal(stopReason(run), null)
  assert.throws(() => move(run, 'wait', 'contract', 'nobody', 'x'), /human \| copilot/)
  const all = done(newRun('sc-1'), ...GRAPH.stages.map(s => s.id))
  assert.equal(current(all), null)
  assert.equal(stopReason(all), null)
})

test('ending a run keeps its record', () => {
  const { dir } = repo()
  withRun(dir)
  assert.equal(cli(dir, 'end').status, 0)
  assert.equal(existsSync(join(dir, '.start-story', 'active.json')), false)
  assert.ok(readdirSync(join(dir, '.start-story', 'sc-1')).some(f => /^run-\d+\.json$/.test(f)))
})

test('the CLI refuses a pass without evidence', () => {
  const { dir } = repo()
  withRun(dir, { title: undefined })
  cli(dir, 'start', 'contract')
  const refused = cli(dir, 'pass', 'contract', 'signed off')
  assert.equal(refused.status, 1)
  assert.match(refused.stderr, /contract cannot pass: record title/)
  save(dir, { ...load(dir), title: 'x' })
  assert.equal(cli(dir, 'pass', 'contract', 'signed off').status, 0)
})

// ---- regressions from the 0.7.0 reliability review ------------------------------

// A run in a real checkout, at the verify stage, with one approved check.
function atVerify() {
  const r = repo()
  withRun(r.dir, { checks: [{ id: 'a', step: 1 }], checks_revision: 1, browser: 'chrome', environment: ENV })
  update(r.dir, run => { for (const id of ['contract', 'build', 'quality']) run.stages[id].status = 'passed'; Object.assign(run.stages.test_review, { status: 'skipped', reason: 'template only' }); return run })
  const report = (request, row = {}) => {
    const run = load(r.dir)
    mkdirSync(evidenceDir(r.dir, run), { recursive: true })
    writeFileSync(join(evidenceDir(r.dir, run), 'a.png'), PNG)
    writeFileSync(resultsFile(r.dir, run), written(request, [{ id: 'a', step: load(r.dir).checks[0].step, verdict: 'pass', evidence: ['a.png'], ...META, ...row }]))
  }
  const requestId = out => out.match(/verify request: (\S+)/)[1]
  return { ...r, report, requestId }
}

test('H01: browser results pass only for the request made before the browser ran, on the code that request named', () => {
  const { dir, git, commit, report, requestId } = atVerify()
  // the browser must test committed code
  writeFileSync(join(dir, 'a.txt'), 'uncommitted')
  assert.match(cli(dir, 'start', 'verify').stderr, /verify starts on committed code/)
  git('checkout', '-q', '--', 'a.txt')
  const first = requestId(cli(dir, 'start', 'verify').stdout)
  report(first)
  // code B is committed after the browser tested A (test review was skipped, so nothing else would notice)
  commit()
  const refused = cli(dir, 'pass', 'verify')
  assert.equal(refused.status, 1)
  assert.match(refused.stderr, /code changed since verify started/)
  assert.equal(load(dir).stages.verify.tree, undefined)
  // a new request for B: A's results are moved aside and count for nothing
  const second = requestId(cli(dir, 'start', 'verify').stdout)
  assert.notEqual(second, first)
  assert.match(cli(dir, 'pass', 'verify').stderr, /0 of 1 checks reported/)
  assert.ok(readdirSync(join(dir, '.start-story', 'sc-1', 'attempts')).some(n => n.startsWith('1-superseded')))
  // a slow verifier of the first request reports late
  report(first)
  assert.match(cli(dir, 'pass', 'verify').stderr, /belong to another attempt/)
  // uncommitted code at pass time
  report(second)
  writeFileSync(join(dir, 'a.txt'), 'uncommitted')
  assert.match(cli(dir, 'pass', 'verify').stderr, /uncommitted changes/)
  git('checkout', '-q', '--', 'a.txt')
  // a changed check list that keeps the old ids
  assert.equal(cli(dir, 'checks', 'set', '[{"id":"a","step":2}]').status, 0)
  assert.match(cli(dir, 'pass', 'verify').stderr, /check list changed since verify started/)
  const third = requestId(cli(dir, 'start', 'verify').stdout)
  report(third)
  assert.equal(cli(dir, 'pass', 'verify').status, 0)
  assert.equal(load(dir).stages.verify.tree, git('rev-parse', 'HEAD^{tree}'))
  // resuming the same request keeps what the verifier already wrote
  update(dir, run => { run.stages.verify.status = 'blocked'; return run })
  assert.equal(requestId(cli(dir, 'start', 'verify').stdout), third)
  assert.ok(existsSync(resultsFile(dir, load(dir))))
})

test('H01: a new run of the same story never passes on the previous run\'s browser results', () => {
  const { dir, report, requestId } = atVerify()
  report(requestId(cli(dir, 'start', 'verify').stdout))
  assert.equal(cli(dir, 'pass', 'verify').status, 0)
  assert.equal(cli(dir, 'end').status, 0)
  assert.equal(cli(dir, 'init', 'sc-1').status, 0)
  assert.ok(existsSync(join(dir, '.start-story', 'sc-1', 'results.json')), 'the old results are still on disk')
  update(dir, run => { Object.assign(run, { checks: [{ id: 'a', step: 1 }], checks_revision: 1, browser: 'chrome', environment: ENV }); run.stages.contract.status = 'passed'; run.stages.build.status = 'passed'; run.stages.quality.status = 'passed'; run.stages.test_review.status = 'skipped'; return run })
  assert.equal(cli(dir, 'start', 'verify').status, 0)
  assert.match(cli(dir, 'pass', 'verify').stderr, /0 of 1 checks reported/)
})

test('H02: a review is an artifact for one attempt and one code tree; the last attempt\'s never passes the next', () => {
  const { dir, git, commit } = repo()
  withRun(dir, { findings: [{ id: 'r1', source: 'codex', severity: 'minor', verdict: 'rejected', note: 'out of scope' }] })
  const before = stage => update(dir, run => {
    for (const id of GRAPH.stages.map(s => s.id)) { if (id === stage) break; run.stages[id].status = 'passed' }
    return run
  })
  const answer = (name, text) => { const file = join(dir, '.start-story', name); writeFileSync(file, text); return file }
  const requestId = out => out.match(/review request: (\S+)/)[1]
  before('second_review')
  const out = answer('out.txt', 'No blocking findings. One minor: r1.')
  // the request is made before the reviewer runs, and names the code it is for
  const first = requestId(cli(dir, 'start', 'second_review').stdout)
  const A = git('rev-parse', 'HEAD')
  assert.deepEqual([load(dir).stages.second_review.request.commit, load(dir).stages.second_review.request.tree], [A, git('rev-parse', 'HEAD^{tree}')])
  assert.match(cli(dir, 'put', 'reviewer', 'codex').stderr, /recorded with its output/)
  assert.match(cli(dir, 'pass', 'second_review').stderr, /record the review of this code/)
  assert.match(cli(dir, 'review', 'codex', join(dir, '.start-story', 'empty.txt'), '--request', first).stderr, /cannot read/)
  assert.match(cli(dir, 'review', 'codex', out).stderr, /name the request this answer is for/)
  assert.match(cli(dir, 'review', 'codex', out, '--request', 'someone-elses').stderr, /An answer to an earlier request is history/)
  // the reviewer answered for A; meanwhile changed source was committed as B: its answer cannot be recorded for B
  commit()
  const late = cli(dir, 'review', 'codex', out, '--request', first)
  assert.equal(late.status, 1)
  assert.match(late.stderr, /the code changed since request .* was made.*that answer reviewed the older code/)
  assert.equal(load(dir).review, undefined)
  assert.match(cli(dir, 'pass', 'second_review').stderr, /code changed since this review was requested/)
  // a new request for B; the answer for A, read again under the new id, is not a fresh review once it is on record
  const second = requestId(cli(dir, 'start', 'second_review').stdout)
  assert.notEqual(second, first)
  assert.equal(cli(dir, 'review', 'codex', answer('b.txt', 'Reviewed B. No blocking findings.'), '--request', second).status, 0)
  const review = load(dir).review
  assert.deepEqual([review.reviewer, review.request, review.attempt, review.tree, review.commit], ['codex', second, 1, git('rev-parse', 'HEAD^{tree}'), git('rev-parse', 'HEAD')])
  assert.match(readFileSync(review.output, 'utf8'), /Reviewed B/)
  assert.match(review.output, new RegExp(`reviews/${second}\\.txt$`), 'one immutable file per request')
  assert.equal(cli(dir, 'pass', 'second_review').status, 0)
  // back to build, a new commit, forward again: reviewer name and settled findings are all still there
  update(dir, run => { run.stages.push.status = 'running'; return run })
  assert.equal(cli(dir, 'back', 'push', 'build', 'defect found').status, 0)
  commit()
  before('second_review')
  assert.equal(load(dir).reviewer, 'codex')
  assert.match(cli(dir, 'pass', 'second_review').stderr, /was not started on this attempt/)
  const third = requestId(cli(dir, 'start', 'second_review').stdout)
  const refused = cli(dir, 'pass', 'second_review')
  assert.equal(refused.status, 1)
  assert.match(refused.stderr, /covered older code or an earlier attempt/)
  // the previous attempt's reviewer answers late, and the old answer file is offered again: neither is this attempt's review
  assert.match(cli(dir, 'review', 'codex', out, '--request', second).stderr, /An answer to an earlier request is history/)
  assert.match(cli(dir, 'review', 'codex', join(dir, '.start-story', 'b.txt'), '--request', third).stderr, /already recorded for request .*not a new review/)
  // starting again while the reviewer is still out keeps its request
  update(dir, run => { run.stages.second_review.status = 'blocked'; return run })
  assert.equal(requestId(cli(dir, 'start', 'second_review').stdout), third)
  assert.equal(cli(dir, 'review', 'codex', answer('c.txt', 'Reviewed the fix. Nothing new.'), '--request', third).status, 0)
  assert.equal(cli(dir, 'pass', 'second_review').status, 0)
  assert.deepEqual([load(dir).review.attempt, load(dir).reviews.map(r => r.request)], [2, [second, third]])
  assert.ok(load(dir).reviews.every(r => existsSync(r.output)), 'the earlier answer is kept as history')
})

test('H12, H13: every fetched Copilot comment needs a finding, and fix_comments is never skipped', () => {
  const run = newRun('sc-1')
  run.stages.copilot_review.status = 'passed'
  assert.match(commentsProblem(run), /were not fetched yet/)
  run.copilot = { review: { id: 9 }, comments: { review: 8, ids: [] } } // fetched for an earlier review
  assert.match(commentsProblem(run), /were not fetched yet/)
  run.copilot.comments = { review: 9, ids: [101, 102] }
  assert.match(commentsProblem(run), /2 of 2 Copilot comments have no finding \(comment ids: 101, 102\)/)
  run.findings = [{ id: 'k1', source: 'copilot', comment: 101, severity: 'minor', verdict: 'rejected', note: 'style' }]
  assert.match(commentsProblem(run), /1 of 2 .*102/)
  run.findings.push({ id: 'k2', source: 'copilot', comment: 102, severity: 'major', verdict: 'open' })
  assert.equal(commentsProblem(run), null)
  run.copilot.comments = { review: 9, ids: [] } // a fetched empty set is an answer
  assert.equal(commentsProblem({ ...run, findings: [] }), null)
  assert.equal(commentsProblem({ ...newRun('sc-1'), stages: { copilot_review: { status: 'skipped' } } }), null)

  // the open major finding: no skip gets past it, and the last gate looks again
  const { dir, git } = repo()
  const head = git('rev-parse', 'HEAD')
  withRun(dir, { ...run, story: 'sc-1', branch: B, copilot: { review: { id: 9 }, comments: { review: 9, ids: [101, 102] } },
    pushed: { state: 'confirmed', sha: head }, ci: { sha: head, state: 'pass', required: [] }, report: { state: 'confirmed', sha: head, comment_id: 5 } })
  update(dir, r => {
    for (const id of GRAPH.stages.map(s => s.id)) r.stages[id] = { status: 'passed', rounds: 0, attempt: 1, tree: git('rev-parse', 'HEAD^{tree}') }
    r.stages.fix_comments.status = 'pending'; r.stages.report.status = 'pending'
    return r
  })
  const skipped = cli(dir, 'skip', 'fix_comments', 'no further work needed')
  assert.equal(skipped.status, 1)
  assert.match(skipped.stderr, /fix_comments is never skipped/)
  assert.match(cli(dir, 'skip', 'fix_comments', 'human: fine by me').stderr, /never skipped/)
  cli(dir, 'start', 'fix_comments')
  assert.match(cli(dir, 'pass', 'fix_comments').stderr, /k2 is open/)
  assert.match(passProblem(dir, load(dir), 'report'), /k2 is open/)
})

test('H15: a waiter that saw a stale lock cannot remove the lock that replaced it', () => {
  const { dir } = repo()
  withRun(dir)
  const lock = join(dir, '.start-story', '.lock')
  // Another process is in the middle of breaking the stale lock (it holds the guard):
  // this waiter sees the same stale lock and must leave it alone.
  mkdirSync(lock); writeFileSync(join(lock, 'pid'), '999999')
  mkdirSync(`${lock}.break`)
  assert.throws(() => withLock(dir, () => {}, 200), /locked by another process/)
  assert.equal(readFileSync(join(lock, 'pid'), 'utf8'), '999999')
  // That process finishes: the stale lock is gone and a live holder has replaced it.
  rmSync(lock, { recursive: true }); rmSync(`${lock}.break`, { recursive: true })
  mkdirSync(lock); writeFileSync(join(lock, 'pid'), String(process.ppid))
  assert.throws(() => withLock(dir, () => {}, 200), /locked by another process/)
  assert.equal(readFileSync(join(lock, 'pid'), 'utf8'), String(process.ppid), 'the live replacement is untouched')
  // With no guard held the stale lock is broken, and the critical section runs exactly once at a time.
  rmSync(lock, { recursive: true })
  mkdirSync(lock); writeFileSync(join(lock, 'pid'), '999999')
  let inside = 0
  withLock(dir, () => { inside++; assert.throws(() => withLock(dir, () => { inside++ }, 100), /locked/) })
  assert.equal(inside, 1)
  assert.equal(existsSync(lock), false)
  assert.equal(existsSync(`${lock}.break`), false)
})

test('H16: init, end and recover take the lock; two inits never replace each other\'s run', async () => {
  const { dir } = repo()
  const lock = join(dir, '.start-story', '.lock')
  const env = { ...process.env, STORY_LOOP_LOCK_WAIT: '200' }
  // another process is inside its check-and-create: this init waits, then gives up without writing
  mkdirSync(lock, { recursive: true }); writeFileSync(join(lock, 'pid'), String(process.pid))
  const blocked = spawnSync('node', [LOOP, 'init', 'sc-111'], { cwd: dir, encoding: 'utf8', env })
  assert.equal(blocked.status, 1)
  assert.match(blocked.stderr, /locked by another process/)
  assert.equal(existsSync(join(dir, '.start-story', 'active.json')), false)
  rmSync(lock, { recursive: true })
  // released: of two inits started together exactly one creates its run, the other is told
  const start = story => new Promise(ok => {
    const child = spawn('node', [LOOP, 'init', story], { cwd: dir })
    let err = ''
    child.stderr.on('data', chunk => { err += chunk })
    child.on('close', code => ok({ story, code, err }))
  })
  const both = await Promise.all([start('sc-111'), start('sc-222')])
  const won = both.filter(r => r.code === 0)
  assert.equal(won.length, 1, JSON.stringify(both))
  assert.match(both.find(r => r.code !== 0).err, /another run is active here/)
  assert.equal(load(dir).story, won[0].story)
  // end and recover wait for the lock too
  mkdirSync(lock); writeFileSync(join(lock, 'pid'), String(process.pid))
  for (const verb of ['end', 'recover']) assert.match(spawnSync('node', [LOOP, verb], { cwd: dir, encoding: 'utf8', env }).stderr, /locked by another process/)
  assert.ok(existsSync(join(dir, '.start-story', 'active.json')))
})

test('H20: a corrupt notes file is never read as empty, and recover brings the last good notes back', () => {
  const { dir } = repo()
  withRun(dir)
  const file = join(dir, '.start-story', 'sc-1', 'inbox.json')
  assert.equal(addNote(dir, { kind: 'note', text: 'use a scope' }), 'n1')
  assert.equal(addNote(dir, { kind: 'change', text: 'rename the column' }), 'n2')
  writeFileSync(file, '[{"id":"n1","text":"use a sc') // a write cut off half way
  assert.throws(() => readInbox(dir, load(dir)), /notes file .* is unreadable.*loop\.mjs recover/)
  assert.throws(() => addNote(dir, { kind: 'note', text: 'third' }), /unreadable/)
  assert.throws(() => deliver(dir, 'while working'), /unreadable/)
  assert.equal(cli(dir, 'note', 'done', 'n1', 'did it').status, 1)
  assert.equal(readFileSync(file, 'utf8'), '[{"id":"n1","text":"use a sc', 'nothing overwrote the broken file')
  const recovered = cli(dir, 'recover')
  assert.equal(recovered.status, 0)
  assert.match(recovered.stdout, /only in the broken file/)
  assert.ok(readdirSync(join(dir, '.start-story', 'sc-1')).some(f => f.startsWith('inbox.json.broken-')))
  assert.deepEqual(readInbox(dir, load(dir)).map(n => [n.id, n.text]), [['n1', 'use a scope']])
  assert.equal(addNote(dir, { kind: 'note', text: 'again' }), 'n2')
  assert.match(deliver(dir, 'while working'), /\[n1\].*\[n2\]/s)
  assert.deepEqual(readInbox(dir, { story: 'sc-none' }), []) // missing is still just empty
})

test('H06: mutation results count only with every changed file mutated and every surviving mutant decided', () => {
  const m = { scope: ['a.js', 'b.js'], covered: ['a.js'], outcomes: { 'a.js:1:aaaaaa': 'killed', 'a.js:2:bbbbbb': 'survived', 'a.js:3:cccccc': 'timeout', 'a.js:4:dddddd': 'skipped', 'a.js:5:eeeeee': 'unverified' } }
  assert.match(mutantsProblem(m), /changed source files were not mutated: b\.js/)
  m.dispositions = { 'b.js': 'generated client, covered by contract tests' }
  assert.match(mutantsProblem(m), /4 mutants need a decision: a\.js:2:bbbbbb \(survived\)/)
  Object.assign(m.dispositions, { 'a.js:2:bbbbbb': 'equivalent: both bounds are excluded by the caller', 'a.js:3:cccccc': 'loops forever by design', 'a.js:5:eeeeee': 'checked by hand: parses, test fails on the assertion' })
  assert.match(mutantsProblem(m), /1 mutants need a decision: a\.js:4:dddddd \(skipped\)/)
  m.dispositions['a.js'] = 'budget: the remaining lines are logging'
  assert.equal(mutantsProblem(m), null)
  // 0 killed, 25 survived, 5 not run is not a pass
  const weak = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`a.js:${i}:ffffff`, i < 25 ? 'survived' : 'skipped']))
  assert.match(mutantsProblem({ scope: ['a.js'], covered: ['a.js'], outcomes: weak }), /30 mutants need a decision/)
})

// ---- regressions from the 0.8.0 review -------------------------------------------

test('R5: a passing result must say where it ended, which goal it checked, and match the approved step and case', () => {
  const root = mkdtempSync(join(tmpdir(), 'sl-meta-'))
  const run = { ...newRun('sc-1'), checks: [{ id: 'a', step: 1 }, { id: 'b', step: 2, case: 'mobile' }], checks_revision: 1, environment: ENV }
  run.stages.verify.request = verifyRequest(run, 'tree-a')
  mkdirSync(evidenceDir(root, run), { recursive: true })
  for (const id of ['a', 'b']) writeFileSync(join(evidenceDir(root, run), `${id}.png`), PNG)
  const a = { id: 'a', step: 1, verdict: 'pass', evidence: ['a.png'], ...META }
  const b = { id: 'b', step: 2, case: 'mobile', verdict: 'pass', evidence: ['b.png'], ...META }
  const problem = (...rows) => { writeFileSync(resultsFile(root, run), written(run.stages.verify.request.id, rows)); return verifyProblem(root, run) }
  const without = (row, key) => { const { [key]: _, ...rest } = row; return rest }
  assert.equal(problem(a, b), null)
  // the reviewed reproduction: id, verdict, screenshot and the request envelope, nothing else
  assert.match(problem({ id: 'a', verdict: 'pass', evidence: ['a.png'] }, b), /"a" reports Test Step \(none\); the approved list has it under step 1/)
  assert.match(problem(without(a, 'url'), b), /"a" does not record the URL it ended on/)
  assert.match(problem({ ...a, url: 'the settings page' }, b), /does not record the URL/)
  assert.match(problem(without(a, 'environment'), b), /ran against "\(none\)", not the requested environment "http:\/\/127\.0\.0\.1:3000"/)
  assert.match(problem({ ...a, environment: 'https://staging.example' }, b), /ran against "https:\/\/staging\.example"/)
  assert.match(problem(without(a, 'text'), b), /does not quote the goal it checked/)
  assert.match(problem({ ...a, step: 2 }, b), /"a" reports Test Step 2; the approved list has it under step 1/)
  assert.match(problem(a, { ...b, case: 'desktop' }), /"b" reports case "desktop"; the approved list says "mobile"/)
  assert.match(problem(a, without(b, 'case')), /"b" reports case "\(none\)"/)
  assert.match(problem({ ...a, case: 'mobile' }, b), /"a" reports case "mobile"; the approved list says "\(none\)"/)
  assert.equal(problem({ ...a, environment: 'http://127.0.0.1:3000/' }, b), null, 'a trailing slash is the same environment')
  // the gate says row by row what it accepted, for the board and the diagnostics
  problem(without(a, 'url'), b)
  const report = verifyReport(root, run)
  assert.deepEqual([report.accepted, report.total, report.rows.map(r => r.accepted)], [1, 2, [false, true]])
  // a request made before environments were recorded cannot pass
  const old = { ...run, stages: { ...run.stages, verify: { ...run.stages.verify, request: { ...run.stages.verify.request, environment: null } } } }
  assert.match(verifyProblem(root, old), /names no environment/)
})

test('R5: the environment is recorded before verify starts, and only a linked one is exact-code verification', () => {
  for (const [env, why] of [
    ['{"url":"http://127.0.0.1:3000"}', /needs "kind"/], ['{"kind":"local"}', /needs the base URL/],
    ['{"url":"https://staging.example","kind":"local"}', /not a local address/],
    ['{"url":"https://staging.example","kind":"remote"}', /needs "revision" .* or "unlinked": "human:/],
    ['{"url":"https://staging.example","kind":"remote","unlinked":"it is fine"}', /"unlinked": "human:/],
    ['{"url":"https://staging.example","kind":"remote","revision":"latest"}', /7 to 40 hex/]])
    assert.match(environmentProblem(JSON.parse(env)), why, env)
  const { dir, git, report, requestId } = atVerify()
  update(dir, run => { delete run.environment; return run })
  assert.match(cli(dir, 'start', 'verify').stderr, /record where the browser will test, and what ties it to this code/)
  assert.equal(load(dir).stages.verify.status, 'pending', 'nothing started')
  // a deployment that reports another commit serves other code
  assert.equal(cli(dir, 'put', 'environment', '{"url":"https://pr-7.preview.example","kind":"remote","revision":"0123456789abcdef"}').status, 0)
  assert.match(cli(dir, 'start', 'verify').stderr, /reports revision 0123456789abcdef, but the code under review is .*the browser would test other code/)
  // a deployment nothing ties to this code passes only on the human's word, and is never called exact
  assert.match(cli(dir, 'put', 'environment', '{"url":"https://staging.example","kind":"remote"}').stderr, /needs "revision"/)
  assert.equal(cli(dir, 'put', 'environment', '{"url":"https://staging.example","kind":"remote","unlinked":"human: staging only deploys main; accepted for copy changes"}').status, 0)
  const unlinked = cli(dir, 'start', 'verify')
  assert.match(unlinked.stdout, /link to this code: unlinked/)
  assert.match(unlinked.stdout, /not exact-code verification/)
  report(requestId(unlinked.stdout), { environment: 'https://staging.example', url: 'https://staging.example/page' })
  assert.equal(cli(dir, 'pass', 'verify').status, 0)
  assert.equal(load(dir).stages.verify.provenance, 'unlinked')
  assert.match(cli(dir, 'status').stdout, /environment NOT linked to this code/)
  // the deployment that reports the commit under review, and a local server from this checkout, are linked
  for (const [env, provenance] of [[`{"url":"https://pr-7.preview.example","kind":"remote","revision":"${git('rev-parse', 'HEAD').slice(0, 12)}"}`, 'deployment-revision'],
    ['{"url":"http://app.localhost:3000","kind":"local","server":"bin/dev from this checkout"}', 'local-checkout']]) {
    update(dir, run => { run.stages.verify.status = 'pending'; return run })
    assert.equal(cli(dir, 'put', 'environment', env).status, 0)
    const started = cli(dir, 'start', 'verify')
    const request = load(dir).stages.verify.request
    assert.equal(request.environment.provenance, provenance)
    // results written for the earlier environment are another request's
    assert.match(cli(dir, 'pass', 'verify').stderr, /0 of 1 checks reported/)
    report(requestId(started.stdout), { environment: JSON.parse(env).url, url: `${JSON.parse(env).url}/page` })
    assert.equal(cli(dir, 'pass', 'verify').status, 0)
    assert.equal(load(dir).stages.verify.provenance, provenance)
  }
  assert.deepEqual([load(dir).stages.verify.request.environment.build.tree, load(dir).stages.verify.request.environment.server], [git('rev-parse', 'HEAD^{tree}'), 'bin/dev from this checkout'])
  // the environment changed after verify started: the results no longer say where they ran
  update(dir, run => { run.stages.verify.status = 'running'; run.environment = ENV; return run })
  assert.match(cli(dir, 'pass', 'verify').stderr, /environment changed since verify started/)
})

test('R8: recover checks what a file is, not only that it parses, and restores only a valid backup', () => {
  const state = dir => join(dir, '.start-story', 'active.json')
  const inbox = dir => join(dir, '.start-story', 'sc-1', 'inbox.json')
  const withNotes = () => { const { dir } = repo(); withRun(dir); addNote(dir, { kind: 'note', text: 'first' }); addNote(dir, { kind: 'note', text: 'second' }); return dir }
  // the reviewed reproduction: a valid backup, and {} where the notes were
  let dir = withNotes()
  writeFileSync(inbox(dir), '{}')
  assert.throws(() => readInbox(dir, load(dir)), /unreadable \(not a list of notes\).*loop\.mjs recover/)
  const recovered = cli(dir, 'recover')
  assert.equal(recovered.status, 0, recovered.stderr)
  assert.doesNotMatch(recovered.stdout, /nothing to recover/)
  assert.deepEqual(readInbox(dir, load(dir)).map(n => n.text), ['first'])
  assert.ok(readdirSync(join(dir, '.start-story', 'sc-1')).some(f => f.startsWith('inbox.json.broken-')), 'the broken original is kept')
  // a list whose entries are not notes
  dir = withNotes()
  writeFileSync(inbox(dir), '[1, 2]')
  assert.throws(() => readInbox(dir, load(dir)), /entry 1 is not a note/)
  assert.equal(cli(dir, 'recover').status, 0)
  // cut-off JSON, as before
  dir = withNotes()
  writeFileSync(inbox(dir), '[{"id":"n1","te')
  assert.equal(cli(dir, 'recover').status, 0)
  assert.equal(readInbox(dir, load(dir)).length, 1)
  // a backup that is itself the wrong shape is not restored, and nothing is touched
  dir = withNotes()
  writeFileSync(inbox(dir), '{}'); writeFileSync(`${inbox(dir)}.prev`, '{"also":"wrong"}')
  const refused = cli(dir, 'recover')
  assert.equal(refused.status, 1)
  assert.match(refused.stderr, /the notes: .* is unreadable and there is no valid backup .*not a list of notes.*Nothing was changed/)
  assert.equal(readFileSync(inbox(dir), 'utf8'), '{}')
  // no backup at all
  dir = repo().dir; withRun(dir); addNote(dir, { kind: 'note', text: 'only' })
  writeFileSync(inbox(dir), '{}')
  assert.match(cli(dir, 'recover').stderr, /no valid backup .*none was kept/)
  // the run state: valid JSON that is not a run
  dir = repo().dir; withRun(dir); update(dir, r => ({ ...r, title: 'second' }))
  for (const broken of ['{}', '[]', '{"story":"sc-1"}', '{"story":"sc-1","stages":{"contract":{}}}']) {
    writeFileSync(state(dir), broken)
    assert.throws(() => load(dir), /unreadable.*loop\.mjs recover/, broken)
    assert.equal(cli(dir, 'status').status, 1)
    assert.equal(cli(dir, 'recover').status, 0)
    assert.equal(load(dir).story, 'sc-1')
  }
  // a wrong-shaped file never becomes the backup that recover would trust
  writeFileSync(state(dir), '{}')
  save(dir, { ...newRun('sc-1'), title: 'written over a broken file' })
  assert.equal(JSON.parse(readFileSync(join(dir, '.start-story', 'active.prev.json'), 'utf8')).story, 'sc-1')
  // already valid: nothing to do
  assert.match(cli(dir, 'recover').stdout, /nothing to recover/)
})

// ---- 0.10: lane, quality gate, human review, retro and the ledger ---------------------

const QUALITY = fileURLToPath(new URL('../skills/story-loop/scripts/quality.mjs', import.meta.url))
const quality = (cwd, ...args) => spawnSync('node', [QUALITY, ...args], { cwd, encoding: 'utf8' })

test('the lane is signed off with why, the hard decisions and the flag question answered', () => {
  assert.equal(laneProblem(LANE), null)
  assert.equal(laneProblem({ lane: 'heavy', why: 'a new column', hard: ['users.plan is a string enum'], flag: 'plans_v2' }), null)
  for (const [lane, why] of [[undefined, /JSON object/], [{ ...LANE, lane: 'huge' }, /one of: light, standard, heavy/], [{ ...LANE, why: ' ' }, /needs why/],
    [{ ...LANE, hard: undefined }, /needs "hard"/], [{ ...LANE, flag: undefined }, /needs "flag"/], [{ ...LANE, flag: '' }, /needs "flag"/]])
    assert.match(laneProblem(lane), why)
  const { dir } = repo()
  withRun(dir)
  assert.match(cli(dir, 'put', 'lane', '{"lane":"standard"}').stderr, /needs why/)
  assert.equal(cli(dir, 'put', 'lane', JSON.stringify({ ...LANE, lane: 'light' })).status, 0)
  assert.equal(load(dir).lane.lane, 'light')
})

test('slop signals are read from added lines; a skipped test counts only in a test file', () => {
  assert.deepEqual(Object.keys(signalsFor('app/a.rb', [[3, 'x = 1 # rubocop:disable Style/Foo'], [4, '# TODO: for now'], [5, 'it.skip("x")'], [6, 'temporary_value = a * b']])),
    ['app/a.rb:3:lint-disable', 'app/a.rb:4:workaround-comment'])
  assert.deepEqual(Object.keys(signalsFor('spec/a_spec.rb', [[1, "  xit 'works' do"], [2, "  skip 'later'"], [3, "  it 'skips nothing' do"]])),
    ['spec/a_spec.rb:1:skipped-test', 'spec/a_spec.rb:2:skipped-test'])
  assert.deepEqual(Object.keys(signalsFor('src/a.test.ts', [[1, 'describe.only("x", () => {'], [2, '// @ts-expect-error wrong type on purpose']])),
    ['src/a.test.ts:1:skipped-test', 'src/a.test.ts:2:lint-disable'])
})

test('the quality gate passes only with clean lint and every signal removed or accepted, for this exact code', () => {
  const { dir, git, commit } = repo()
  withRun(dir)
  update(dir, r => { r.stages.contract.status = 'passed'; r.stages.build.status = 'passed'; return r })
  commit('calc.rb', 'def a\n  1 # rubocop:disable Lint/Foo\nend\n')
  assert.equal(cli(dir, 'start', 'quality').status, 0)
  assert.match(cli(dir, 'pass', 'quality').stderr, /no quality results/)
  assert.match(quality(dir).stderr, /name the lint command/)
  // a failing linter is not waved through
  assert.equal(quality(dir, '--lint', 'echo offense; exit 3').status, 1)
  assert.match(cli(dir, 'pass', 'quality').stderr, /lint failed: echo offense; exit 3/)
  // clean lint, one signal: it needs a decision
  assert.match(quality(dir, '--lint', 'true').stdout, /SIGNAL\s+calc\.rb:2:lint-disable/)
  assert.match(cli(dir, 'pass', 'quality').stderr, /1 slop signals need a decision: calc\.rb:2:lint-disable/)
  assert.match(cli(dir, 'quality', 'accept', 'calc.rb:9:nope', 'x').stderr, /not a signal of these results/)
  assert.equal(cli(dir, 'quality', 'accept', 'calc.rb:2:lint-disable', 'the cop misreads this DSL').status, 0)
  // a second run on the same code keeps the reason
  const again = quality(dir, '--lint', 'true')
  assert.equal(again.status, 0)
  assert.match(again.stdout, /accepted\s+calc\.rb:2:lint-disable[\s\S]*quality gate: clean/)
  assert.equal(cli(dir, 'pass', 'quality').status, 0)
  assert.equal(load(dir).stages.quality.tree, git('rev-parse', 'HEAD^{tree}'))
  // a later commit: the gate covered other code
  commit('calc.rb', 'def a\n  2\nend\n')
  assert.deepEqual(staleStages(dir, load(dir)), ['quality'])
  assert.match(passProblem(dir, load(dir), 'quality'), /cover older code/)
  // a reason given for other code is not carried over
  commit('calc.rb', 'def a\n  3 # rubocop:disable Lint/Foo\nend\n')
  assert.equal(quality(dir, '--no-lint', 'no linter for this file type').status, 1)
  assert.deepEqual(load(dir).evidence.quality.dispositions, {})
})

test('tests added in test review are checked by the quality gate then, not found stale at the push', () => {
  const { dir, git, commit } = repo()
  withRun(dir, { lane: { ...LANE, lane: 'light' } })
  update(dir, r => { r.stages.contract.status = 'passed'; r.stages.build.status = 'passed'; return r })
  const lines = n => Array.from({ length: n }, (_, i) => `x${i} = ${i}`).join('\n') + '\n'
  commit('calc.rb', lines(160)) // over the light lane's 150
  assert.equal(cli(dir, 'start', 'quality').status, 0)
  quality(dir, '--lint', 'true')
  assert.equal(cli(dir, 'quality', 'accept', 'size', 'human: accept the size').status, 0)
  assert.equal(cli(dir, 'pass', 'quality').status, 0)
  assert.equal(cli(dir, 'start', 'test_review').status, 0)

  // Test review adds a test for a surviving mutant: the gate has not seen it.
  commit('calc_spec.rb', lines(10))
  update(dir, r => ({ ...r, evidence: { ...r.evidence, mutants: { tree: git('rev-parse', 'HEAD^{tree}'), lane: 'light', scope: [], covered: [], outcomes: { 'calc.rb:1:aaaaaa': 'killed' } } } }))
  assert.match(passProblem(dir, load(dir), 'test_review'), /changed the code after the quality gate; run quality\.mjs again/)

  // One clean run brings the gate up to date, and the human's size yes carries over to the grown diff.
  const again = quality(dir, '--lint', 'true')
  assert.equal(again.status, 0, again.stdout + again.stderr)
  assert.match(again.stdout, /accepted\s+size .*\n[\s\S]*quality gate: clean/)
  assert.match(load(dir).evidence.quality.dispositions.size, /^human: accept the size \(carried from 160 lines\)$/)
  assert.equal(load(dir).stages.quality.tree, git('rev-parse', 'HEAD^{tree}'))
  assert.deepEqual(staleStages(dir, load(dir)), [])
  assert.equal(passProblem(dir, load(dir), 'test_review'), null)

  // Grown by more than a quarter: the human is asked again, and the gate stays stale until then.
  commit('more_spec.rb', lines(60))
  assert.equal(quality(dir, '--lint', 'true').status, 1)
  assert.equal(load(dir).evidence.quality.dispositions.size, undefined)
  assert.deepEqual(staleStages(dir, load(dir)), ['quality'])
})

test('a diff larger than the signed-off lane is a signal the human has to accept', () => {
  const { dir, commit } = repo()
  withRun(dir, { lane: { ...LANE, lane: 'light' } })
  commit('big.rb', Array.from({ length: 200 }, (_, i) => `puts ${i}`).join('\n') + '\n')
  commit('Gemfile.lock', 'x\n'.repeat(900)) // generated files do not count
  const out = quality(dir, '--no-lint', 'no linter here')
  assert.match(out.stdout, /SIGNAL\s+size\s+200 changed lines; the light lane was signed off for 150/)
  assert.match(qualityProblem(load(dir).evidence.quality), /size \(size\)/)
  assert.match(cli(dir, 'quality', 'accept', 'size', 'it is fine').stderr, /only on the human's word/)
  assert.equal(cli(dir, 'quality', 'accept', 'size', 'human: generated fixtures, keep it in one PR').status, 0)
  assert.equal(qualityProblem(load(dir).evidence.quality), null)
})

test('the human review round ends at merge with every reviewer comment settled', () => {
  const run = { ...newRun('sc-1'), pr: 7 }
  assert.match(humanReviewProblem(run), /not fetched yet/)
  run.human_review = { comments: { ids: ['11', 'review-5'], pr_state: 'OPEN' } }
  assert.match(humanReviewProblem(run), /2 of 2 reviewer comments have no finding/)
  run.findings = [{ id: 'h1', source: 'human-review', comment: '11', severity: 'major', verdict: 'fix_requested' },
    { id: 'h2', source: 'human-review', comment: 'review-5', severity: 'question', verdict: 'rejected', note: 'answered in the thread' }]
  assert.match(humanReviewProblem(run), /h1 is fix_requested/)
  run.findings[0] = { ...run.findings[0], verdict: 'fixed', commit: 'abc' }
  assert.match(humanReviewProblem(run), /was open when the comments were last fetched/)
  run.human_review.comments.pr_state = 'MERGED'
  assert.equal(humanReviewProblem(run), null)
  // the human may take the review from here; the retro is never skipped
  const at = done(newRun('sc-1'), ...GRAPH.stages.slice(0, -2).map(s => s.id))
  assert.equal(current(at), 'human_review')
  assert.throws(() => move(at, 'skip', 'human_review', undefined, 'nobody commented'), /human's say-so/)
  const skipped = move(at, 'skip', 'human_review', undefined, 'human: I take the review from here')
  assert.throws(() => move(skipped, 'skip', 'retro', undefined, 'human: no time'), /never skipped/)
})

test('the retro names a lesson for every correction, and each run leaves one line in the ledger', () => {
  const { dir } = repo()
  withRun(dir, {
    findings: [{ id: 'r1', source: 'codex', severity: 'major', verdict: 'fixed', commit: 'abc' }, { id: 'r2', source: 'codex', severity: 'nit', verdict: 'rejected', note: 'cosmetic' }],
    history: [{ at: 'x', from: 'second_review', to: 'build', reason: 'empty state missing', evidence: {} }],
    tasks: [{ id: 't1', tier: 'sonnet', status: 'accepted', returns: 1 }, { id: 't2', tier: 'haiku', status: 'accepted' }],
  })
  update(dir, r => { for (const s of Object.values(r.stages)) s.status = 'passed'; r.stages.retro.status = 'pending'; return r })
  assert.equal(cli(dir, 'start', 'retro').status, 0)
  assert.match(cli(dir, 'pass', 'retro').stderr, /record what this run taught/)
  const lesson = over => ({ id: 'l1', pattern: 'missing-empty-state', from: ['r1', 'back:1'], check: 'test', proposal: 'request spec for a shelf with no flows', ...over })
  const refused = lessons => { cli(dir, 'put', 'lessons', JSON.stringify(lessons)); return cli(dir, 'pass', 'retro').stderr }
  assert.match(refused([]), /2 corrections have no lesson: r1, back:1/)
  assert.match(refused([lesson({ pattern: 'Missing Empty State' })]), /needs a pattern/)
  assert.match(refused([lesson({ check: 'vibes' })]), /needs a check \(lint \| type \| test/)
  assert.match(refused([lesson({ proposal: undefined })]), /say what it would be/)
  assert.match(refused([lesson({ check: 'none', proposal: undefined })]), /say why/)
  assert.match(refused([lesson({ from: ['r1'] })]), /1 corrections have no lesson: back:1/)
  cli(dir, 'put', 'lessons', JSON.stringify([lesson()]))
  assert.equal(cli(dir, 'pass', 'retro').status, 0)
  const [entry] = readLedger(dir)
  assert.deepEqual([entry.story, entry.lane, entry.ended, entry.stage, entry.lessons[0].pattern, entry.backs[0].from, entry.findings['codex:fixed'], entry.tasks['sonnet:returned'], entry.usage],
    ['sc-1', 'standard', false, null, 'missing-empty-state', 'second_review', 1, 1, null])
  assert.match(entry.factory, /^\d+\.\d+\.\d+$/)
  // ending the run writes its line again; the ledger reads one line per run, and outlives the run
  assert.equal(cli(dir, 'end').status, 0)
  assert.deepEqual(readLedger(dir).map(e => e.ended), [true])
  const text = cli(dir, 'ledger').stdout
  assert.match(text, /1 run · factory versions/)
  assert.match(text, /1×  missing-empty-state  \[test\]  → request spec for a shelf with no flows/)
  assert.match(text, /1×  second_review → build/)
  assert.match(text, /sonnet\s+1 \/ 1\n\s+haiku\s+0 \/ 1/)
  assert.match(summary([]), /the ledger is empty/)
})

test('token usage is read from the sessions\' transcripts, once per message, under the stage that was running', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sl-usage-'))
  const transcript = join(dir, 's1.jsonl')
  mkdirSync(join(dir, 's1', 'subagents'), { recursive: true })
  const row = (id, ts, model, output) => JSON.stringify({ type: 'assistant', timestamp: ts, message: { id, model, usage: { input_tokens: 1, cache_read_input_tokens: 10, cache_creation_input_tokens: 5, output_tokens: output } } })
  writeFileSync(transcript, [row('m0', '2026-01-01T00:00:00Z', 'fable', 9), // before the run started
    row('m1', '2026-01-01T01:00:10Z', 'fable', 100), row('m1', '2026-01-01T01:00:11Z', 'fable', 100), // one message, written once per content block
    '{"type":"user"}', 'cut off {', row('m2', '2026-01-01T01:10:00Z', 'fable', 7)].join('\n'))
  writeFileSync(join(dir, 's1', 'subagents', 'agent-a.jsonl'), row('m3', '2026-01-01T01:11:00Z', 'opus', 50))
  const run = { started_at: '2026-01-01T01:00:00Z', transcripts: [transcript, join(dir, 'gone.jsonl')] }
  const events = [{ kind: 'stage', verb: 'start', stage: 'build', ts: '2026-01-01T01:00:05Z' }, { kind: 'stage', verb: 'pass', stage: 'build', ts: '2026-01-01T01:04:00Z' },
    { kind: 'stage', verb: 'start', stage: 'verify', ts: '2026-01-01T01:05:00Z' }]
  const u = usage(run, events)
  assert.equal(u.messages, 3)
  assert.deepEqual(u.by_stage.build, { input: 1, cache_write: 5, cache_read: 10, output: 100 })
  assert.equal(u.by_stage.verify.output, 57)
  assert.deepEqual(Object.keys(u.by_model).sort(), ['fable', 'opus'])
  assert.equal(usage({ started_at: 'x' }, []), null)
  // build 116, verify 23 + 66: 89 of 205 tokens went into checking
  assert.match(summary([{ run: 'a', usage: u, lessons: [], backs: [], tasks: {} }]), /Tokens \(1 run with a transcript\): 205 per run, 43% in the stages that check the work/)
})

test('diffs are taken against the remote base: a stale local main does not count other people\'s commits', async () => {
  const { diffBase } = await import('../skills/story-loop/scripts/loop.mjs')
  const { dir, git, commit } = repo({ remote: true })
  const g = (...args) => git(...args)
  assert.equal(diffBase(g, 'main'), 'origin/main')
  assert.equal(diffBase(g, 'origin/main'), 'origin/main')
  // Someone else lands on origin/main; the local main stays behind; the story branch is cut from origin.
  git('checkout', '-q', 'main'); commit('other.txt', 'theirs'); git('push', '-q', 'origin', 'main'); git('reset', '-q', '--hard', 'HEAD~1')
  git('checkout', '-qb', 'feat/two', 'origin/main'); commit('mine.txt', 'mine')
  assert.equal(git('diff', '--name-only', `${diffBase(g, 'main')}...HEAD`), 'mine.txt')
  const { dir: bare, git: g2 } = repo()
  assert.equal(diffBase((...a) => g2(...a), 'main'), 'main', 'no remote: the local branch is the base')
  assert.ok(dir && bare)
})

test('await-human: a waiter in the background ends with the board\'s answer, and a newer waiter replaces an older one', async () => {
  const { dir } = repo()
  withRun(dir)
  const waiter = () => {
    const child = spawn('node', [LOOP, 'await-human'], { cwd: dir, encoding: 'utf8' })
    let out = ''
    child.stdout.on('data', d => { out += d })
    return { child, done: new Promise(ok => child.on('close', code => ok({ code, out }))) }
  }
  const first = waiter()
  await new Promise(ok => setTimeout(ok, 700))
  const second = waiter()
  const replaced = await first.done
  assert.equal(replaced.code, 0)
  assert.match(replaced.out, /a newer waiter took over/)

  update(dir, r => { r.stages.contract = { ...r.stages.contract, status: 'waiting', waiting_on: 'human', reason: 'accept the new size?' }; return r })
  addNote(dir, { kind: 'answer', stage: 'contract', verdict: 'no', text: 'split the story', question: 'accept the new size?' })
  const answered = await second.done
  assert.equal(answered.code, 0)
  assert.match(answered.out, /answer to your question · stage contract\n {2}You asked: "accept the new size\?"\n {2}human: no — split the story/)
  assert.equal(readInbox(dir, load(dir))[0].status, 'delivered', 'handed over once; the hook does not hand it again')
  assert.match(cli(dir, 'await-human', '--minutes', '0').stderr, /--minutes needs a positive number/)
})

test('a later attempt keeps a browser pass when no changed code serves its step', () => {
  const checks = [{ id: 'a', step: 1 }, { id: 'b', step: 2 }, { id: 'c', step: 3 }]
  const prior = { checks_revision: 1, environment: ENV.url, results: [{ id: 'a' }, { id: 'b' }] }
  const tasks = [{ files: ['app/x.js'], steps: [1] }, { files: ['app/y.js'], steps: [2] }, { files: ['config/z.yml'] }]
  const plan = delta => verifyCarry({ checks, checksRevision: 1, environment: ENV.url, prior, delta, tasks })
  // y.js serves step 2 only: a keeps its pass, b runs again, c never passed so it runs
  assert.deepEqual([plan(['app/y.js']).carry, plan(['app/y.js']).rerun], [['a'], ['b', 'c']])
  // only tests changed: every earlier pass stands
  assert.deepEqual(plan(['spec/y_spec.rb', 'app/frontends/y.test.ts']).carry, ['a', 'b'])
  // code no task maps to a step, a task without steps, or no comparable diff: everything runs
  for (const delta of [['app/other.rb'], ['config/z.yml'], null]) assert.deepEqual(plan(delta).carry, [], String(delta))
  // another check list or environment: everything runs
  assert.deepEqual(verifyCarry({ checks, checksRevision: 2, environment: ENV.url, prior, delta: [], tasks }).carry, [])
  assert.deepEqual(verifyCarry({ checks, checksRevision: 1, environment: 'http://127.0.0.1:4000', prior, delta: [], tasks }).carry, [])
})

test('a second review of a small fix in the named files reviews the delta; anything else is full and blind', () => {
  const findings = [{ id: 'r1', file: 'app/x.rb:12', verdict: 'fixed', commit: 'abc1234' }, { id: 'r2', file: 'app/old.rb', verdict: 'fixed', commit: 'fff0000' }, { id: 'r3', verdict: 'rejected', file: 'app/y.rb' }]
  const delta = (files, lines = 10) => ({ files, lines, commits: ['abc1234deadbeef'] })
  const scope = (d, f = findings) => reviewScope({ prior: { commit: 'p1' }, delta: d, branchLines: 100, findings: f })
  assert.deepEqual(scope(delta(['app/x.rb', 'spec/x_spec.rb'])), { scope: 'delta', since: 'p1', confirm: ['r1'], why: 'the fix stays in the files of r1 and is 10 of 100 lines' })
  // a finding fixed in an earlier round does not widen what this fix may touch
  assert.equal(scope(delta(['app/old.rb'])).scope, 'full')
  // code no finding named, a fix past a quarter of the branch, no finding sent back, no prior review
  assert.equal(scope(delta(['app/x.rb', 'app/y.rb'])).scope, 'full')
  assert.equal(scope(delta(['app/x.rb'], 26)).scope, 'full')
  assert.equal(scope(delta(['app/x.rb']), [findings[2]]).scope, 'full')
  assert.equal(reviewScope({ delta: delta(['app/x.rb']), branchLines: 100, findings }).scope, 'full')
})

test('verify carries over the passes of checks whose step the fix did not touch, and refuses a forged carry', () => {
  const r = repo()
  const { dir, commit } = r
  commit('x.js', 'one'); commit('y.js', 'one')
  withRun(dir, { checks: [{ id: 'a', step: 1 }, { id: 'b', step: 2 }], checks_revision: 1, browser: 'chrome', environment: ENV,
    tasks: [{ id: 't1', status: 'accepted', files: ['x.js'], steps: [1] }, { id: 't2', status: 'accepted', files: ['y.js'], steps: [2] }] })
  const toVerify = () => update(dir, run => { for (const id of ['contract', 'build', 'quality', 'test_review']) run.stages[id].status = 'passed'; return run })
  const shot = name => { const run = load(dir); mkdirSync(evidenceDir(dir, run), { recursive: true }); writeFileSync(join(evidenceDir(dir, run), name), PNG) }
  const row = (id, step, extra = {}) => ({ id, step, verdict: 'pass', evidence: [`${id}.png`], ...META, ...extra })
  toVerify()
  const first = cli(dir, 'start', 'verify').stdout.match(/verify request: (\S+)/)[1]
  shot('a.png'); shot('b.png')
  writeFileSync(resultsFile(dir, load(dir)), written(first, [row('a', 1), row('b', 2, { verdict: 'fail' })]))
  assert.equal(cli(dir, 'back', 'verify', 'build', 'b fails').status, 0)
  // the fix touches y.js, which serves step 2 only
  commit('y.js', 'two')
  toVerify()
  const out = cli(dir, 'start', 'verify').stdout
  assert.match(out, /carried over from the last attempt: a/)
  assert.match(out, /the browser checks: b {2}\(the changed code serves step 2\)/)
  const second = out.match(/verify request: (\S+)/)[1]
  const kept = JSON.parse(readFileSync(resultsFile(dir, load(dir)), 'utf8'))
  assert.deepEqual([kept.request, kept.results.map(x => x.id), existsSync(join(evidenceDir(dir, load(dir)), 'a.png'))], [second, ['a'], true])
  // a carry the plan did not grant is refused
  shot('b.png')
  writeFileSync(resultsFile(dir, load(dir)), written(second, [...kept.results, row('b', 2, { carried: { from: first } })]))
  assert.match(cli(dir, 'pass', 'verify').stderr, /"b" is marked carried over, but this attempt runs it again/)
  writeFileSync(resultsFile(dir, load(dir)), written(second, [...kept.results, row('b', 2)]))
  assert.equal(cli(dir, 'pass', 'verify').status, 0)
})
