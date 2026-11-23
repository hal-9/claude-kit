import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  newRun, move, current, stopReason, GRAPH, verifyProblem, resultsFile, evidenceDir, storyId, issueRepo, remoteRepo,
  load, save, update, withLock, migrate, passProblem, findingsProblem, readInbox, addNote, deliver, staleStages,
} from '../skills/story-loop/scripts/loop.mjs'
import { repo, withRun, PNG, B } from './helpers.mjs'

const LOOP = fileURLToPath(new URL('../skills/story-loop/scripts/loop.mjs', import.meta.url))
const done = (run, ...stages) => stages.reduce((r, s) => move(move(r, 'start', s), 'pass', s), run)
const cli = (cwd, ...args) => spawnSync('node', [LOOP, ...args], { cwd, encoding: 'utf8' })

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
  let run = { ...newRun('sc-1'), checks: [{ id: 'a', step: 1 }, { id: 'b', step: 1, case: 'mobile' }] }
  const write = results => writeFileSync(resultsFile(root, run), JSON.stringify(results))
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

  run = { ...run, checks: [] }
  assert.match(verifyProblem(root, run), /empty: no user journey/)
})

test('going back archives browser results, so an old attempt never passes the next one', () => {
  const { dir } = repo()
  const run = withRun(dir, { checks: [{ id: 'a', step: 1 }] })
  mkdirSync(evidenceDir(dir, run), { recursive: true })
  writeFileSync(join(evidenceDir(dir, run), 'a.png'), PNG)
  writeFileSync(resultsFile(dir, run), JSON.stringify([{ id: 'a', step: 1, verdict: 'pass', evidence: ['a.png'] }]))
  assert.equal(verifyProblem(dir, run), null)
  update(dir, r => {
    for (const id of ['contract', 'build', 'test_review', 'verify']) r.stages[id].status = 'passed'
    r.stages.second_review.status = 'running'
    return r
  })
  assert.equal(cli(dir, 'back', 'second_review', 'build', 'defect').status, 0)
  assert.match(verifyProblem(dir, load(dir)), /0 of 1 checks reported/)
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
  run.evidence = { mutants: { tree, valid: 0, total: 0 } }
  assert.match(passProblem(dir, run, 'test_review'), /no valid mutant/)
  run.evidence = { mutants: { tree, valid: 3, infra: 1, inconclusive: 0 } }
  assert.match(passProblem(dir, run, 'test_review'), /inconclusive/)
  run.evidence = { mutants: { tree, valid: 3, infra: 0, inconclusive: 0, timeout: 1 } }
  assert.equal(passProblem(dir, run, 'test_review'), null)

  run.findings = [{ id: 'c1', source: 'codex', severity: 'major', verdict: 'open' }]
  assert.match(passProblem(dir, run, 'second_review'), /who reviewed/)
  run.reviewer = 'codex'
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
  Object.assign(run, { pushed: { state: 'confirmed', sha: head }, ci: { sha: head, state: 'pending' } })
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
