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
  verifyRequest, commentsProblem, mutantsProblem, imageProblem,
} from '../skills/story-loop/scripts/loop.mjs'
import { repo, withRun, PNG, B } from './helpers.mjs'

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
  let run = done(newRun('sc-1'), 'contract', 'build', 'test_review', 'verify')
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
  run = move(done(run, 'build'), 'start', 'test_review')
  assert.throws(() => move(run, 'back', 'test_review', 'build', 'again'), /show the human/)
})

test('a human can send a finished run back, and is not capped', () => {
  let run = done(newRun('sc-1'), ...GRAPH.stages.map(s => s.id))
  assert.throws(() => move(run, 'back', 'verify', 'build', 'human: x'), /not the current stage/)
  run.stages.build.rounds = GRAPH.maxRounds
  run = move(run, 'back', 'report', 'build', 'human: use a scope')
  assert.equal(current(run), 'build')
  assert.equal(run.stages.build.rounds, GRAPH.maxRounds)
})

test('skips follow the per-stage policy', () => {
  assert.throws(() => move(newRun('sc-1'), 'skip', 'contract', undefined, 'already started'), /never skipped/)
  let run = done(newRun('sc-1'), 'contract', 'build', 'test_review')
  assert.throws(() => move(run, 'skip', 'verify', undefined, 'no browser available'), /a wait, not a skip/)
  run = move(run, 'skip', 'verify', undefined, 'human: migration only, no page')
  assert.throws(() => move(run, 'skip', 'second_review', undefined, 'human: skip it'), /never skipped/)
})

test('verify counts against the approved check list, and only real screenshots in the folder count', () => {
  const root = mkdtempSync(join(tmpdir(), 'sl-verify-'))
  let run = { ...newRun('sc-1'), checks: [{ id: 'a', step: 1 }, { id: 'b', step: 1, case: 'mobile' }], checks_revision: 1 }
  assert.match(verifyProblem(root, run), /verify was not started on this attempt/)
  run.stages.verify.request = verifyRequest(run, 'tree-a')
  const write = (results, request = run.stages.verify.request.id) => writeFileSync(resultsFile(root, run), written(request, results))
  mkdirSync(evidenceDir(root, run), { recursive: true })
  writeFileSync(join(evidenceDir(root, run), 'a.png'), PNG)
  writeFileSync(join(evidenceDir(root, run), 'b.png'), PNG)
  const pass = (id, evidence = [`${id}.png`]) => ({ id, step: 1, verdict: 'pass', evidence })

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
  const run = withRun(dir, { checks: [{ id: 'a', step: 1 }] })
  run.stages.verify.request = verifyRequest(run, 'tree-a')
  save(dir, run)
  mkdirSync(evidenceDir(dir, run), { recursive: true })
  writeFileSync(join(evidenceDir(dir, run), 'a.png'), PNG)
  writeFileSync(resultsFile(dir, run), written(run.stages.verify.request.id, [{ id: 'a', step: 1, verdict: 'pass', evidence: ['a.png'] }]))
  assert.equal(verifyProblem(dir, run), null)
  update(dir, r => {
    for (const id of ['contract', 'build', 'test_review', 'verify']) r.stages[id].status = 'passed'
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
  assert.equal(run.schema, 2)
  assert.equal(run.migrated_from, 1)
  assert.deepEqual(run.owner, { session: 's1', since: 'x', heartbeat: 0 })
  assert.deepEqual(run.tasks, [1])
  assert.equal(run.stages.verify.tree, undefined)
  // H18: passed stages that name no code tree prove nothing about the code now
  assert.deepEqual(staleStages(mkdtempSync(join(tmpdir(), 'sl-old-')), run, 'any-tree'), ['test_review', 'verify', 'second_review'])
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
  assert.match(passProblem(dir, run, 'second_review'), /record the review of this code/)
  run.review = { reviewer: 'codex', attempt: 1, tree: 'older' }
  assert.match(passProblem(dir, run, 'second_review'), /covered older code or an earlier attempt/)
  run.review = { reviewer: 'codex', attempt: 1, tree }
  assert.match(passProblem(dir, run, 'second_review'), /c1 is open/)

  assert.match(passProblem(dir, run, 'push'), /nothing published/)
  assert.match(passProblem(dir, run, 'copilot_review'), /no Copilot review/)
})

test('a code change after the reviews makes their evidence stale until the run goes back', () => {
  const { dir, git, commit } = repo()
  const tree = git('rev-parse', 'HEAD^{tree}')
  const head = git('rev-parse', 'HEAD')
  const run = withRun(dir)
  for (const id of ['contract', 'build', 'test_review', 'verify', 'second_review', 'push', 'copilot_review']) run.stages[id].status = 'passed'
  for (const id of ['test_review', 'verify', 'second_review']) run.stages[id].tree = tree
  Object.assign(run, { pushed: { state: 'confirmed', sha: head }, ci: { sha: head, state: 'pending' }, copilot: { review: { id: 9 }, comments: { review: 9, ids: [] } } })
  assert.deepEqual(staleStages(dir, run), [])
  assert.match(passProblem(dir, run, 'report'), /required CI is pending/)
  run.ci.state = 'pass'
  assert.match(passProblem(dir, run, 'report'), /report for HEAD is not posted/)
  commit()
  assert.deepEqual(staleStages(dir, run), ['test_review', 'verify', 'second_review'])
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
  withRun(r.dir, { checks: [{ id: 'a', step: 1 }], checks_revision: 1, browser: 'chrome' })
  update(r.dir, run => { run.stages.contract.status = 'passed'; run.stages.build.status = 'passed'; Object.assign(run.stages.test_review, { status: 'skipped', reason: 'template only' }); return run })
  const report = request => {
    const run = load(r.dir)
    mkdirSync(evidenceDir(r.dir, run), { recursive: true })
    writeFileSync(join(evidenceDir(r.dir, run), 'a.png'), PNG)
    writeFileSync(resultsFile(r.dir, run), written(request, [{ id: 'a', step: 1, verdict: 'pass', evidence: ['a.png'] }]))
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
  update(dir, run => { Object.assign(run, { checks: [{ id: 'a', step: 1 }], checks_revision: 1, browser: 'chrome' }); run.stages.contract.status = 'passed'; run.stages.build.status = 'passed'; run.stages.test_review.status = 'skipped'; return run })
  assert.equal(cli(dir, 'start', 'verify').status, 0)
  assert.match(cli(dir, 'pass', 'verify').stderr, /0 of 1 checks reported/)
})

test('H02: a review is an artifact for one attempt and one code tree; the last attempt\'s never passes the next', () => {
  const { dir, git, commit } = repo()
  withRun(dir, { findings: [{ id: 'r1', source: 'codex', severity: 'minor', verdict: 'rejected', note: 'out of scope' }] })
  const at = stage => update(dir, run => {
    for (const id of GRAPH.stages.map(s => s.id)) { if (id === stage) break; run.stages[id].status = 'passed' }
    run.stages[stage].status = 'running'
    return run
  })
  at('second_review')
  writeFileSync(join(dir, '.start-story', 'out.txt'), 'No blocking findings. One minor: r1.')
  assert.match(cli(dir, 'put', 'reviewer', 'codex').stderr, /recorded with its output/)
  assert.match(cli(dir, 'pass', 'second_review').stderr, /record the review of this code/)
  assert.match(cli(dir, 'review', 'codex', join(dir, '.start-story', 'empty.txt')).stderr, /cannot read/)
  assert.equal(cli(dir, 'review', 'codex', join(dir, '.start-story', 'out.txt')).status, 0)
  const review = load(dir).review
  assert.deepEqual([review.reviewer, review.attempt, review.tree, review.commit], ['codex', 1, git('rev-parse', 'HEAD^{tree}'), git('rev-parse', 'HEAD')])
  assert.match(readFileSync(review.output, 'utf8'), /One minor/)
  assert.equal(cli(dir, 'pass', 'second_review').status, 0)
  // back to build, a new commit, forward again: reviewer name and settled findings are all still there
  update(dir, run => { run.stages.push.status = 'running'; return run })
  assert.equal(cli(dir, 'back', 'push', 'build', 'defect found').status, 0)
  commit()
  at('second_review')
  assert.equal(load(dir).reviewer, 'codex')
  const refused = cli(dir, 'pass', 'second_review')
  assert.equal(refused.status, 1)
  assert.match(refused.stderr, /covered older code or an earlier attempt/)
  assert.equal(cli(dir, 'review', 'codex', join(dir, '.start-story', 'out.txt')).status, 0)
  assert.equal(cli(dir, 'pass', 'second_review').status, 0)
  assert.equal(load(dir).review.attempt, 2)
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
