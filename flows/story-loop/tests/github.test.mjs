// github.mjs against a fake gh: a script that answers from a rules file and logs every call.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, chmodSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { load, update } from '../skills/story-loop/scripts/loop.mjs'
import { repo, withRun, B } from './helpers.mjs'
import { passProblem, FRESH } from '../skills/story-loop/scripts/loop.mjs'
import { readEvents, diagDir } from '../skills/story-loop/scripts/diag.mjs'
import { ledgerFile, readHandled } from '../skills/story-loop/scripts/ledger.mjs'

const dir = mkdtempSync(join(tmpdir(), 'sl-fakegh-'))
const RULES = join(dir, 'rules.json')
const LOG = join(dir, 'calls.log')
const FAKE = join(dir, 'gh')
writeFileSync(FAKE, `#!/usr/bin/env node
const fs = require('fs')
const args = process.argv.slice(2).join(' ')
fs.appendFileSync(${JSON.stringify(LOG)}, args + '\\n')
const rules = JSON.parse(fs.readFileSync(${JSON.stringify(RULES)}, 'utf8'))
const i = rules.findIndex(r => new RegExp(r.match).test(args) && (r.times ?? 1) > 0)
if (i < 0) { process.stderr.write('fake gh: no rule for ' + args); process.exit(1) }
const rule = rules[i]
if (rule.times !== undefined) { rule.times--; fs.writeFileSync(${JSON.stringify(RULES)}, JSON.stringify(rules)) }
if (rule.sideEffect) fs.writeFileSync(rule.sideEffect.file, rule.sideEffect.text)
process.stdout.write(rule.stdout ?? ''); process.stderr.write(rule.stderr ?? ''); process.exit(rule.code ?? 0)
`)
chmodSync(FAKE, 0o755)
process.env.STORY_LOOP_GH = FAKE
const gh = await import('../skills/story-loop/scripts/github.mjs')
const LOOP = fileURLToPath(new URL('../skills/story-loop/scripts/loop.mjs', import.meta.url))
const GITHUB = fileURLToPath(new URL('../skills/story-loop/scripts/github.mjs', import.meta.url))

const SHA = 'a'.repeat(40)
const PR = (over = {}) => JSON.stringify({ headRefOid: SHA, headRefName: B, baseRefName: 'main', isCrossRepository: false, ...over })
const view = (over, times = 99) => ({ match: 'pr view 7 -R acme/app --json headRefOid', stdout: PR(over), times })
const rules = list => { writeFileSync(RULES, JSON.stringify(list)); writeFileSync(LOG, '') }
const calls = () => readFileSync(LOG, 'utf8').split('\n').filter(Boolean)
const jsonl = rows => rows.map(r => JSON.stringify(r)).join('\n') + '\n'
function published(patch = {}) {
  const { dir: root } = repo()
  withRun(root, { pushed: { state: 'confirmed', sha: SHA }, ...patch })
  return root
}
const requested = (minutesAgo = 0) => ({ copilot: { state: 'requested', head: SHA, requested_at: new Date(Date.now() - minutesAgo * 60_000).toISOString() } })

test('a Copilot review request is recorded and not repeated for the same commit', () => {
  const root = published()
  rules([{ match: 'pr edit 7 -R acme/app --add-reviewer @copilot', times: 1 }])
  assert.match(gh.copilotRequest(root), /requested/)
  assert.equal(load(root).copilot.head, SHA)
  assert.match(gh.copilotRequest(root), /already requested/)
  assert.equal(calls().length, 1)
})

test('waiting finds the Copilot review of exactly the published commit, across pages', async () => {
  const root = published(requested())
  const humans = Array.from({ length: 40 }, (_, i) => ({ id: i, user: 'someone', commit_id: SHA, state: 'COMMENTED', submitted_at: 'x' }))
  rules([{ match: 'api --paginate .*pulls/7/reviews', stdout: jsonl([...humans,
    { id: 98, user: 'copilot-pull-request-reviewer[bot]', commit_id: 'b'.repeat(40), state: 'COMMENTED', submitted_at: 'x' },
    { id: 99, user: 'copilot-pull-request-reviewer[bot]', commit_id: SHA, state: 'COMMENTED', submitted_at: 'y' }]) }])
  const review = await gh.copilotWait(root, { minutes: 1, interval: 0.01 })
  assert.equal(review.id, 99)
  assert.deepEqual(load(root).copilot.review, { id: 99, commit: SHA, submitted_at: 'y' })
})

test('a stale review or none at all ends in a timeout, not a pass', async () => {
  const root = published(requested())
  rules([{ match: 'reviews', stdout: jsonl([{ id: 1, user: 'Copilot', commit_id: 'b'.repeat(40), state: 'COMMENTED', submitted_at: 'x' }]), times: 99 }])
  await assert.rejects(gh.copilotWait(root, { minutes: 0.002, interval: 0.05 }), e => e.kind === 'timeout')
  assert.equal(load(root).copilot.state, 'timeout')
})

test('a failing gh with empty output, malformed JSON or an auth error is an error, never a review', async () => {
  let root = published(requested())
  rules([{ match: 'reviews', stdout: '', stderr: 'something broke', code: 1 }])
  await assert.rejects(gh.copilotWait(root, { minutes: 1, interval: 0.01 }), /something broke/)
  root = published(requested())
  rules([{ match: 'reviews', stdout: '<html>oops</html>\n' }])
  await assert.rejects(gh.copilotWait(root, { minutes: 1, interval: 0.01 }), /not JSON/)
  root = published(requested())
  rules([{ match: 'reviews', stderr: 'HTTP 401: Bad credentials', code: 1 }])
  await assert.rejects(gh.copilotWait(root, { minutes: 1, interval: 0.01 }), e => e.kind === 'auth')
  assert.equal(load(root).copilot.state, 'failed')
})

test('rate limits and server errors are retried until the review arrives', async () => {
  const root = published(requested())
  rules([
    { match: 'reviews', stderr: 'API rate limit exceeded', code: 1, times: 1 },
    { match: 'reviews', stderr: 'HTTP 502: Bad Gateway', code: 1, times: 1 },
    { match: 'reviews', stdout: jsonl([{ id: 5, user: 'Copilot', commit_id: SHA, state: 'COMMENTED', submitted_at: 'z' }]) },
  ])
  assert.equal((await gh.copilotWait(root, { minutes: 1, interval: 0.01 })).id, 5)
})

test('after a timeout Copilot can be asked again', () => {
  const root = published({ copilot: { state: 'timeout', head: SHA, requested_at: '2020-01-01T00:00:00Z' } })
  rules([{ match: 'pr edit 7 -R acme/app --add-reviewer @copilot', times: 1 }])
  assert.match(gh.copilotRequest(root), /^requested/)
  assert.equal(load(root).copilot.state, 'requested')
})

test('a head that moved after the request is refused until requested again', async () => {
  const root = published(requested())
  update(root, r => ({ ...r, pushed: { state: 'confirmed', sha: 'c'.repeat(40) } }))
  await assert.rejects(gh.copilotWait(root, { minutes: 1, interval: 0.01 }), /request again/)
})

test('comments are the review\'s own top-level threads across pages; replies and other reviews are not findings', () => {
  const root = published({ copilot: { review: { id: 99, commit: SHA } } })
  const many = Array.from({ length: 35 }, (_, i) => ({ id: i, review: 99, reply_to: null, user: 'Copilot', body: `c${i}` }))
  rules([{ match: 'pulls/7/comments', stdout: jsonl([...many, { id: 100, review: 99, reply_to: 3, body: 'agent reply' }, { id: 101, review: 12, reply_to: null, body: 'human' }]) }])
  const list = gh.comments(root)
  assert.equal(list.length, 35)
  assert.ok(list.every(c => c.review === 99 && !c.reply_to))
  // H12: the fetched set is recorded; it is what fix_comments has to account for
  assert.deepEqual(load(root).copilot.comments.ids, many.map(c => c.id))
  assert.equal(load(root).copilot.comments.review, 99)
})

test('required CI is evaluated on the PR head: pending and failing are not passing', () => {
  const root = published()
  const head = view()
  const protection = names => ({ match: 'protection/required_status_checks', stdout: jsonl(names.map(name => ({ name }))), times: 9 })
  const noRules = { match: 'rules/branches', stdout: '', times: 9 }
  rules([head, protection(['rspec']), noRules, { match: 'pr checks', stdout: JSON.stringify([{ name: 'rspec', bucket: 'pending' }]), code: 8 }])
  assert.equal(gh.ci(root).state, 'pending')
  rules([head, protection(['rspec']), noRules, { match: 'pr checks', stdout: JSON.stringify([{ name: 'rspec', bucket: 'fail' }, { name: 'lint', bucket: 'pass' }]), code: 1 }])
  assert.equal(gh.ci(root).state, 'fail')
  rules([head, protection(['rspec']), noRules, { match: 'pr checks', stdout: JSON.stringify([{ name: 'rspec', bucket: 'pass' }, { name: 'docs', bucket: 'skipping' }]) }])
  assert.deepEqual([gh.ci(root).state, load(root).ci.sha], ['pass', SHA])
  // right after a push GitHub has created no check runs yet: required ones are missing, not absent
  rules([head, protection(['rspec']), { match: 'rules/branches', stdout: jsonl([{ name: 'lint' }]), times: 9 }, { match: 'pr checks', stdout: JSON.stringify([{ name: 'rspec', bucket: 'pass' }]) }])
  assert.deepEqual([gh.ci(root).state, load(root).ci.missing], ['pending', ['lint']])
  rules([head, protection(['rspec']), noRules, { match: 'pr checks', stderr: 'no checks reported on the \'x\' branch', code: 1 }])
  assert.equal(gh.ci(root).state, 'pending')
  rules([head, { match: 'protection', stderr: 'HTTP 404: Branch not protected', code: 1, times: 9 }, noRules, { match: 'pr checks', stderr: 'no required checks reported on the \'x\' branch', code: 1 }])
  assert.equal(gh.ci(root).state, 'none')
  rules([head, { match: 'protection', stderr: 'HTTP 403: Must have admin rights', code: 1, times: 9 }, noRules, { match: 'pr checks', stderr: 'no required checks reported', code: 1 }])
  assert.equal(gh.ci(root).state, 'unknown')
  rules([head, protection([]), noRules, { match: 'pr checks', stdout: '', stderr: 'boom', code: 1 }])
  assert.throws(() => gh.ci(root), /no readable result/)
})

test('the report is one comment: a retry edits it, and a lost answer is reconciled instead of posting twice', () => {
  const root = published()
  const body = join(root, 'body.md'); writeFileSync(body, 'all good')
  const state = join(dir, 'posted')
  // first attempt: the comment lands but gh reports a network error
  rules([
    view(),
    { match: '^api user', stdout: 'story-bot\n', times: 9 },
    { match: 'issues/7/comments', stdout: jsonl([{ id: 1, user: 'a-human', body: 'quoting: <!-- story-loop-report -->' }]), times: 1 },
    { match: 'pr comment 7', stderr: 'ECONNRESET', code: 1, times: 1 },
    { match: 'issues/7/comments', stdout: jsonl([{ id: 1, user: 'a-human', body: 'quoting: <!-- story-loop-report -->' }, { id: 555, user: 'story-bot', body: '<!-- story-loop-report -->\nall good' }]), times: 9 },
    { match: 'PATCH .*issues/comments/555', stdout: '{}', times: 9 },
  ])
  assert.equal(gh.report(root, body), 555)
  assert.deepEqual(load(root).report, { state: 'confirmed', sha: SHA, comment_id: 555, repo: 'acme/app', pr: 7 })
  assert.equal(gh.report(root, body), 555)
  assert.equal(calls().filter(c => c.startsWith('pr comment')).length, 1)
  assert.equal(calls().filter(c => c.includes('PATCH')).length, 1)
  assert.equal(existsSync(state), false)
  assert.throws(() => gh.report(root, body, ['shot.png']), /cannot carry attachments/)
})

test('H04: every gh call names the run\'s repository; a run without one is refused', async () => {
  const root = published({ ...requested(), copilot: { ...requested().copilot, review: { id: 99, commit: SHA } } })
  const body = join(root, 'body.md'); writeFileSync(body, 'x')
  rules([view(), { match: 'pr edit', times: 9 }, { match: 'reviews', stdout: jsonl([{ id: 99, user: 'Copilot', commit_id: SHA, state: 'COMMENTED', submitted_at: 'y' }]), times: 9 },
    { match: 'pulls/7/comments', stdout: '', times: 9 }, { match: 'protection', stdout: '', times: 9 }, { match: 'rules/branches', stdout: '', times: 9 },
    { match: 'pr checks', stdout: JSON.stringify([{ name: 'rspec', bucket: 'pass' }]), times: 9 }, { match: '^api user', stdout: 'bot\n', times: 9 },
    { match: 'issues/7/comments', stdout: jsonl([{ id: 5, user: 'bot', body: '<!-- story-loop-report -->' }]), times: 9 }, { match: 'PATCH', stdout: '{}', times: 9 }])
  update(root, r => ({ ...r, copilot: { ...r.copilot, state: 'timeout' } })); gh.copilotRequest(root)
  await gh.copilotWait(root, { minutes: 1, interval: 0.01 }); gh.comments(root); gh.ci(root); gh.report(root, body)
  const all = calls().filter(c => /^(pr|api) /.test(c)) // a comment body spans lines in the log
  assert.ok(all.length >= 9)
  for (const call of all) {
    assert.doesNotMatch(call, /\{owner\}|\{repo\}/, call)
    if (call.startsWith('pr ')) assert.match(call, / -R acme\/app /, call)
    else if (!call.startsWith('api user')) assert.match(call, /repos\/acme\/app\//, call)
  }
  const bare = published({ repo: null })
  rules([])
  assert.throws(() => gh.copilotRequest(bare), /no GitHub repository recorded/)
  assert.equal(calls().length, 0)
})

test('H10: an unreadable required-check policy is unknown, never a pass on the visible checks', () => {
  const root = published()
  const green = { match: 'pr checks', stdout: JSON.stringify([{ name: 'rspec', bucket: 'pass' }]), times: 9 }
  const noRules = { match: 'rules/branches', stdout: '', times: 9 }
  const forbidden = { match: 'protection', stderr: 'HTTP 403: Must have admin rights', code: 1, times: 9 } // the branch fallback too: its --jq names .protection
  rules([view(), forbidden, noRules, green])
  assert.equal(gh.ci(root).state, 'unknown')
  assert.equal(load(root).ci.required, null)
  assert.match(passProblem(root, { ...load(root), stages: load(root).stages }, 'report') ?? '', /./)
  // the rulesets endpoint unreadable is just as unknown
  rules([view(), { match: 'protection', stdout: '', times: 9 }, { match: 'rules/branches', stderr: 'HTTP 403', code: 1, times: 9 }, green])
  assert.equal(gh.ci(root).state, 'unknown')
  // the branch itself lists the classic contexts to anyone who can read it
  rules([view(), { match: 'protection/required_status_checks', stderr: 'HTTP 403: Must have admin rights', code: 1, times: 9 },
    { match: 'branches/main --jq', stdout: jsonl([{ name: 'rspec' }, { name: 'lint' }]), times: 9 }, noRules, green])
  assert.deepEqual([gh.ci(root).state, load(root).ci.missing], ['pending', ['lint']])
  // or the human approves the list, for this repository and this base
  assert.equal(spawnSync('node', [LOOP, 'put', 'required_checks', '["rspec"]'], { cwd: root }).status, 0)
  assert.deepEqual([load(root).required_checks_for.repo, load(root).required_checks_for.base], ['acme/app', 'main'])
  rules([view(), forbidden, noRules, green])
  assert.equal(gh.ci(root).state, 'pass')
  assert.equal(load(root).ci.policy.manual.names[0], 'rspec')
})

// ---- regressions from the 0.8.0 review -------------------------------------------
const notFound = match => ({ match, stderr: 'gh: Not Found (HTTP 404)', code: 1, times: 9 })
const noChecksYet = { match: 'pr checks', stderr: 'no checks reported on the \'x\' branch', code: 1, times: 9 }
const put = (root, ...args) => spawnSync('node', [LOOP, 'put', ...args], { cwd: root, encoding: 'utf8' })

test('R1: a 404 on the policy is unknown, never "nothing required"; the human\'s list stands, and a base with a slash is one path segment', () => {
  const root = published({ base: 'release/1.0' })
  const head = view({ baseRefName: 'release/1.0' })
  assert.equal(put(root, 'required_checks', '["lint"]').status, 0)
  // the reviewed reproduction: no checks exist yet, both policy endpoints answer 404
  rules([head, notFound('protection'), notFound('rules/branches'), noChecksYet])
  const first = gh.ci(root)
  assert.deepEqual([first.state, first.required, first.missing], ['pending', ['lint'], ['lint']])
  assert.equal(load(root).ci.policy.state, 'unknown')
  assert.match(load(root).ci.policy.why, /could not read branch protection \(HTTP 404\) and the branch itself \(HTTP 404\) and rulesets \(HTTP 404\)/)
  assert.match(passProblem(root, load(root), 'report') ?? '', /./)
  const paths = calls().filter(c => c.startsWith('api'))
  assert.ok(paths.length >= 3)
  for (const call of paths) assert.match(call, /branches\/release%2F1\.0(\/| |$)/, call)
  // the same 404s with no list from the human: unknown, with no checks started and with green ones
  const bare = published({ base: 'release/1.0' })
  rules([head, notFound('protection'), notFound('rules/branches'), noChecksYet])
  assert.deepEqual([gh.ci(bare).state, load(bare).ci.required], ['unknown', null])
  rules([head, notFound('protection'), notFound('rules/branches'), { match: 'pr checks', stdout: JSON.stringify([{ name: 'rspec', bucket: 'pass' }]), times: 9 }])
  assert.equal(gh.ci(bare).state, 'unknown')
})

test('R1: requirements are empty only when GitHub says so; a named check is missing, pending, failing or passing as it is', () => {
  const root = published()
  const unprotected = { match: 'protection', stderr: 'gh: Branch not protected (HTTP 404)', code: 1, times: 9 }
  const noRules = { match: 'rules/branches', stdout: '', times: 9 }
  // affirmatively empty: GitHub's own "not protected", and a readable ruleset list with nothing in it
  rules([view(), unprotected, noRules, { match: 'pr checks', stderr: 'no required checks reported', code: 1, times: 9 }])
  assert.deepEqual([gh.ci(root).state, load(root).ci.required, load(root).ci.policy.state], ['none', [], 'empty'])
  assert.match(load(root).ci.policy.sources.join(), /not protected.*rulesets/)
  // the human names a check GitHub does not label required: it is looked up among all checks
  assert.equal(put(root, 'required_checks', '["lint"]').status, 0)
  const checks = list => ({ match: 'pr checks 7 -R acme/app --json', stdout: JSON.stringify(list), code: list.some(c => c.bucket !== 'pass') ? 1 : 0, times: 9 })
  const labelled = { match: 'pr checks 7 -R acme/app --required', stderr: 'no required checks reported', code: 1, times: 9 }
  for (const [list, state, missing] of [
    [[{ name: 'docs', bucket: 'pass' }], 'pending', ['lint']], // not created yet
    [[{ name: 'lint', bucket: 'pending' }], 'pending', []],
    [[{ name: 'lint', bucket: 'fail' }], 'fail', []],
    [[{ name: 'lint', bucket: 'pass' }, { name: 'docs', bucket: 'fail' }], 'pass', []], // docs is nobody's requirement
  ]) {
    rules([view(), unprotected, noRules, labelled, checks(list)])
    const result = gh.ci(root)
    assert.deepEqual([result.state, result.missing], [state, missing], JSON.stringify(list))
    assert.ok(calls().some(c => /^pr checks 7 -R acme\/app --json/.test(c)), 'the unlabelled check was looked up among all checks')
  }
  // the policy and the human's list add up: neither replaces the other
  rules([view(), { match: 'protection', stdout: jsonl([{ name: 'rspec' }]), times: 9 }, noRules, labelled, checks([{ name: 'rspec', bucket: 'pass' }, { name: 'lint', bucket: 'pass' }])])
  assert.deepEqual([gh.ci(root).state, load(root).ci.required], ['pass', ['rspec', 'lint']])
})

test('R1: a list approved for one base says nothing about another', () => {
  const root = published()
  assert.match(put(published({ repo: null }), 'required_checks', '["lint"]').stderr, /record the repository and the base branch first/)
  assert.match(put(root, 'required_checks', '"lint"').stderr, /JSON list of check names/)
  assert.equal(put(root, 'required_checks', '["lint"]').status, 0)
  update(root, r => ({ ...r, ci: { sha: SHA, state: 'pass', required: ['lint'] } }))
  const moved = put(root, 'base', 'release')
  assert.match(moved.stdout, /approved for the old base; they are dropped/)
  assert.deepEqual([load(root).required_checks, load(root).required_checks_for, load(root).ci], [undefined, undefined, undefined])
  // a list written by hand for another base is not used either
  update(root, r => ({ ...r, required_checks: ['lint'], required_checks_for: { repo: 'acme/app', base: 'main' } }))
  rules([view({ baseRefName: 'release' }), notFound('protection'), notFound('rules/branches'), { match: 'pr checks', stdout: JSON.stringify([{ name: 'lint', bucket: 'pass' }]), times: 9 }])
  assert.deepEqual([gh.ci(root).state, load(root).ci.policy.manual], ['unknown', null])
})

test('R2: a Copilot wait that outlives its run changes nothing in the run that replaced it', async () => {
  for (const [ending, rule] of [
    ['review', { match: 'reviews', stdout: jsonl([{ id: 99, user: 'Copilot', commit_id: SHA, state: 'COMMENTED', submitted_at: 'y' }]), times: 9 }],
    ['error', { match: 'reviews', stderr: 'HTTP 401: Bad credentials', code: 1, times: 9 }],
    ['timeout', { match: 'reviews', stdout: '', times: 99 }],
  ]) {
    const root = published(requested())
    const first = load(root)
    // nothing to see at the first poll; the run is ended and another story started while the wait sleeps
    rules([{ match: 'reviews', stdout: '', times: 1 }, rule])
    const waiting = gh.copilotWait(root, { minutes: ending === 'timeout' ? 0.03 : 1, interval: 1 })
    assert.equal(Object.values(load(root).ops)[0].kind, 'copilot-wait', 'the wait is listed in the run while it is out')
    assert.equal(spawnSync('node', [LOOP, 'end'], { cwd: root }).status, 0)
    assert.equal(spawnSync('node', [LOOP, 'init', 'gh-2'], { cwd: root }).status, 0)
    await assert.rejects(waiting, e => e.kind === 'stale' && /is no longer the active run/.test(e.message), ending)
    const now = load(root)
    assert.deepEqual([now.story, now.copilot, now.ops], ['gh-2', undefined, undefined], `${ending}: the new run is untouched`)
    const kept = readdirSync(join(root, '.start-story', 'sc-1', 'stale')).map(f => JSON.parse(readFileSync(join(root, '.start-story', 'sc-1', 'stale', f), 'utf8')))
    assert.equal(kept.length, 1)
    assert.deepEqual([kept[0].context.run, kept[0].context.story, kept[0].context.kind], [first.id, 'sc-1', 'copilot-wait'], 'kept under its own identity')
    assert.ok(kept[0].result[ending === 'review' ? 'review' : ending], `the ${ending} itself is kept`)
  }
})

test('R2: a wait from an earlier attempt, or for a request that was replaced, is not this attempt\'s review', async () => {
  const review = { match: 'reviews', stdout: jsonl([{ id: 99, user: 'Copilot', commit_id: SHA, state: 'COMMENTED', submitted_at: 'y' }]), times: 9 }
  // back to build while the wait is out: the same run, a newer attempt
  let root = published(requested())
  rules([{ match: 'reviews', stdout: '', times: 1 }, review])
  let waiting = gh.copilotWait(root, { minutes: 1, interval: 1 })
  update(root, r => { r.stages.copilot_review.attempt = 2; return r })
  await assert.rejects(waiting, /copilot_review is on attempt 2; this copilot-wait started in attempt 1/)
  assert.equal(load(root).copilot.review, undefined)
  // Copilot was asked again for the same commit: the old wait's answer is not the new request's
  root = published(requested())
  rules([{ match: 'reviews', stdout: '', times: 1 }, review])
  waiting = gh.copilotWait(root, { minutes: 1, interval: 1 })
  update(root, r => ({ ...r, copilot: { ...r.copilot, requested_at: new Date().toISOString() } }))
  await assert.rejects(waiting, /is no longer the run's request/)
  assert.equal(load(root).copilot.state, 'requested')
  // a takeover is not a new attempt: the wait the old owner started still counts, and is flagged
  root = published(requested())
  rules([{ match: 'reviews', stdout: '', times: 1 }, review])
  waiting = gh.copilotWait(root, { minutes: 1, interval: 1 })
  update(root, r => ({ ...r, owner: { session: 's2', since: 'x', heartbeat: Date.now(), generation: 1 } }))
  assert.equal((await waiting).id, 99)
  assert.deepEqual([load(root).copilot.state, load(root).ops], ['reviewed', {}])
})

test('R9: polling options must be positive numbers, and Copilot is the bot, not any login with "copilot" in it', async () => {
  const root = published(requested())
  rules([])
  for (const bad of [{ minutes: NaN }, { minutes: 0 }, { minutes: -5 }, { interval: NaN }, { interval: 0 }, { minutes: Infinity }])
    await assert.rejects(gh.copilotWait(root, { minutes: 1, interval: 0.01, ...bad }), /needs a positive number/, JSON.stringify(bad))
  assert.equal(calls().length, 0, 'nothing was polled')
  const cli = spawnSync('node', [GITHUB, 'copilot-wait', '--minutes', 'soon'], { cwd: root, encoding: 'utf8' })
  assert.equal(cli.status, 1)
  assert.match(cli.stderr, /--minutes needs a positive number/)
  for (const [login, type, yes] of [['Copilot', 'Bot', true], ['copilot-pull-request-reviewer[bot]', 'Bot', true], ['copilot-pull-request-reviewer', undefined, true],
    ['copilot-fan', 'User', false], ['not-copilot', undefined, false], ['Copilot', 'User', false], ['my-copilot-bot[bot]', 'Bot', false]])
    assert.equal(gh.isCopilot(login, type), yes, `${login} (${type})`)
  const human = { id: 1, user: 'copilot-fan', type: 'User', commit_id: SHA, state: 'COMMENTED', submitted_at: 'x' }
  assert.equal(gh.findReview([human], SHA), null)
  assert.equal(gh.findReview([human, { ...human, id: 2, user: 'Copilot', type: 'Bot' }], SHA).id, 2)
})

test('R9: a PR a human closed, merged or marked ready is written down and said, never undone', () => {
  const root = published()
  const policy = [{ match: 'protection', stdout: jsonl([{ name: 'rspec' }]), times: 9 }, { match: 'rules/branches', stdout: '', times: 9 }, { match: 'pr checks', stdout: JSON.stringify([{ name: 'rspec', bucket: 'pass' }]), times: 9 }]
  rules([view({ state: 'OPEN', isDraft: true }), ...policy])
  assert.equal(gh.ci(root).state, 'pass')
  assert.deepEqual([load(root).pr_state.state, load(root).pr_state.draft], ['OPEN', true])
  rules([view({ state: 'OPEN', isDraft: false }), ...policy])
  assert.equal(gh.ci(root).state, 'pass', 'the step still does its work')
  assert.deepEqual([load(root).pr_state.draft, load(root).pr_state.previous.draft], [false, true])
  assert.match(readFileSync(join(root, '.start-story', 'events.jsonl'), 'utf8'), /marked ready for review by a human.*leaves it as it is/)
  rules([view({ state: 'MERGED', isDraft: false }), ...policy])
  gh.ci(root)
  assert.equal(load(root).pr_state.state, 'MERGED')
  assert.equal(calls().filter(c => /pr (ready|edit|reopen|close)|--draft/.test(c)).length, 0, 'nothing tried to change it back')
})

test('R10: with diagnostics on, each GitHub step leaves what it asked, what came back and where the requirement set came from, without bodies', () => {
  const root = published({ diagnostics: { enabled: true } })
  const body = join(root, 'body.md'); writeFileSync(body, 'the whole report text, which is not for the record')
  rules([view(), { match: 'protection', stderr: 'HTTP 403: Must have admin rights', code: 1, times: 9 }, { match: 'rules/branches', stdout: '', times: 9 },
    { match: 'pr checks', stdout: JSON.stringify([{ name: 'rspec', bucket: 'pending' }]), code: 8, times: 9 },
    { match: '^api user', stdout: 'bot\n', times: 9 }, { match: 'issues/7/comments', stdout: jsonl([{ id: 5, user: 'bot', body: '<!-- story-loop-report -->' }]), times: 9 }, { match: 'PATCH', stdout: '{}', times: 9 }])
  assert.equal(put(root, 'required_checks', '["rspec","lint"]').status, 0)
  assert.equal(gh.ci(root).state, 'pending')
  assert.equal(gh.report(root, body), 5)
  const run = load(root)
  const { events } = readEvents(diagDir(root, run.story, run.id))
  const ci = events.find(e => e.kind === 'ci')
  assert.deepEqual([ci.outcome, ci.details.expected, ci.details.observed, ci.details.missing, ci.commit, ci.stage], ['pending', ['rspec', 'lint'], ['rspec:pending'], ['lint'], SHA, 'report'])
  assert.deepEqual([ci.details.policy.state, ci.details.policy.manual.names, ci.details.policy.manual.base], ['unknown', ['rspec', 'lint'], 'main'])
  assert.match(ci.details.policy.why, /branch protection \(HTTP 403\)/)
  const calls = events.filter(e => e.kind === 'gh')
  assert.ok(calls.length >= 6)
  assert.ok(calls.every(e => Number.isFinite(e.elapsed_ms) && e.op), 'each call is timed and tied to its step')
  assert.deepEqual(calls.find(e => e.outcome === 'forbidden').details.args.slice(0, 2), ['api', 'repos/acme/app/branches/main/protection/required_status_checks'])
  const posted = events.find(e => e.kind === 'report')
  assert.deepEqual([posted.outcome, posted.details.comment_id], ['edited', 5])
  assert.match(posted.details.body_sha256, /^[0-9a-f]{64}$/)
  const raw = readFileSync(join(diagDir(root, run.story, run.id), 'events.jsonl'), 'utf8')
  assert.doesNotMatch(raw, /the whole report text|select\(\.type/, 'no comment body and no filter expression in the record')
})

test('H11: checks of a head that moved, or of another base or branch, are never recorded for the published commit', () => {
  const other = 'b'.repeat(40)
  const green = { match: 'pr checks', stdout: JSON.stringify([{ name: 'rspec', bucket: 'pass' }]), times: 9 }
  const policy = [{ match: 'protection', stdout: jsonl([{ name: 'rspec' }]), times: 9 }, { match: 'rules/branches', stdout: '', times: 9 }]
  // a collaborator pushes between reading the head and reading the checks
  let root = published()
  rules([view({}, 1), view({ headRefOid: other }), ...policy, green])
  assert.throws(() => gh.ci(root), /someone else pushed/)
  assert.deepEqual([load(root).ci.state, load(root).ci.sha], ['head_moved', other])
  // the PR head is not what this run published at all
  root = published()
  rules([view({ headRefOid: other }), ...policy, green])
  assert.throws(() => gh.ci(root), /someone else pushed/)
  assert.equal(load(root).ci.state, 'head_moved')
  // the base changed: the stored base's requirements are not used
  rules([view({ baseRefName: 'release' }), ...policy, green])
  assert.throws(() => gh.ci(root), /now targets "release", not "main"/)
  rules([view({ headRefName: 'someone-elses' }), ...policy, green])
  assert.throws(() => gh.ci(root), /not the story branch/)
  rules([view({ isCrossRepository: true }), ...policy, green])
  assert.throws(() => gh.ci(root), /fork/)
  // and no report is posted for a head that moved after CI was collected
  const body = join(root, 'body.md'); writeFileSync(body, 'x')
  rules([view({ headRefOid: other }), { match: '^api user', stdout: 'bot\n', times: 9 }])
  assert.throws(() => gh.report(root, body), /The report is not posted/)
  assert.equal(calls().filter(c => /pr comment|PATCH/.test(c)).length, 0)
  assert.equal(load(root).report, undefined)
})

test('H14: a report that could not be posted stays "attempted" and does not pass the report gate', () => {
  const { dir: root, git } = repo()
  const head = git('rev-parse', 'HEAD')
  withRun(root, { pushed: { state: 'confirmed', sha: head }, ci: { sha: head, state: 'pass', required: [] } })
  update(root, r => { for (const s of Object.values(r.stages)) s.status = 'passed'; r.stages.copilot_review.status = 'skipped'; r.stages.report.status = 'running'; return r })
  for (const id of FRESH) update(root, r => { r.stages[id].tree = git('rev-parse', 'HEAD^{tree}'); return r })
  const body = join(root, 'body.md'); writeFileSync(body, 'x')
  rules([view({ headRefOid: head }), { match: '^api user', stdout: 'bot\n', times: 9 }, { match: 'issues/7/comments', stdout: '', times: 9 },
    { match: 'pr comment 7', stderr: 'HTTP 403: Resource not accessible', code: 1, times: 9 }])
  assert.throws(() => gh.report(root, body), /HTTP 403/)
  assert.equal(load(root).report.state, 'attempted')
  assert.match(passProblem(root, load(root), 'report'), /was attempted, not confirmed/)
  update(root, r => ({ ...r, report: { state: 'confirmed', sha: head } })) // confirmed, yet no comment to point at
  assert.match(passProblem(root, load(root), 'report'), /not posted/)
  update(root, r => ({ ...r, report: { state: 'confirmed', sha: head, comment_id: 9 } }))
  assert.match(passProblem(root, load(root), 'report'), /no walkthrough for HEAD/)
  update(root, r => ({ ...r, walkthrough: { tree: git('rev-parse', 'HEAD^{tree}'), commit: head } }))
  assert.equal(passProblem(root, load(root), 'report'), null)
})

test('ready: the PR leaves draft once, at the published commit, and is not reported as a human\'s doing', () => {
  assert.throws(() => gh.ready(published({ pushed: null })), /publish first/)

  const root = published()
  rules([view({ headRefOid: 'b'.repeat(40) })])
  assert.throws(() => gh.ready(root), /not the published aaaaaaa; publish again/)
  assert.equal(calls().filter(c => /pr ready/.test(c)).length, 0)

  rules([view(), { match: 'pr view 7 -R acme/app --json state,isDraft', stdout: JSON.stringify({ state: 'OPEN', isDraft: true }), times: 1 },
    { match: '^pr ready 7 -R acme/app$', stdout: '', times: 1 }])
  assert.match(gh.ready(root), /marked ready at aaaaaaa/)
  assert.deepEqual([load(root).ready.sha, load(root).ready.by, load(root).pr_state.draft], [SHA, 'story-loop', false])
  assert.match(gh.ready(root), /already marked ready/)
  assert.equal(calls().filter(c => /pr ready/.test(c)).length, 1, 'once per commit')

  // A human marked it ready first: left as it is, nothing sent.
  const human = published()
  rules([view(), { match: 'json state,isDraft', stdout: JSON.stringify({ state: 'OPEN', isDraft: false }) }])
  assert.match(gh.ready(human), /already ready/)
  assert.equal(calls().filter(c => /pr ready/.test(c)).length, 0)

  const closed = published()
  rules([view(), { match: 'json state,isDraft', stdout: JSON.stringify({ state: 'CLOSED', isDraft: true }) }])
  assert.throws(() => gh.ready(closed), /is closed; nothing to mark ready/)
})

test('replies: a bad map posts nothing; a fix must be pushed; only fixed threads resolve; a retry never posts twice', () => {
  const { dir: root, commit } = repo()
  const fix = commit('b.txt', 'fixed')
  const later = commit('c.txt', 'not pushed')
  withRun(root, { pushed: { state: 'confirmed', sha: fix } })
  const map = m => { const f = join(root, 'replies.json'); writeFileSync(f, JSON.stringify(m)); return f }
  rules([])
  assert.throws(() => gh.reply(root, map({ 11: { disposition: 'maybe', message: 'x' } })), /disposition must be one of/)
  assert.throws(() => gh.reply(root, map({ 11: { disposition: 'rejected', message: ' ' } })), /say what was done/)
  assert.throws(() => gh.reply(root, map({ 11: { disposition: 'fixed', message: 'done', commit: later } })), /not in the published head/)
  assert.throws(() => gh.reply(root, map({ abc: { disposition: 'rejected', message: 'no' } })), /not a review comment id/)
  assert.equal(calls().length, 0, 'nothing reaches GitHub before the whole map is valid')

  const threads = JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: [
    { id: 'T11', isResolved: false, comments: { nodes: [{ databaseId: 11 }] } },
    { id: 'T12', isResolved: false, comments: { nodes: [{ databaseId: 12 }] } }] } } } } })
  const answers = { 11: { disposition: 'fixed', message: 'Guarded the empty shelf.', commit: fix }, 12: { disposition: 'rejected', message: 'Kept: the spec asks for it.' }, 'review-5': { disposition: 'deferred', message: 'Parked for a follow-up story.' } }
  rules([{ match: '^api user', stdout: 'story-bot\n', times: 9 },
    { match: 'api --paginate repos/acme/app/pulls/7/comments', stdout: jsonl([{ user: 'ada', body: 'quoting <!-- story-loop-reply 11 -->' }]), times: 1 },
    { match: 'api --paginate repos/acme/app/issues/7/comments', stdout: '', times: 1 },
    { match: 'POST repos/acme/app/pulls/7/comments/(11|12)/replies', stdout: '{}', times: 2 },
    { match: 'POST repos/acme/app/issues/7/comments', stdout: '{}', times: 1 },
    { match: 'graphql .*query=query', stdout: threads, times: 9 },
    { match: 'graphql -F id=T11', stdout: '{}', times: 1 }])
  const done = gh.reply(root, map(answers))
  assert.deepEqual(Object.keys(done).sort(), ['11', '12', 'review-5'])
  assert.equal(calls().filter(c => /POST/.test(c)).length, 3, 'a human quoting the marker is not our reply')
  assert.deepEqual(calls().filter(c => /resolveReviewThread/.test(c)).length, 1, 'only the fixed thread is resolved')
  assert.equal(load(root).replies[12].disposition, 'rejected')

  // The retry sees our own markers and posts nothing new.
  rules([{ match: '^api user', stdout: 'story-bot\n', times: 9 },
    { match: 'api --paginate repos/acme/app/pulls/7/comments', stdout: jsonl([{ user: 'story-bot', body: 'x <!-- story-loop-reply 11 -->' }, { user: 'story-bot', body: 'y <!-- story-loop-reply 12 -->' }]), times: 1 },
    { match: 'api --paginate repos/acme/app/issues/7/comments', stdout: jsonl([{ user: 'story-bot', body: 'z <!-- story-loop-reply review-5 -->' }]), times: 1 },
    { match: 'graphql .*query=query', stdout: threads.replace('"isResolved":false', '"isResolved":true'), times: 9 }])
  gh.reply(root, map(answers))
  assert.equal(calls().filter(c => /POST|resolveReviewThread/.test(c)).length, 0)
})

test('human review: what counts are the humans\' top-level threads and review bodies, with the PR state read in the same call', () => {
  const root = published()
  rules([{ match: 'pr view 7 -R acme/app --json state,isDraft', stdout: JSON.stringify({ state: 'MERGED', isDraft: false }) },
    { match: 'api --paginate repos/acme/app/pulls/7/comments', stdout: jsonl([
      { id: 11, reply_to: null, user: 'ada', type: 'User', path: 'a.rb', line: 3, body: 'what about a shelf with no flows?' },
      { id: 12, reply_to: 11, user: 'ada', type: 'User', body: 'a reply is conversation' },
      { id: 13, reply_to: null, user: 'copilot-pull-request-reviewer[bot]', type: 'Bot', body: 'a bot is not a human reviewer' }]) },
    { match: 'api --paginate repos/acme/app/pulls/7/reviews', stdout: jsonl([
      { id: 5, user: 'ada', type: 'User', state: 'CHANGES_REQUESTED', body: 'see the comments' },
      { id: 6, user: 'ada', type: 'User', state: 'APPROVED', body: '' },
      { id: 7, user: 'ada', type: 'User', state: 'PENDING', body: 'not submitted yet' }]) }])
  const { state, list } = gh.humanComments(root)
  assert.deepEqual([state, list.map(c => c.id)], ['MERGED', ['11', 'review-5']])
  const run = load(root)
  assert.deepEqual([run.human_review.comments.ids, run.human_review.comments.pr_state, run.pr_state.state], [['11', 'review-5'], 'MERGED', 'MERGED'])
  assert.ok(calls().every(c => /acme\/app/.test(c)), 'every call names the run\'s repository')
})

// ---- 0.17: a lesson that recurs becomes one issue ------------------------------------
function ledgerWith(runs) {
  const { dir: root } = repo()
  const file = ledgerFile(root)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, runs.map(([run, story, pattern]) => JSON.stringify({ run, story, repo: 'acme/app', pr: 7,
    lessons: [{ id: 'l1', pattern, check: 'lint', proposal: `rule from ${story}` }] })).join('\n') + '\n')
  return root
}
const TITLE = 'story-loop check: hardcoded-path'

test('a pattern seen in one run is not filed; at two runs the draft names every run and its proposal', () => {
  const once = ledgerWith([['a', 'sc-1', 'hardcoded-path'], ['b', 'sc-2', 'other']])
  rules([])
  assert.throws(() => gh.promote(once, 'hardcoded-path'), /seen in 1 run; an issue is filed once it recurs/)
  const twice = ledgerWith([['a', 'sc-1', 'hardcoded-path'], ['a', 'sc-1', 'hardcoded-path'], ['b', 'sc-2', 'hardcoded-path']])
  rules([{ match: 'issue list -R acme/app --state all', stdout: '[]' }])
  const draft = gh.promote(twice, 'hardcoded-path', { dryRun: true })
  assert.equal(draft.state, 'draft')
  assert.equal(draft.title, TITLE)
  assert.match(draft.body, /2 story-loop runs/)
  assert.match(draft.body, /sc-1.*rule from sc-1[\s\S]*sc-2.*rule from sc-2/)
  assert.ok(!calls().some(c => /issue create/.test(c)), 'a draft creates nothing')
})

test('promote files the issue once: an issue with the same title, open or closed, is reported instead', () => {
  const root = ledgerWith([['a', 'sc-1', 'hardcoded-path'], ['b', 'sc-2', 'hardcoded-path']])
  rules([{ match: 'issue list -R acme/app --state all', stdout: '[]', times: 1 },
    { match: `issue create -R acme/app --title ${TITLE} --body`, stdout: 'https://github.com/acme/app/issues/9\n', times: 1 },
    { match: 'issue list -R acme/app --state all', stdout: JSON.stringify([{ title: `${TITLE} (old)`, url: 'x' }, { title: TITLE, url: 'https://github.com/acme/app/issues/9' }]) }])
  assert.deepEqual(gh.promote(root, 'hardcoded-path'), { state: 'created', title: TITLE, url: 'https://github.com/acme/app/issues/9' })
  assert.deepEqual(gh.promote(root, 'hardcoded-path'), { state: 'exists', title: TITLE, url: 'https://github.com/acme/app/issues/9' })
  assert.equal(calls().filter(c => /issue create/.test(c)).length, 1)
  // the log splits a call at the newlines of its body: check the lines a call starts on
  assert.ok(calls().filter(c => /^issue /.test(c)).every(c => /^issue \w+ -R acme\/app/.test(c)), 'every call names the ledger\'s repository')
})

test('an issue closed as completed marks its pattern handled; one closed as not planned does not', () => {
  const root = ledgerWith([['a', 'sc-1', 'hardcoded-path'], ['b', 'sc-2', 'hardcoded-path']])
  const issue = (stateReason, closedAt) => [{ title: TITLE, url: 'https://github.com/acme/app/issues/9', state: 'CLOSED', stateReason, closedAt }]
  rules([{ match: 'issue list -R acme/app --state all .* --json title,url,state,stateReason,closedAt', stdout: JSON.stringify(issue('NOT_PLANNED', '2026-03-01T00:00:00Z')), times: 1 }])
  assert.deepEqual(gh.promote(root, 'hardcoded-path', { dryRun: true }), { state: 'exists', title: TITLE, url: 'https://github.com/acme/app/issues/9' })
  assert.equal(readHandled(root)['hardcoded-path'], undefined)
  rules([{ match: 'issue list -R acme/app --state all', stdout: JSON.stringify(issue('COMPLETED', '2026-03-02T00:00:00Z')), times: 1 }])
  assert.deepEqual(gh.promote(root, 'hardcoded-path', { dryRun: true }), { state: 'handled', title: TITLE, url: 'https://github.com/acme/app/issues/9' })
  assert.deepEqual(readHandled(root)['hardcoded-path'], { at: '2026-03-02T00:00:00Z', by: 'https://github.com/acme/app/issues/9' })
})
