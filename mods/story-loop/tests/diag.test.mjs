// Diagnostic recording: off by default, never a source of truth, never in the way.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, appendFileSync, existsSync, symlinkSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { load, update, opStart, opUpdate, evidenceDir } from '../skills/story-loop/scripts/loop.mjs'
import { bind, record, readEvents, redact, diagDir, stageTimes, summarize } from '../skills/story-loop/scripts/diag.mjs'
import { repo, PNG } from './helpers.mjs'

const LOOP = fileURLToPath(new URL('../skills/story-loop/scripts/loop.mjs', import.meta.url))
const HOOK = fileURLToPath(new URL('../skills/story-loop/scripts/hook.mjs', import.meta.url))
const DIAG = new URL('../skills/story-loop/scripts/diag.mjs', import.meta.url).href
const cli = (cwd, ...args) => spawnSync('node', [LOOP, ...args], { cwd, encoding: 'utf8' })
const fire = (cwd, input) => spawnSync('node', [HOOK], { input: JSON.stringify({ cwd, session_id: 's1', ...input }), encoding: 'utf8' })
const bash = (command, more = {}) => ({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, ...more })
const stream = dir => { const run = load(dir); return diagDir(dir, run.story, run.id) }
const events = (dir, at = stream(dir)) => readEvents(at).events
const exported = out => out.stdout.match(/exported to (.*)/)[1]
// Stand-ins for secrets, made anew on every run: nothing in this file is, or looks like, a credential.
const fake = bytes => randomBytes(bytes).toString('hex')
// A run with recording on from its first moment.
function recording(story = 'sc-1') {
  const r = repo()
  const out = cli(r.dir, 'init', story, '--diagnostics')
  assert.equal(out.status, 0, out.stderr)
  return r
}

test('off by default: a run records nothing and behaves as before', () => {
  const { dir } = repo()
  assert.equal(cli(dir, 'init', 'sc-1').status, 0)
  assert.equal(load(dir).diagnostics, undefined)
  cli(dir, 'start', 'contract'); cli(dir, 'pass', 'contract'); cli(dir, 'put', 'title', 'x')
  fire(dir, bash('git status', { tool_use_id: 't1' }))
  assert.equal(fire(dir, bash('gh pr merge 1')).status, 2)
  assert.equal(record(dir, 'anything', { text: 'x' }), null)
  assert.equal(existsSync(join(dir, '.start-story', 'sc-1')), false, 'no diagnostics folder, no stream')
  assert.match(cli(dir, 'diagnostics', 'status').stdout, /diagnostics are off .* nothing was recorded/)
  assert.doesNotMatch(cli(dir, 'status').stdout, /diagnostics on/)
})

test('on: accepted and refused transitions are both recorded, with why', () => {
  const { dir, git } = recording()
  assert.match(cli(dir, 'status').stdout, /diagnostics on/)
  assert.equal(cli(dir, 'start', 'contract').status, 0)
  const refused = cli(dir, 'pass', 'contract', 'signed off')
  assert.equal(refused.status, 1)
  assert.equal(cli(dir, 'start', 'build').status, 1) // not the current stage
  assert.equal(cli(dir, 'wait', 'contract', 'human', 'sign-off').status, 0)
  const moves = events(dir).filter(e => e.kind === 'transition')
  assert.deepEqual(moves.map(e => [e.details.verb, e.stage, e.outcome]), [['start', 'contract', 'accepted'], ['pass', 'contract', 'rejected'], ['start', 'build', 'rejected'], ['wait', 'contract', 'accepted']])
  assert.match(moves[1].reason, /contract cannot pass: record title/)
  assert.match(moves[2].reason, /not the current stage/)
  assert.deepEqual([moves[0].details.from_status, moves[0].details.to_status, moves[3].details.to], ['pending', 'running', 'human'])
  assert.deepEqual([moves[0].commit, moves[0].tree, moves[0].attempt], [git('rev-parse', 'HEAD'), git('rev-parse', 'HEAD^{tree}'), 1])
  const first = events(dir)[0]
  assert.deepEqual([first.kind, first.v, first.run, first.story], ['run.start', 1, load(dir).id, 'sc-1'])
  // every event carries the whole envelope; what is not known is null, never invented
  for (const e of events(dir)) for (const key of ['id', 'ts', 'run', 'story', 'stage', 'attempt', 'session', 'agent', 'op', 'parent_op', 'request', 'revision', 'commit', 'tree', 'base', 'kind', 'outcome', 'reason', 'elapsed_ms', 'details'])
    assert.ok(key in e, `${e.kind} has ${key}`)
  assert.equal(first.session, null)
  const manifest = JSON.parse(readFileSync(join(stream(dir), 'manifest.json'), 'utf8'))
  assert.equal(manifest.coverage, 'recorded from the start of the run')
  assert.match(manifest.versions.node, /^v\d+/)
  assert.ok('claude' in manifest.versions && 'gh' in manifest.versions, 'a version that could not be read is null, not left out')
})

test('tool calls: finished, failed, interrupted and never-completed are told apart', () => {
  const { dir } = recording()
  const pre = (id, command) => fire(dir, bash(command, { tool_use_id: id }))
  const post = (id, more) => fire(dir, { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'x' }, tool_use_id: id, ...more })
  const failed = (id, more) => fire(dir, { hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: { command: 'x' }, tool_use_id: id, ...more })
  pre('t-ok', 'npm test'); post('t-ok', { duration_ms: 4187, tool_response: { exitCode: 0 } })
  pre('t-fail', 'npm test'); failed('t-fail', { error: 'Exit code 1\nError: Cannot find module', is_interrupt: false, duration_ms: 12 })
  pre('t-timeout', 'sleep 999'); failed('t-timeout', { error: 'Command timed out after 2m 0s' })
  pre('t-abort', 'npm test'); failed('t-abort', { error: 'aborted', is_interrupt: true })
  pre('t-cancelled', 'npm run build') // cancelled: Claude Code fires no completion hook at all
  fire(dir, { hook_event_name: 'SessionEnd', reason: 'prompt_input_exit' })
  const all = events(dir)
  const of = id => all.filter(e => e.details?.tool_use_id === id).map(e => [e.kind, e.outcome])
  assert.deepEqual(of('t-ok'), [['tool.start', null], ['tool.end', 'ok']])
  assert.deepEqual(of('t-fail'), [['tool.start', null], ['tool.failed', 'error']])
  assert.deepEqual(of('t-abort'), [['tool.start', null], ['tool.failed', 'interrupted']])
  assert.deepEqual(of('t-cancelled'), [['tool.start', null]])
  const done = all.find(e => e.kind === 'tool.end')
  assert.deepEqual([done.elapsed_ms, done.session, done.agent, done.details.response.exit_code], [4187, 's1', 'conductor', 0])
  const timedOut = all.find(e => e.details?.tool_use_id === 't-timeout' && e.kind === 'tool.failed')
  assert.match(timedOut.reason, /timed out/)
  assert.equal(timedOut.elapsed_ms, null, 'no duration was reported, so none is recorded')
  assert.deepEqual([all.at(-1).kind, all.at(-1).reason], ['session.end', 'prompt_input_exit'])
  const summary = readFileSync(join(exported(cli(dir, 'diagnostics', 'export')), 'summary.md'), 'utf8')
  assert.match(summary, /1 tool call started with no recorded completion \(cancelled, interrupted, or the session ended; the hooks do not say which\): Bash/)
})

test('a guard denial is recorded before the exit, and a worker is told apart from the conductor', () => {
  const { dir } = recording()
  const denied = fire(dir, bash('gh pr merge 1', { tool_use_id: 't9', agent_id: 'w1', agent_type: 'story-loop:worker-opus' }))
  assert.equal(denied.status, 2)
  const [event] = events(dir).filter(e => e.kind === 'guard.denied')
  assert.match(event.reason, /never merges/)
  assert.deepEqual([event.details.tool, event.details.tool_use_id, event.agent], ['Bash', 't9', 'story-loop:worker-opus:w1'])
})

test('secrets are redacted before a record is written', () => {
  const { dir } = recording()
  // Each has the shape its kind has in the wild (a prefix, a length), and random content.
  const pat = `ghp_${fake(18)}`
  const bearer = [fake(10), fake(8), fake(8)].join('.')
  const aws = `AKIA${fake(8).toUpperCase()}`
  const [word, inUrl, cookie, key] = [fake(6), fake(6), `sessionid=${fake(6)}`, fake(8)]
  fire(dir, bash(`GH_TOKEN=${pat} curl -H "Authorization: Bearer ${bearer}" https://deploy:${inUrl}@example.com/hook --password ${word}`, { tool_use_id: 't1' }))
  fire(dir, { hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: { command: 'env' }, tool_use_id: 't1', error: `AWS_ACCESS_KEY_ID=${aws}\nCookie: ${cookie}\napi_key: "${key}"` })
  bind(dir, load(dir))
  const fields = { remote: `https://x-access-token:${pat}@github.com/acme/app.git`, headers: { Authorization: `token ${key}`, cookie }, nested: [{}] }
  fields.password = word
  fields.nested[0].client_secret = inUrl
  record(dir, 'probe', fields)
  cli(dir, 'put', 'title', `ship it (token=${key})`)
  const raw = readFileSync(join(stream(dir), 'events.jsonl'), 'utf8')
  for (const secret of [pat, bearer, aws, word, inUrl, cookie, key]) assert.equal(raw.includes(secret), false, `${secret} was written`)
  assert.match(raw, /\[redacted\]/)
  assert.match(raw, /github\.com\/acme\/app\.git/, 'what is not secret stays readable')
  const prose = 'the token expired and the sign-in field is empty'
  assert.equal(redact(prose), prose, 'prose about secrets is left alone')
  // a long output is cut, and says so
  record(dir, 'probe', { output: 'x'.repeat(5000) })
  assert.match(events(dir).at(-1).details.output, /truncated, 5000 chars/)
})

test('a recording that cannot be written warns and marks itself incomplete; refusals and stages are unchanged', () => {
  const { dir } = recording()
  cli(dir, 'start', 'contract')
  // the stream is unwritable from here on
  const file = join(stream(dir), 'events.jsonl')
  const kept = readFileSync(file, 'utf8')
  spawnSync('rm', [file]); mkdirSync(file)
  const denied = fire(dir, bash('gh pr merge 1'))
  assert.equal(denied.status, 2, 'the guard still refuses')
  assert.match(denied.stderr, /never merges/)
  assert.match(denied.stderr, /a record could not be written .*the recording is incomplete, the run is unaffected/)
  assert.equal(denied.stdout, '')
  const refused = cli(dir, 'pass', 'contract')
  assert.equal(refused.status, 1, 'a pass without evidence is still refused')
  assert.match(refused.stderr, /contract cannot pass/)
  assert.equal(cli(dir, 'put', 'title', 'works').status, 0)
  assert.equal(load(dir).title, 'works')
  // a hook that answers in JSON still prints JSON and nothing else
  update(dir, r => ({ ...r, owner: { session: 's1', since: 'x', heartbeat: Date.now() } }))
  assert.deepEqual(Object.keys(JSON.parse(fire(dir, { hook_event_name: 'Stop' }).stdout)), ['decision', 'reason'])
  spawnSync('rm', ['-r', file]); writeFileSync(file, kept)
  const out = cli(dir, 'diagnostics', 'export')
  assert.match(out.stdout, /the recording is INCOMPLETE/)
  const manifest = JSON.parse(readFileSync(join(exported(out), 'manifest.json'), 'utf8'))
  assert.equal(manifest.recording.complete, false)
  assert.ok(manifest.recording.write_failures.length >= 3)
  assert.match(readFileSync(join(exported(out), 'summary.md'), 'utf8'), /record\(s\) could not be written/)
})

test('a record cut off part way does not cost the events before it', () => {
  const { dir } = recording()
  cli(dir, 'start', 'contract')
  const before = events(dir).length
  appendFileSync(join(stream(dir), 'events.jsonl'), '{"v":1,"id":"cut-off","ts":"2026-01-01T00:00:00.0')
  const read = readEvents(stream(dir))
  assert.deepEqual([read.events.length, read.unreadable], [before, 1])
  const out = cli(dir, 'diagnostics', 'export')
  const manifest = JSON.parse(readFileSync(join(exported(out), 'manifest.json'), 'utf8'))
  assert.deepEqual([manifest.events.count, manifest.events.unreadable_lines, manifest.recording.complete], [before, 1, false])
  assert.match(cli(dir, 'diagnostics', 'status').stdout, /1 unreadable line/)
})

test('parallel writers leave whole, attributable records', async () => {
  const { dir } = recording()
  const run = JSON.stringify(load(dir))
  const writers = Array.from({ length: 8 }, (_, w) => new Promise(ok => {
    const child = spawn('node', ['--input-type=module', '-e',
      `import { bind, record } from ${JSON.stringify(DIAG)}; bind(${JSON.stringify(dir)}, ${run}, { agent: 'writer-${w}' }); for (let n = 0; n < 50; n++) record(${JSON.stringify(dir)}, 'burst', { writer: ${w}, n, pad: 'x'.repeat(900) })`])
    child.on('close', ok)
  }))
  assert.deepEqual(await Promise.all(writers), Array(8).fill(0))
  const read = readEvents(stream(dir))
  const burst = read.events.filter(e => e.kind === 'burst')
  assert.deepEqual([burst.length, read.unreadable], [400, 0])
  for (let w = 0; w < 8; w++) {
    const mine = burst.filter(e => e.agent === `writer-${w}`)
    assert.deepEqual(mine.map(e => e.details.n), Array.from({ length: 50 }, (_, n) => n), `writer ${w}: all there, in its own order`)
    assert.ok(mine.every(e => e.details.writer === w))
  }
  assert.equal(new Set(burst.map(e => e.id)).size, 400)
})

test('work that outlives its run stays in that run\'s record, and export works while active, after end, and after another story started', () => {
  const { dir } = recording()
  const first = load(dir)
  cli(dir, 'start', 'contract')
  const ctx = opStart(dir, 'mutate', 'test_review', { files: ['a.js'] })
  const active = cli(dir, 'diagnostics', 'export')
  assert.equal(active.status, 0, active.stderr)
  assert.match(readFileSync(join(exported(active), 'summary.md'), 'utf8'), /Helper operations with no recorded end: mutate/)
  assert.equal(cli(dir, 'end').status, 0)
  assert.equal(cli(dir, 'init', 'gh-2', '--diagnostics').status, 0)
  // the old helper reports into a checkout where another story is now active
  assert.throws(() => opUpdate(dir, ctx, r => ({ ...r, evidence: { mutants: {} } }), { killed: 3 }), e => e.kind === 'stale')
  const second = load(dir)
  assert.deepEqual(second.evidence, {})
  const old = events(dir, diagDir(dir, 'sc-1', first.id))
  const fresh = events(dir)
  assert.ok(old.some(e => e.kind === 'op.stale' && e.op === ctx.op && /no longer the active run/.test(e.reason)))
  assert.ok(old.every(e => e.run === first.id && e.story === 'sc-1'))
  assert.ok(fresh.every(e => e.run === second.id && e.story === 'gh-2'))
  assert.equal(fresh.some(e => e.op === ctx.op), false, 'nothing of the old helper is in the new run\'s record')
  assert.ok(old.some(e => e.kind === 'run.end'), 'ending did not reset the stream')
  // export of the ended run, by id, from a checkout whose active run is another story
  const later = cli(dir, 'diagnostics', 'export', '--run', first.id)
  assert.equal(later.status, 0, later.stderr)
  const manifest = JSON.parse(readFileSync(join(exported(later), 'manifest.json'), 'utf8'))
  assert.deepEqual([manifest.run, manifest.story], [first.id, 'sc-1'])
  assert.match(manifest.state.from, /sc-1\/run-\d+\.json$/)
  const summary = readFileSync(join(exported(later), 'summary.md'), 'utf8')
  assert.match(summary, /stale completion of mutate .*no longer the active run/)
  assert.match(summary, /Stopped at \*\*contract\*\*/)
  assert.ok(existsSync(join(exported(later), 'artifacts', 'stale', `mutate-${ctx.op}.json`)))
  // and with no active run at all
  assert.equal(cli(dir, 'end').status, 0)
  const afterwards = cli(dir, 'diagnostics', 'export', '--run', first.id)
  assert.equal(afterwards.status, 0, afterwards.stderr)
  assert.equal(readFileSync(join(exported(afterwards), 'summary.md'), 'utf8'), summary, 'the same record gives the same summary')
  assert.match(cli(dir, 'diagnostics', 'export').stderr, /no active run here; name the run/)
  assert.match(cli(dir, 'diagnostics', 'export', '--run', 'nope').stderr, /no diagnostics recorded for run nope/)
})

test('enabled part way: the export says what it does not cover, leaves screenshots out unless asked, and never follows a link out', () => {
  const { dir } = repo()
  cli(dir, 'init', 'sc-1'); cli(dir, 'start', 'contract'); cli(dir, 'put', 'title', 'Thing')
  assert.match(cli(dir, 'diagnostics', 'on').stdout, /diagnostics on for run/)
  assert.equal(cli(dir, 'wait', 'contract', 'human', 'sign-off').status, 0)
  assert.equal(cli(dir, 'diagnostics', 'mark', 'capability', 'human: Copilot review is enabled on the repo').status, 0)
  const run = load(dir)
  const leaked = fake(8)
  mkdirSync(evidenceDir(dir, run), { recursive: true })
  writeFileSync(join(evidenceDir(dir, run), 'step1.png'), PNG)
  writeFileSync(join(dir, '.start-story', 'sc-1', 'report.md'), `posted with token=${leaked}\n`)
  writeFileSync(join(dir, 'outside.txt'), 'not part of the run\n')
  symlinkSync(join(dir, 'outside.txt'), join(dir, '.start-story', 'sc-1', 'link.txt'))
  const out = cli(dir, 'diagnostics', 'export')
  const dest = exported(out)
  const manifest = JSON.parse(readFileSync(join(dest, 'manifest.json'), 'utf8'))
  assert.match(manifest.coverage, /recording was enabled at .*; nothing before that was recorded/)
  const summary = readFileSync(join(dest, 'summary.md'), 'utf8')
  assert.match(summary, /Coverage: recording was enabled at/)
  assert.match(summary, /For the agent analysing this bundle/)
  assert.match(summary, /cite the event ids/)
  assert.equal(events(dir).some(e => e.details?.verb === 'start'), false, 'what happened before is not made up afterwards')
  assert.deepEqual(events(dir).filter(e => e.kind === 'mark.capability').map(e => e.details.text), ['human: Copilot review is enabled on the repo'])
  // artifacts: hashed, contained, redacted on the way out
  assert.deepEqual(manifest.omitted.map(o => [o.path, o.why.split(';')[0]]).sort(), [['evidence/step1.png', 'screenshot'], ['link.txt', 'symbolic link']])
  assert.match(manifest.omitted.find(o => o.path.endsWith('.png')).sha256, /^[0-9a-f]{64}$/)
  assert.equal(existsSync(join(dest, 'artifacts', 'link.txt')), false)
  assert.equal(existsSync(join(dest, 'artifacts', 'evidence', 'step1.png')), false)
  assert.equal(readFileSync(join(dest, 'artifacts', 'report.md'), 'utf8').includes(leaked), false)
  assert.equal(manifest.artifacts.find(a => a.path === 'report.md').redacted, true)
  for (const name of ['manifest.json', 'events.jsonl', 'summary.md', 'state.json']) assert.ok(existsSync(join(dest, name)), name)
  const withShots = exported(cli(dir, 'diagnostics', 'export', '--screenshots', '--out', join(dir, '.start-story', 'bundle')))
  assert.ok(existsSync(join(withShots, 'artifacts', 'evidence', 'step1.png')))
  // off again: what was recorded stays, nothing more is added
  assert.match(cli(dir, 'diagnostics', 'off').stdout, /what was recorded so far is kept/)
  const count = events(dir).length
  cli(dir, 'start', 'contract')
  assert.equal(events(dir).length, count)
  assert.match(cli(dir, 'diagnostics', 'status').stdout, /diagnostics off .* events/)
})

test('the summary separates work from waiting and counts returns, from the record alone', () => {
  const at = s => new Date(Date.UTC(2026, 0, 1, 10, 0, s)).toISOString()
  const move = (s, verb, stage, more = {}) => ({ id: `e${s}`.padEnd(8, '0'), ts: at(s), kind: 'transition', outcome: 'accepted', stage, reason: more.reason ?? null, details: { verb, ...more } })
  const list = [move(0, 'start', 'contract'), move(30, 'wait', 'contract', { to: 'human' }), move(90, 'start', 'contract'), move(100, 'pass', 'contract'),
    move(100, 'start', 'build'), move(400, 'pass', 'build'), move(400, 'start', 'verify'), move(460, 'back', 'verify', { to: 'build', reason: 'step 2 fails on mobile' }),
    move(460, 'start', 'build'), move(500, 'block', 'build', { reason: 'no database' })]
  const { times, open } = stageTimes(list)
  assert.deepEqual(times.contract, { work: 40_000, wait_human: 60_000, wait_copilot: 0, blocked: 0 })
  assert.deepEqual([times.build.work, times.verify.work], [340_000, 60_000])
  assert.deepEqual([open.stage, open.mode], ['build', 'blocked'])
  const manifest = { story: 'sc-1', run: 'r1', coverage: 'recorded from the start of the run', versions: {}, events: { first: at(0), last: at(500), unreadable_lines: 0, truncated_records: 0 }, recording: { off_periods: [], write_failures: [] }, omitted: [] }
  const text = summarize({ events: list, run: null, manifest })
  assert.match(text, /\| contract \| 40s \| 1m 0s \| 0s \| 0s \|/)
  assert.match(text, /back verify → build: step 2 fails on mobile \[e4600000\]/)
  assert.match(text, /No state file for this run was found/)
  assert.equal(summarize({ events: list, run: null, manifest }), text)
})
