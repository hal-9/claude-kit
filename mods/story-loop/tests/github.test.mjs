// github.mjs against a fake gh: a script that answers from a rules file and logs every call.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { load, update } from '../skills/story-loop/scripts/loop.mjs'
import { repo, withRun } from './helpers.mjs'

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

const SHA = 'a'.repeat(40)
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
  rules([{ match: 'pr edit 7 --add-reviewer @copilot', times: 1 }])
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
  rules([{ match: 'pr edit 7 --add-reviewer @copilot', times: 1 }])
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
})

test('required CI is evaluated on the PR head: pending and failing are not passing', () => {
  const root = published()
  const head = { match: 'pr view 7 --json headRefOid', stdout: JSON.stringify({ headRefOid: SHA }), times: 9 }
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
    { match: '^api user', stdout: 'story-bot\n', times: 9 },
    { match: 'issues/7/comments', stdout: jsonl([{ id: 1, user: 'a-human', body: 'quoting: <!-- story-loop-report -->' }]), times: 1 },
    { match: 'pr comment 7', stderr: 'ECONNRESET', code: 1, times: 1 },
    { match: 'issues/7/comments', stdout: jsonl([{ id: 1, user: 'a-human', body: 'quoting: <!-- story-loop-report -->' }, { id: 555, user: 'story-bot', body: '<!-- story-loop-report -->\nall good' }]), times: 9 },
    { match: 'PATCH .*issues/comments/555', stdout: '{}', times: 9 },
  ])
  assert.equal(gh.report(root, body), 555)
  assert.deepEqual(load(root).report, { state: 'confirmed', sha: SHA, comment_id: 555 })
  assert.equal(gh.report(root, body), 555)
  assert.equal(calls().filter(c => c.startsWith('pr comment')).length, 1)
  assert.equal(calls().filter(c => c.includes('PATCH')).length, 1)
  assert.equal(existsSync(state), false)
  assert.throws(() => gh.report(root, body, ['shot.png']), /cannot carry attachments/)
})
