// Structured reviewer output and complete finding accounting (2026-11-26 audit).
// A reviewer's findings are ingested as source findings; triage attaches dispositions to
// them, and the second review completes only when every requested angle answered and
// every source finding is accounted for.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { load, update, passProblem, reviewProblem, REVIEW_SCHEMA } from '../skills/story-loop/scripts/loop.mjs'
import { repo, withRun } from './helpers.mjs'

const LOOP = fileURLToPath(new URL('../skills/story-loop/scripts/loop.mjs', import.meta.url))
const cli = (cwd, ...args) => spawnSync('node', [LOOP, ...args], { cwd, encoding: 'utf8' })
const ok = r => { assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`); return r }

function atReview() {
  const { dir, commit } = repo()
  commit('orders.js', 'export const edit = (user, order) => true\n')
  withRun(dir)
  update(dir, r => { for (const id of ['contract', 'build', 'quality', 'test_review', 'verify']) r.stages[id].status = 'passed'; return r })
  const id = ok(cli(dir, 'start', 'second_review')).stdout.match(/review request: (\S+)/)[1]
  let n = 0
  const answer = (reviewer, angles, extra = {}) => {
    const file = join(dir, '.start-story', `answer-${++n}.json`)
    writeFileSync(file, typeof angles === 'string' ? angles : JSON.stringify({ schema: REVIEW_SCHEMA, request: id, reviewer, angles, ...extra }))
    return cli(dir, 'review', reviewer, file, '--request', id)
  }
  return { dir, id, answer }
}
const BYPASS = { id: 's1', severity: 'blocker', title: 'authorization bypass: any user can edit any order', file: 'orders.js', line: 1 }

test('a blocker the reviewer reported cannot be dropped from triage', () => {
  const { dir, answer } = atReview()
  ok(answer('codex', [{ angle: 'security', status: 'complete', findings: [BYPASS] }]))
  const [finding] = load(dir).findings
  assert.deepEqual([finding.sources, finding.severity, finding.verdict], [['codex/security/s1'], 'blocker', 'open'], 'ingested as the reviewer wrote it')
  assert.match(cli(dir, 'pass', 'second_review').stderr, /r1 is open/)
  // Replacing the list cannot make it disappear, with or without --replace.
  assert.match(cli(dir, 'put', 'findings', '[]').stderr, /leaves out recorded findings/)
  assert.match(cli(dir, 'put', 'findings', '[]', '--replace').stderr, /drops reviewer findings codex\/security\/s1/)
  // Even a list rewritten behind the CLI's back is caught by the gate.
  update(dir, r => ({ ...r, findings: [] }))
  assert.match(passProblem(dir, load(dir), 'second_review'), /1 review findings have no triaged finding: codex\/security\/s1/)
  update(dir, r => ({ ...r, findings: [{ ...finding }] }))
  // A blocker is never parked; a withdrawal is recorded, not deleted.
  assert.match(cli(dir, 'finding', 'r1', 'parked', 'later').stdout + cli(dir, 'pass', 'second_review').stderr, /never parked/)
  ok(cli(dir, 'finding', 'r1', 'rejected', 'reviewer withdrew it: the route checks ownership in a before_action'))
  ok(cli(dir, 'pass', 'second_review'))
})

test('partial, failed, malformed and missing angle results never read as success', () => {
  const { dir, id, answer } = atReview()
  ok(cli(dir, 'angles', 'standards', 'security'))
  // Missing: nothing recorded yet.
  assert.match(passProblem(dir, load(dir), 'second_review'), /record the review of this code/)
  // Malformed: refused at the door; nothing recorded, the review is still open.
  assert.match(answer('codex', '{"schema": "story-loop.review/1", "request": ').stderr, /does not parse/)
  assert.match(answer('codex', [{ angle: 'security', status: 'complete' }]).stderr, /findings is a list/)
  assert.match(answer('codex', [{ angle: 'security', status: 'done', findings: [] }]).stderr, /status is one of/)
  assert.match(answer('codex', [{ angle: 'x', status: 'complete', findings: [] }], { request: 'other' }).stderr, /answers request "other"/)
  assert.equal(load(dir).reviews, undefined)
  // Partial: one requested angle answered.
  ok(answer('angle-standards', [{ angle: 'standards', status: 'complete', findings: [] }]))
  assert.match(passProblem(dir, load(dir), 'second_review'), /did not complete: security \(no answer\)/)
  // Failed: the security angle ran and did not finish.
  ok(answer('angle-security', [{ angle: 'security', status: 'failed', note: 'context limit', findings: [] }]))
  assert.match(passProblem(dir, load(dir), 'second_review'), /did not complete: security \(failed\)/)
  // A legitimate no-op needs its reason, and then counts.
  assert.match(answer('angle-security', [{ angle: 'security', status: 'no_op', findings: [] }]).stderr, /say why/)
  ok(answer('angle-security', [{ angle: 'security', status: 'no_op', note: 'no auth, input or data surface in this diff', findings: [] }]))
  assert.equal(passProblem(dir, load(dir), 'second_review'), null)
  assert.ok(id)
})

test('several reviewers naming one defect stay fully accounted for after deduplication, in any order', () => {
  const orders = [['codex', 'claude'], ['claude', 'codex']]
  const outcomes = orders.map(order => {
    const { dir, answer } = atReview()
    const said = {
      codex: [{ angle: 'security', status: 'complete', findings: [BYPASS] }],
      claude: [{ angle: 'standards', status: 'complete', findings: [{ id: 'a7', severity: 'major', title: 'edit() ignores the order owner' }, { id: 'a8', severity: 'nit', title: 'name' }] }],
    }
    for (const who of order) ok(answer(who, said[who]))
    const before = passProblem(dir, load(dir), 'second_review')
    const byTitle = t => load(dir).findings.find(f => f.title.startsWith(t)).id
    const canonical = byTitle('authorization bypass'), repeat = byTitle('edit() ignores'), nit = byTitle('name')
    assert.match(cli(dir, 'finding', repeat, 'duplicate').stderr, /names the canonical finding/)
    ok(cli(dir, 'finding', repeat, 'duplicate', '--of', canonical))
    ok(cli(dir, 'finding', nit, 'rejected', 'style, out of scope'))
    assert.match(passProblem(dir, load(dir), 'second_review'), new RegExp(`${canonical} is open`), 'the duplicate defers to its canonical finding')
    ok(cli(dir, 'finding', canonical, 'fixed', 'owner check added', '--commit', 'abc1234'))
    const sources = load(dir).findings.flatMap(f => f.sources).sort()
    return { before: before.replace(/r\d+/g, 'r?'), sources, after: passProblem(dir, load(dir), 'second_review') }
  })
  assert.deepEqual(outcomes[0], outcomes[1], 'the same obligations whatever order the answers came in')
  assert.deepEqual(outcomes[0].sources, ['claude/standards/a7', 'claude/standards/a8', 'codex/security/s1'])
  assert.equal(outcomes[0].after, null)
})

test('a result for a stale request or older code cannot satisfy the current review', () => {
  const { dir, id, answer } = atReview()
  const stale = join(dir, '.start-story', 'stale.json')
  writeFileSync(stale, JSON.stringify({ schema: REVIEW_SCHEMA, request: id, angles: [{ angle: 'standards', status: 'complete', findings: [] }] }))
  // New code, new request: the old answer is history.
  update(dir, r => { r.stages.second_review.status = 'blocked'; return r })
  spawnSync('git', ['commit', '-q', '--allow-empty', '-m', 'empty'], { cwd: dir })
  writeFileSync(join(dir, 'orders.js'), 'export const edit = (user, order) => order.owner === user\n')
  spawnSync('git', ['commit', '-qam', 'fix'], { cwd: dir })
  const next = ok(cli(dir, 'start', 'second_review')).stdout.match(/review request: (\S+)/)[1]
  assert.notEqual(next, id)
  assert.match(cli(dir, 'review', 'codex', stale, '--request', id).stderr, /answer to an earlier request is history/)
  assert.match(cli(dir, 'review', 'codex', stale, '--request', next).stderr, /answers request ".*", not "/)
  assert.match(reviewProblem(dir, load(dir), load(dir).stages.second_review.request), /record the review/)
  assert.ok(answer)
})

test('free text is recorded but needs a structured transcription before it counts', () => {
  const { dir, id } = atReview()
  const text = join(dir, '.start-story', 'codex.txt')
  writeFileSync(text, 'BLOCKER: any user can edit any order (orders.js:1)\n')
  ok(cli(dir, 'review', 'codex', text, '--request', id))
  assert.match(passProblem(dir, load(dir), 'second_review'), /free text .*not read as "no findings"/)
  // A transcription that names the wrong text is refused.
  const bad = join(dir, '.start-story', 't.json')
  writeFileSync(bad, JSON.stringify({ schema: REVIEW_SCHEMA, request: id, transcribes: 'f'.repeat(64), angles: [{ angle: 'standards', status: 'complete', findings: [] }] }))
  assert.match(cli(dir, 'review', 'codex', bad, '--request', id).stderr, /no free-text review of request/)
  const sha = load(dir).review.sha256
  writeFileSync(bad, JSON.stringify({ schema: REVIEW_SCHEMA, request: id, transcribes: sha, angles: [{ angle: 'standards', status: 'complete', findings: [BYPASS] }] }))
  ok(cli(dir, 'review', 'codex', bad, '--request', id))
  assert.match(passProblem(dir, load(dir), 'second_review'), /r1 is open/)
})
