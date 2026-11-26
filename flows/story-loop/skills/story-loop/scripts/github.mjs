#!/usr/bin/env node
// GitHub steps of a run, each recorded in the run state so a resumed session
// reconciles instead of repeating them.
//   node github.mjs ready                        mark the PR ready for review at the published commit
//   node github.mjs copilot-request              ask Copilot to review the published commit
//   node github.mjs copilot-wait [--minutes 30]  wait for that review (bounded); exit 3 on timeout
//   node github.mjs comments                     the Copilot review's top-level comments, one JSON per line
//   node github.mjs human-comments               what human reviewers wrote, one JSON per line, and the PR's state
//   node github.mjs ci                           required checks on the PR head; exit 0 only when they pass
// Every call names the run's repository; gh's default repo and GH_REPO play no part.
//   node github.mjs report --body-file <f> [--attach <img>]...   create or update the one report comment
//   node github.mjs reply --map <file>           answer review threads (fixed / rejected / deferred), resolve the fixed ones
// Each step notes the run and attempt it started in and is checked against that
// before its result is recorded: a step that finishes after the run was ended,
// replaced or sent back to build changes nothing (exit 4, result kept under stale/).
// STORY_LOOP_GH overrides the gh binary (tests use a fake).
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findRoot, repoRoot, load, update, emit, baseName, runKey, opContext, opStart, opUpdate, opEnd, gateProblems, headCommit } from './loop.mjs'
import { bind, record } from './diag.mjs'
import { readLedger, readHandled, markHandled } from './ledger.mjs'

const fail = message => { throw new Error(message) }
const GH = process.env.STORY_LOOP_GH || 'gh'
const MARKER = '<!-- story-loop-report -->'
const sleep = ms => new Promise(r => setTimeout(r, ms))
// The accounts Copilot's reviews come from. A login that merely contains "copilot"
// is somebody else; and where GitHub says what kind of account it is, it is a bot.
// ponytail: a fixed list. If GitHub renames the reviewer, copilot-wait times out and says so; add the login here.
const COPILOT = new Set(['copilot', 'copilot-pull-request-reviewer', 'copilot-pull-request-reviewer[bot]'])
export const isCopilot = (login, type) => COPILOT.has(String(login ?? '').toLowerCase()) && (type == null || type === 'Bot')

// What a gh call was, without what it carried: bodies and filters stay out of the record.
const safeArgs = args => args.filter((a, i) => !['-f', '--body', '--jq', '--body-file'].includes(args[i - 1])).filter(a => !['-f', '--body', '--jq'].includes(a))

// Runs gh; throws an error whose .kind says what went wrong.
export function gh(args, root, opts = {}) {
  const started = Date.now()
  try {
    const out = execFileSync(GH, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000, maxBuffer: 32 << 20, ...opts })
    record(root, 'gh', { args: safeArgs(args), outcome: 'ok', elapsed_ms: Date.now() - started })
    return out
  } catch (error) {
    const text = `${error.stderr ?? ''}${error.stdout ?? ''}${error.message}`
    const kind = /HTTP 401|authentication|gh auth login/i.test(text) ? 'auth'
      : /HTTP 403/i.test(text) && !/rate limit/i.test(text) ? 'forbidden'
      : /rate limit|HTTP 429/i.test(text) ? 'rate_limited'
      : /HTTP 5\d\d|timed? ?out|ETIMEDOUT|ECONNRESET|EAI_AGAIN/i.test(text) ? 'transient'
      : 'error'
    const wrapped = new Error(`gh ${args.slice(0, 3).join(' ')}: ${String(error.stderr || error.message).trim().slice(0, 300)}`)
    wrapped.kind = kind
    wrapped.stdout = String(error.stdout ?? '')
    record(root, 'gh', { args: safeArgs(args), outcome: kind, reason: wrapped.message, elapsed_ms: Date.now() - started })
    throw wrapped
  }
}

// --paginate with --jq '.[]' prints one JSON object per line across all pages.
export function lines(text) {
  return text.split('\n').filter(Boolean).map(line => {
    try { return JSON.parse(line) } catch { fail(`gh returned something that is not JSON: ${line.slice(0, 120)}`) }
  })
}
const paged = (root, path, jq) => lines(gh(['api', '--paginate', path, '--jq', `.[] | ${jq}`], root))
const repoOf = run => run.repo ?? fail('this run has no GitHub repository recorded; set it once: loop.mjs put repo <owner/name>')
const baseOf = run => baseName(run.base) || fail('record the base branch first (loop.mjs put base <branch>)')
// The run and attempt a step works for, bound for its records.
const begin = (root, run, kind, stage) => { const ctx = opContext(root, run, kind, stage); bind(root, run, ctx); return ctx }

// The PR's head commit, after checking it still is the PR this run opened:
// same story branch, same base, not a fork.
export function prHead(root, run) {
  const pr = JSON.parse(gh(['pr', 'view', String(run.pr), '-R', repoOf(run), '--json', 'headRefOid,headRefName,baseRefName,isCrossRepository,state,isDraft'], root))
  observe(root, run, pr)
  pr.isCrossRepository && fail(`PR ${run.pr} comes from a fork; story-loop publishes to and reports on one repository (${run.repo})`)
  pr.headRefName === run.branch || fail(`PR ${run.pr} in ${run.repo} is for branch "${pr.headRefName}", not the story branch "${run.branch}"`)
  pr.baseRefName === baseOf(run) || fail(`PR ${run.pr} now targets "${pr.baseRefName}", not "${baseOf(run)}" as recorded; if the human changed it: loop.mjs put base ${pr.baseRefName}`)
  return pr.headRefOid
}

// A human may close, merge or mark the PR ready at any time. That is theirs to
// do: it is written down and said, never undone.
function observe(root, run, pr) {
  if (typeof pr.state !== 'string') return
  const seen = { state: pr.state, draft: pr.isDraft ?? null }
  const last = run.pr_state
  if (last?.state === seen.state && last?.draft === seen.draft) return
  const changed = last ? `was ${last.state}${last.draft ? ' (draft)' : ''}` : 'first seen'
  const notable = seen.state !== 'OPEN' || seen.draft === false
  try {
    update(root, r => runKey(r) === runKey(run) ? { ...r, pr_state: { ...seen, at: new Date().toISOString(), previous: last ?? null } } : undefined)
  } catch { /* observing must never stop the step that asked */ }
  record(root, 'pr.lifecycle', { ...seen, previous: last ?? null })
  if (!notable) return
  const what = seen.state === 'MERGED' ? 'was merged' : seen.state === 'CLOSED' ? 'was closed' : 'was marked ready for review'
  emit(root, { kind: 'note', text: `PR ${run.pr} ${what} by a human (${changed}); story-loop leaves it as it is` })
  console.error(`github: PR ${run.pr} ${what} (${changed}). That is the human's decision; nothing is undone. Tell them what this run still had open.`)
}

// After the push: the PR leaves draft, so required CI that skips drafts runs on the
// published commit. Only for exactly that commit, on the run's own PR, once; raw
// `gh pr ready` stays refused by the hook. Merging remains the human's alone.
// Why the PR may not leave draft now, or null. Decided from local state alone, before any
// call to GitHub: only a confirmed publication from the push stage (reviewed code, not the
// contract's draft push) of the commit that is HEAD, with every gate holding for it.
export function readinessProblem(root, run) {
  if (run.pushed?.state !== 'confirmed') return 'publish first; the PR is marked ready for the published commit'
  if (run.pushed.stage !== 'push' || run.stages?.push?.status !== 'passed')
    return 'the published commit is the contract\'s draft push, not reviewed code; the PR leaves draft after the push stage passed'
  if (headCommit(root) !== run.pushed.sha) return `HEAD ${headCommit(root)?.slice(0, 7)} is not the published ${run.pushed.sha.slice(0, 7)}`
  const open = Object.entries(gateProblems(root, run))
  return open.length ? `the evidence does not hold for the published commit (${open.map(([id, why]) => `${id}: ${why}`).join('; ')})` : null
}

export function ready(root) {
  const run = load(root)
  const ctx = begin(root, run, 'ready', 'copilot_review')
  if (run.ready?.sha && run.ready.sha === run.pushed?.sha) return `already marked ready at ${run.ready.sha.slice(0, 7)}`
  const refused = readinessProblem(root, run)
  if (refused) { record(root, 'ready', { outcome: 'refused', reason: refused }); fail(`not marked ready: ${refused}. Nothing was changed on GitHub`) }
  const head = run.pushed.sha
  const prSha = prHead(root, run)
  prSha === head || fail(`PR ${run.pr} is at ${prSha.slice(0, 7)}, not the published ${head.slice(0, 7)}; publish again before marking it ready`)
  if (run.ready?.sha === head) return `already marked ready at ${head.slice(0, 7)}`
  const pr = JSON.parse(gh(['pr', 'view', String(run.pr), '-R', repoOf(run), '--json', 'state,isDraft'], root))
  pr.state === 'OPEN' || fail(`PR ${run.pr} is ${pr.state.toLowerCase()}; nothing to mark ready`)
  if (pr.isDraft) gh(['pr', 'ready', String(run.pr), '-R', repoOf(run)], root)
  const at = new Date().toISOString()
  // Recorded as seen, so the next look at the PR does not report it as a human's doing.
  opUpdate(root, ctx, r => ({ ...r, ready: { sha: head, at, by: pr.isDraft ? 'story-loop' : 'already ready' }, pr_state: { state: 'OPEN', draft: false, at, previous: r.pr_state ?? null } }),
    { ready: head }, r => r.pushed?.sha === head ? null : 'the published commit changed while the PR was marked ready')
  emit(root, { kind: 'note', text: `PR ${run.pr} ${pr.isDraft ? 'marked ready for review' : 'was already ready'} at ${head.slice(0, 7)}` })
  return pr.isDraft ? `marked ready at ${head.slice(0, 7)}` : `already ready at ${head.slice(0, 7)}`
}

export function copilotRequest(root) {
  const run = load(root)
  const ctx = begin(root, run, 'copilot-request', 'copilot_review')
  const head = run.pushed?.state === 'confirmed' ? run.pushed.sha : fail('publish first; Copilot reviews the published commit')
  if (run.copilot?.head === head && ['requested', 'reviewed'].includes(run.copilot.state)) return `already requested for ${head.slice(0, 7)}`
  try { gh(['pr', 'edit', String(run.pr), '-R', repoOf(run), '--add-reviewer', '@copilot'], root) } catch (first) {
    if (first.kind === 'auth') throw first
    gh(['api', '-X', 'POST', `repos/${repoOf(run)}/pulls/${run.pr}/requested_reviewers`, '-f', 'reviewers[]=copilot-pull-request-reviewer[bot]'], root)
  }
  const copilot = { state: 'requested', head, requested_at: new Date().toISOString() }
  // The request itself reached GitHub; only its record is refused when the run moved on.
  opUpdate(root, ctx, r => ({ ...r, copilot }), { requested: copilot, note: 'the review was requested on GitHub for the run named in context; reconcile by hand' })
  emit(root, { kind: 'note', text: `Copilot review requested for ${head.slice(0, 7)}` })
  return `requested for ${head.slice(0, 7)}`
}

// The newest submitted Copilot review of exactly `head`, or null.
export function findReview(reviews, head) {
  return reviews.filter(r => isCopilot(r.user, r.type) && r.commit_id === head && r.state !== 'PENDING' && r.submitted_at).at(-1) ?? null
}

// A wait that never ends is worse than one that is refused: both numbers are positive and finite.
const positive = (value, name) => Number.isFinite(value) && value > 0 ? value : fail(`--${name} needs a positive number, got "${value}"`)

export async function copilotWait(root, { minutes = 30, interval = 60 } = {}) {
  positive(minutes, 'minutes'); positive(interval, 'interval')
  const run = load(root)
  const head = run.copilot?.head ?? fail('no Copilot review requested (github.mjs copilot-request)')
  if (run.pushed?.sha !== head) fail(`the review was requested for ${head.slice(0, 7)}, but ${run.pushed?.sha?.slice(0, 7)} is published now; request again`)
  const requested_at = run.copilot.requested_at
  const ctx = opStart(root, 'copilot-wait', 'copilot_review', { head, requested_at, minutes, interval })
  // Whatever this wait ends in belongs to the request it started for, in the run it started in.
  const same = r => r.copilot?.head === head && r.copilot?.requested_at === requested_at ? null
    : `the Copilot request it waited on (${head.slice(0, 7)}, ${requested_at}) is no longer the run's request`
  const finish = (patch, result, outcome, reason) => {
    try { opUpdate(root, ctx, r => ({ ...r, copilot: { ...r.copilot, ...patch } }), result, same) } catch (error) {
      opEnd(root, ctx, error.kind === 'stale' ? 'stale' : 'failed', error.message)
      throw error
    }
    opEnd(root, ctx, outcome, reason)
  }
  const deadline = Date.parse(requested_at) + minutes * 60_000
  let backoff = interval * 1000
  for (;;) {
    try {
      const reviews = paged(root, `repos/${repoOf(run)}/pulls/${run.pr}/reviews?per_page=100`, '{id, user: .user.login, type: .user.type, commit_id, state, submitted_at}')
      const review = findReview(reviews, head)
      if (review) {
        finish({ state: 'reviewed', review: { id: review.id, commit: review.commit_id, submitted_at: review.submitted_at } }, { review }, 'ok')
        emit(root, { kind: 'note', text: `Copilot reviewed ${head.slice(0, 7)}` })
        return review
      }
      backoff = interval * 1000
    } catch (error) {
      if (error.kind === 'stale') throw error
      // Only a rate limit or a provider hiccup is worth waiting out; anything else (auth, malformed output) stops here.
      if (error.kind !== 'rate_limited' && error.kind !== 'transient') {
        finish({ state: 'failed', error: error.message }, { error: error.message }, 'failed', error.message)
        throw error
      }
      backoff = Math.min(backoff * 2, 10 * 60_000) // rate limit or a provider hiccup: wait longer, keep going
      record(root, 'retry', { kind: 'copilot-wait', outcome: error.kind, backoff_ms: backoff, deadline: new Date(deadline).toISOString() })
    }
    if (Date.now() + backoff > deadline) {
      const error = new Error(`no Copilot review of ${head.slice(0, 7)} within ${minutes} minutes`)
      error.kind = 'timeout'
      finish({ state: 'timeout' }, { timeout: error.message }, 'timeout', error.message)
      throw error
    }
    await sleep(backoff)
  }
}

// Top-level comments of the recorded Copilot review; replies are conversation, not findings.
export function comments(root) {
  const run = load(root)
  const ctx = begin(root, run, 'comments', 'fix_comments')
  const review = run.copilot?.review ?? fail('no Copilot review recorded yet (github.mjs copilot-wait)')
  const list = paged(root, `repos/${repoOf(run)}/pulls/${run.pr}/comments?per_page=100`,
    '{id, review: .pull_request_review_id, reply_to: .in_reply_to_id, user: .user.login, path, line, commit: .commit_id, body}')
    .filter(c => c.review === review.id && !c.reply_to)
  // The fetched set is what fix_comments must account for, comment by comment; an empty one is recorded too.
  const fetched = { review: review.id, ids: list.map(c => c.id), at: new Date().toISOString() }
  opUpdate(root, ctx, r => ({ ...r, copilot: { ...r.copilot, comments: fetched } }), fetched,
    r => r.copilot?.review?.id === review.id ? null : `review ${review.id} is no longer the run's Copilot review`)
  return list
}

// What human reviewers wrote on the PR, on any commit: top-level inline comments
// and review bodies. Each is one thing human_review has to account for. The PR's
// state is read in the same call, so "merged, and nothing left unanswered" is one fact.
export function humanComments(root) {
  const run = load(root)
  const ctx = begin(root, run, 'human-comments', 'human_review')
  const repo = repoOf(run)
  const pr = JSON.parse(gh(['pr', 'view', String(run.pr), '-R', repo, '--json', 'state,isDraft'], root))
  observe(root, run, pr)
  const human = c => c.user && c.type !== 'Bot' && !isCopilot(c.user)
  const inline = paged(root, `repos/${repo}/pulls/${run.pr}/comments?per_page=100`,
    '{id, reply_to: .in_reply_to_id, user: .user.login, type: .user.type, path, line, commit: .commit_id, body}')
    .filter(c => !c.reply_to && human(c)).map(c => ({ ...c, id: String(c.id) }))
  const reviews = paged(root, `repos/${repo}/pulls/${run.pr}/reviews?per_page=100`, '{id, user: .user.login, type: .user.type, state, body, commit: .commit_id}')
    .filter(r => human(r) && r.state !== 'PENDING' && String(r.body ?? '').trim()).map(r => ({ ...r, id: `review-${r.id}` }))
  const list = [...inline, ...reviews]
  const fetched = { ids: list.map(c => c.id), pr_state: pr.state, at: new Date().toISOString() }
  opUpdate(root, ctx, r => ({ ...r, human_review: { ...r.human_review, comments: fetched } }), fetched)
  return { state: pr.state, draft: pr.isDraft ?? null, list }
}

// Answers review threads from one map, so "every comment settled" is something a
// script did and recorded, not a promise in prose. The map is JSON:
//   { "<comment id>": { "disposition": "fixed" | "rejected" | "deferred", "message": "...", "commit": "<sha>" } }
// A fix names a commit already in the published head. Only a fixed thread is
// resolved; a rejected or deferred one stays open for the reviewer to answer.
// A review body ("review-<id>") has no thread: its answer is one PR comment.
// Every reply carries a marker with its comment id, so a retry never posts twice.
export const DISPOSITIONS = ['fixed', 'rejected', 'deferred']
const replyMark = id => `<!-- story-loop-reply ${id} -->`

export function checkReplies(map, { pushed, contains }) {
  const entries = Object.entries(map ?? {})
  entries.length || fail('the reply map is empty')
  return entries.map(([id, r]) => {
    /^(\d+|review-\d+)$/.test(id) || fail(`"${id}" is not a review comment id (a number, or review-<id> for a review body)`)
    DISPOSITIONS.includes(r?.disposition) || fail(`comment ${id}: disposition must be one of ${DISPOSITIONS.join(', ')}`)
    String(r.message ?? '').trim() || fail(`comment ${id}: say what was done or why not (message)`)
    if (r.disposition === 'fixed') {
      r.commit || fail(`comment ${id}: a fix names its commit`)
      pushed || fail('publish first; a fix is answered once it is pushed')
      contains(r.commit, pushed) || fail(`comment ${id}: ${String(r.commit).slice(0, 7)} is not in the published head ${pushed.slice(0, 7)}; push it first`)
    }
    return { id, disposition: r.disposition, message: String(r.message).trim(), commit: r.commit ?? null }
  })
}

export function reply(root, mapFile) {
  const run = load(root)
  const stage = run.stages?.human_review?.status === 'running' ? 'human_review' : 'fix_comments'
  const ctx = begin(root, run, 'reply', stage)
  const repo = repoOf(run)
  const contains = (commit, head) => { try { execFileSync('git', ['merge-base', '--is-ancestor', commit, head], { cwd: root, stdio: 'ignore' }); return true } catch { return false } }
  const list = checkReplies(JSON.parse(readFileSync(mapFile, 'utf8')), { pushed: run.pushed?.state === 'confirmed' ? run.pushed.sha : null, contains })
  const me = gh(['api', 'user', '--jq', '.login'], root).trim()
  const ours = c => c.user === me
  const answered = new Set([
    ...paged(root, `repos/${repo}/pulls/${run.pr}/comments?per_page=100`, '{user: .user.login, body}'),
    ...paged(root, `repos/${repo}/issues/${run.pr}/comments?per_page=100`, '{user: .user.login, body}'),
  ].filter(ours).flatMap(c => [...String(c.body).matchAll(/<!-- story-loop-reply (\S+) -->/g)].map(m => m[1])))
  const done = {}
  for (const r of list) {
    const body = `${r.message}\n\n_${r.disposition}${r.commit ? ` in ${r.commit.slice(0, 7)}` : ''} · reply from the story-loop agent_\n${replyMark(r.id)}`
    if (!answered.has(r.id)) {
      if (r.id.startsWith('review-')) gh(['api', '-X', 'POST', `repos/${repo}/issues/${run.pr}/comments`, '-f', `body=${body}`], root)
      else gh(['api', '-X', 'POST', `repos/${repo}/pulls/${run.pr}/comments/${r.id}/replies`, '-f', `body=${body}`], root)
    }
    done[r.id] = { disposition: r.disposition, commit: r.commit, at: new Date().toISOString() }
  }
  const fixed = list.filter(r => r.disposition === 'fixed' && !r.id.startsWith('review-')).map(r => Number(r.id))
  if (fixed.length) {
    const [owner, name] = repo.split('/')
    // ponytail: the first 100 threads. A PR with more is past what one story should be; page here if one ever is.
    const threads = JSON.parse(gh(['api', 'graphql', '-F', `owner=${owner}`, '-F', `name=${name}`, '-F', `pr=${run.pr}`, '-f',
      'query=query($owner:String!,$name:String!,$pr:Int!){repository(owner:$owner,name:$name){pullRequest(number:$pr){reviewThreads(first:100){nodes{id isResolved comments(first:1){nodes{databaseId}}}}}}}'], root))
      .data.repository.pullRequest.reviewThreads.nodes
    for (const t of threads) {
      if (t.isResolved || !fixed.includes(t.comments.nodes[0]?.databaseId)) continue
      gh(['api', 'graphql', '-F', `id=${t.id}`, '-f', 'query=mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{isResolved}}}'], root)
    }
  }
  opUpdate(root, ctx, r => ({ ...r, replies: { ...r.replies, ...done } }), { replies: done })
  emit(root, { kind: 'note', text: `answered ${list.length} review thread${list.length === 1 ? '' : 's'} (${DISPOSITIONS.map(d => `${list.filter(r => r.disposition === d).length} ${d}`).join(', ')})` })
  return done
}

// ---- required CI ---------------------------------------------------------------------
// A requirement is a context name plus, where the policy names one, the GitHub App that must
// produce it (branch protection "checks[].app_id", a ruleset's "integration_id"). A check of
// the same name from another producer never stands in for it. Without an app (legacy
// contexts, app_id -1 "any source", the human's own list) any producer of that name counts,
// as on GitHub. Observed results are read for exactly the PR's head commit: check runs (with
// their app) and commit statuses (no app, so they never satisfy an app-bound requirement).
// Latest result per producer and name decides; for an any-source requirement every producer's
// latest result must pass. Buckets: pass, skipping (GitHub's skipped and neutral satisfy a
// required check), pending, fail, cancel, and unknown (anything unrecognised): only pass and
// skipping are green; unknown never is.
// Not covered: merge-queue and merge-commit (pull_request_target / merge_group) results and
// rules story-loop cannot read are reported as such, never reconstructed.
const anyApp = app => app === null || app === undefined || app === -1
export function bucketOf(c) {
  if (c.type === 'check') {
    if (c.status !== 'completed') return ['queued', 'in_progress', 'waiting', 'requested', 'pending'].includes(c.status) ? 'pending' : 'unknown'
    return { success: 'pass', neutral: 'skipping', skipped: 'skipping', failure: 'fail', timed_out: 'fail', action_required: 'fail', startup_failure: 'fail', stale: 'fail', cancelled: 'cancel' }[c.conclusion] ?? 'unknown'
  }
  if (c.type === 'status') return { success: 'pass', pending: 'pending', failure: 'fail', error: 'fail' }[c.state] ?? 'unknown'
  return 'unknown'
}
// Every check run and status on `head`, schema-checked: a row that is not what it says is an error, never a pass.
function observedChecks(root, repo, head) {
  const runs = lines(gh(['api', '--paginate', `repos/${repo}/commits/${head}/check-runs?per_page=100`, '--jq', '.check_runs[] | {type: "check", name, app_id: .app.id, app: .app.slug, status, conclusion, id, head_sha}'], root))
  const statuses = paged(root, `repos/${repo}/commits/${head}/statuses?per_page=100`, '{type: "status", name: .context, state, id}')
  for (const c of [...runs, ...statuses]) {
    typeof c?.name === 'string' && c.name || fail(`GitHub returned a check without a name: ${JSON.stringify(c).slice(0, 120)}`)
    Number.isFinite(Number(c.id)) || fail(`GitHub returned check "${c.name}" without an id`)
    if (c.type === 'check' && c.head_sha !== undefined && c.head_sha !== head) fail(`check run "${c.name}" is for ${String(c.head_sha).slice(0, 7)}, not the head ${head.slice(0, 7)}`)
  }
  // Latest per producer: a re-run replaces the earlier result of the same check.
  const latest = new Map()
  for (const c of [...runs, ...statuses]) {
    const key = JSON.stringify([c.type, c.name, c.type === 'check' ? c.app_id ?? null : null])
    if (!latest.has(key) || Number(c.id) > Number(latest.get(key).id)) latest.set(key, c)
  }
  return [...latest.values()].map(c => ({ ...c, bucket: bucketOf(c) }))
}
// One requirement against what was observed: { name, app_id, bucket, producers }.
export function matchRequirement(req, observed) {
  const from = observed.filter(c => c.name === req.name && (anyApp(req.app_id) || (c.type === 'check' && c.app_id === req.app_id)))
  const buckets = from.map(c => c.bucket)
  const bucket = !from.length ? 'missing' : buckets.includes('fail') ? 'fail' : buckets.includes('cancel') ? 'cancel'
    : buckets.includes('unknown') ? 'unknown' : buckets.includes('pending') ? 'pending' : 'pass'
  return { name: req.name, app_id: anyApp(req.app_id) ? null : req.app_id, bucket, producers: from.map(c => c.type === 'check' ? `${c.app ?? c.app_id}` : 'status') }
}

// The list the human named, as long as it was approved for this repository and this base.
export function manualChecks(run, repo, base) {
  const f = run.required_checks_for
  return Array.isArray(run.required_checks) && f?.repo === repo && f?.base === base ? run.required_checks : null
}

export function ci(root) {
  const run = load(root)
  const ctx = begin(root, run, 'ci', 'report')
  const repo = repoOf(run)
  const base = baseOf(run)
  const head = prHead(root, run)
  // What must pass: the base branch's policy, plus what the human named (any source, by name).
  // An unreadable policy is unknown, never "nothing required"; then only the human's list stands in for it.
  const policy = requiredChecks(root, repo, base)
  const manual = manualChecks(run, repo, base)
  const reqs = policy.state === 'unknown' && !manual ? null
    : [...policy.required, ...(manual ?? []).filter(name => !policy.required.some(r => r.name === name && anyApp(r.app_id))).map(name => ({ name, app_id: null, source: 'human' }))]
  const required = reqs?.map(r => r.name) ?? null
  const observed = observedChecks(root, repo, head)
  const matched = (reqs ?? []).map(r => matchRequirement(r, observed))
  // A required check GitHub has not created yet is missing, which is pending, not absent.
  const missing = matched.filter(m => m.bucket === 'missing').map(m => m.app_id ? `${m.name} (app ${m.app_id})` : m.name)
  const checks = matched.filter(m => m.bucket !== 'missing').map(m => ({ name: m.name, bucket: m.bucket, app_id: m.app_id, producers: m.producers }))
  const provenance = { state: policy.state, sources: policy.sources, why: policy.why ?? null, manual: manual ? { names: manual, ...run.required_checks_for } : null }
  // The checks were read after the head: if the head moved in between, or is not what
  // this run published, they belong to another commit and are recorded as nothing.
  const after = prHead(root, run)
  if (after !== head || head !== run.pushed?.sha) {
    opUpdate(root, ctx, r => ({ ...r, ci: { sha: after, state: 'head_moved', at: new Date().toISOString() } }), { head, after })
    fail(`the PR head is ${after.slice(0, 7)}, not the published ${run.pushed?.sha?.slice(0, 7) ?? 'commit'}; someone else pushed. These checks are not this run's`)
  }
  const buckets = matched.map(m => m.bucket)
  // A failing required check fails; a passing subset proves nothing while the required set is unknown.
  const state = buckets.includes('fail') || buckets.includes('cancel') ? 'fail'
    : reqs === null ? 'unknown'
    : buckets.includes('unknown') ? 'unknown'
    : buckets.includes('pending') || buckets.includes('missing') ? 'pending'
    : reqs.length ? 'pass' : 'none'
  const result = { sha: head, state, checks, required, requirements: reqs, missing, policy: provenance, repo, base, at: new Date().toISOString() }
  opUpdate(root, ctx, r => ({ ...r, ci: result }), result,
    r => r.pushed?.sha === head && baseName(r.base) === base ? null : 'the run\'s published commit or base changed while CI was read')
  record(root, 'ci', { outcome: state, expected: reqs, observed: observed.map(c => `${c.name}@${c.type === 'check' ? c.app_id : 'status'}:${c.bucket}`), missing, policy: provenance, commit: head, base })
  emit(root, { kind: 'note', text: `required CI on ${head.slice(0, 7)}: ${state}` })
  return { sha: head, state, checks, required, missing, policy: provenance }
}

// Which status checks the base branch requires, from branch protection and rulesets.
//   state     "known", "empty" (read, and nothing is required) or "unknown"
//   required  [{ name, app_id }]: app_id null means any producer of that name
//   sources   how each part was learned; why names what could not be read
// GitHub answers 404 both for "no such rule" and for "you may not see this", so
// a bare 404 is never taken as "nothing is required"; only GitHub's own
// "Branch not protected" and a readable branch are.
const PROTECTION_JQ = '(.checks // ((.contexts // []) | map({context: ., app_id: null})))[] | {name: .context, app_id}'
export function requiredChecks(root, repo, base) {
  const branch = encodeURIComponent(base) // a base like release/1.0 must not become two path segments
  const required = []
  const sources = []
  const unreadable = []
  const add = (rows, source) => {
    for (const c of rows) {
      typeof c?.name === 'string' && c.name || fail(`the ${source} named a required check without a name`)
      const app_id = anyApp(c.app_id) ? null : Number(c.app_id)
      if (!required.some(r => r.name === c.name && r.app_id === app_id)) required.push({ name: c.name, app_id, source })
    }
    sources.push(source)
  }
  const short = error => error.message.match(/HTTP \d+/)?.[0] ?? error.kind ?? 'error'
  try {
    add(lines(gh(['api', `repos/${repo}/branches/${branch}/protection/required_status_checks`, '--jq', PROTECTION_JQ], root)), 'branch protection')
  } catch (error) {
    if (/Branch not protected/i.test(error.message)) sources.push('branch protection (GitHub says the branch is not protected)')
    else {
      // The protection endpoint wants admin rights; the branch itself lists the same checks to anyone who can read it.
      try { add(lines(gh(['api', `repos/${repo}/branches/${branch}`, '--jq', `.protection.required_status_checks | ${PROTECTION_JQ}`], root)), 'branch metadata') }
      catch (second) { unreadable.push(`branch protection (${short(error)}) and the branch itself (${short(second)})`) }
    }
  }
  try {
    add(lines(gh(['api', '--paginate', `repos/${repo}/rules/branches/${branch}`, '--jq', '.[] | select(.type == "required_status_checks") | .parameters.required_status_checks[] | {name: .context, app_id: .integration_id}'], root)), 'rulesets')
  } catch (error) { unreadable.push(`rulesets (${short(error)})`) }
  const names = [...new Set(required.map(r => r.name))]
  if (unreadable.length) return { state: 'unknown', names, required, sources, why: `could not read ${unreadable.join(' and ')}` }
  return { state: required.length ? 'known' : 'empty', names, required, sources }
}

// One report comment per run, found again by its marker so a retry edits it instead of posting twice.
export function report(root, bodyFile, attach = []) {
  const run = load(root)
  const ctx = begin(root, run, 'report', 'report')
  const head = run.pushed?.state === 'confirmed' ? run.pushed.sha : fail('nothing published')
  const repo = repoOf(run)
  // The report speaks for one commit; if the PR moved on, it would describe code nobody checked.
  const live = prHead(root, run)
  live === head || fail(`the PR head is ${live.slice(0, 7)}, not the published ${head.slice(0, 7)}; someone else pushed. The report is not posted`)
  const body = `${MARKER}\n${readFileSync(bodyFile, 'utf8')}`
  const digest = createHash('sha256').update(body).digest('hex')
  const me = gh(['api', 'user', '--jq', '.login'], root).trim()
  const find = () => paged(root, `repos/${repo}/issues/${run.pr}/comments?per_page=100`, '{id, body, user: .user.login}')
    .filter(c => c.user === me && c.body?.startsWith(MARKER)).at(-1)
  opUpdate(root, ctx, r => ({ ...r, report: { state: 'attempted', sha: head } }), { state: 'attempted', sha: head })
  let existing = find()
  if (existing && attach.length) fail('the report comment exists already and an edit cannot carry attachments; post the screenshots with gh pr comment --attach, then run report without --attach')
  const how = existing ? 'edited' : 'posted'
  if (existing) gh(['api', '-X', 'PATCH', `repos/${repo}/issues/comments/${existing.id}`, '-f', `body=${body}`], root)
  else {
    try { gh(['pr', 'comment', String(run.pr), '-R', repo, '--body', body, ...attach.flatMap(file => ['--attach', file])], root) } catch (error) {
      if (!find()) throw error // the comment may have landed even though the answer was lost
    }
    existing = find() ?? fail('the report comment was posted but cannot be found again; run report again to reconcile')
  }
  const confirmed = { state: 'confirmed', sha: head, comment_id: existing.id, repo, pr: run.pr }
  // The comment is on the PR either way; a run that moved on in the meantime only does not count it as its own.
  opUpdate(root, ctx, r => ({ ...r, report: confirmed }), { ...confirmed, note: 'the comment exists on the PR; the run named in context had moved on' })
  record(root, 'report', { outcome: how, comment_id: existing.id, body_sha256: digest, commit: head })
  emit(root, { kind: 'note', text: 'report posted on the PR' })
  return existing.id
}

// A lesson whose pattern came back in two or more runs gets one issue, so its check is
// built as a story of its own. It is looked up by its exact title first, open or closed:
// a retry, another worktree or another machine reports the issue instead of filing it again.
// ponytail: GitHub's search can lag a few seconds behind a create; a retry inside that window could file twice.
export function promote(root, pattern, { dryRun = false } = {}) {
  const hits = readLedger(root).filter(e => (e.lessons ?? []).some(l => l.pattern === pattern))
  hits.length >= 2 || fail(`${pattern} was seen in ${hits.length} run${hits.length === 1 ? '' : 's'}; an issue is filed once it recurs (two or more)`)
  const repo = hits.at(-1).repo ?? fail('the ledger names no repository for these runs')
  const title = `story-loop check: ${pattern}`
  const found = JSON.parse(gh(['issue', 'list', '-R', repo, '--state', 'all', '--search', `"${title}" in:title`, '--json', 'title,url,state,stateReason,closedAt', '--limit', '50'], root))
    .find(i => i.title === title)
  // Closed as completed means the check was built: the pattern is handled (a mark made by hand stays).
  if (found?.state === 'CLOSED' && found.stateReason === 'COMPLETED') {
    readHandled(root)[pattern] ?? markHandled(root, pattern, found.url, found.closedAt)
    return { state: 'handled', title, url: found.url }
  }
  if (found) return { state: 'exists', title, url: found.url }
  const seen = hits.flatMap(e => e.lessons.filter(l => l.pattern === pattern).map(l => ({ ...l, story: e.story, pr: e.pr })))
  const body = [
    `The same kind of mistake was corrected in ${hits.length} story-loop runs. Build the check that catches it, so no reviewer has to.`,
    '', `**Pattern:** \`${pattern}\``, `**Check:** ${[...new Set(seen.map(l => l.check))].join(', ')}`, '', '**Seen in, with what each retro proposed:**',
    ...seen.map(l => `- ${l.story}${l.pr ? ` (PR #${l.pr})` : ''}: ${l.proposal ?? l.note ?? 'no proposal'}`),
    '', '_Filed by the story-loop retro (`github.mjs promote`)._',
  ].join('\n')
  if (dryRun) return { state: 'draft', title, body }
  const url = gh(['issue', 'create', '-R', repo, '--title', title, '--body', body], root).trim()
  return { state: 'created', title, url }
}

async function main([cmd, ...args]) {
  if (cmd === 'promote') {
    const pattern = args.find(a => !a.startsWith('--')) ?? fail('promote needs a pattern slug')
    const result = promote(findRoot() ?? repoRoot(), pattern, { dryRun: args.includes('--dry-run') })
    const said = { draft: `${result.title}\n\n${result.body}`, handled: `handled (its issue was closed as completed): ${result.url}` }
    return console.log(said[result.state] ?? `${result.state}: ${result.url}`)
  }
  const root = findRoot() ?? fail('no active story-loop run here')
  const opt = name => { const i = args.indexOf(`--${name}`); return i < 0 ? undefined : args[i + 1] }
  switch (cmd) {
    case 'ready': return console.log(ready(root))
    case 'copilot-request': return console.log(copilotRequest(root))
    case 'copilot-wait': {
      const review = await copilotWait(root, { minutes: Number(opt('minutes') ?? 30), interval: Number(opt('interval') ?? 60) })
      return console.log(`Copilot reviewed ${review.commit_id.slice(0, 7)} (review ${review.id})`)
    }
    case 'comments': return comments(root).forEach(c => console.log(JSON.stringify(c)))
    case 'human-comments': {
      const { state, draft, list } = humanComments(root)
      list.forEach(c => console.log(JSON.stringify(c)))
      return console.log(`PR is ${state}${draft ? ' (draft)' : ''} · ${list.length} reviewer comment${list.length === 1 ? '' : 's'}`)
    }
    case 'ci': {
      const result = ci(root)
      console.log(`required CI on ${result.sha.slice(0, 7)}: ${result.state}${result.checks.length ? '' : ' (no required checks)'}`)
      for (const c of result.checks) console.log(`  ${c.bucket.padEnd(8)} ${c.name}${c.app_id ? ` (app ${c.app_id})` : ''}  from ${c.producers.join(', ')}`)
      for (const name of result.missing) console.log(`  missing  ${name}  (required, not created by GitHub yet)`)
      console.log(`  required set: ${result.required ? (result.required.join(', ') || 'none') : 'unknown'}  (${[...result.policy.sources, result.policy.manual ? 'the human\'s list' : null].filter(Boolean).join(', ') || 'no readable source'}${result.policy.why ? `; ${result.policy.why}` : ''})`)
      if (!['pass', 'none'].includes(result.state)) process.exitCode = 1
      return
    }
    case 'report': {
      const bodyFile = opt('body-file') ?? fail('report needs --body-file <file>')
      const attach = args.flatMap((a, i) => a === '--attach' ? [args[i + 1]] : [])
      return console.log(`report comment ${report(root, bodyFile, attach)}`)
    }
    case 'reply': {
      const done = reply(root, opt('map') ?? fail('reply needs --map <file>'))
      return Object.entries(done).forEach(([id, r]) => console.log(`${id}  ${r.disposition}${r.commit ? ` ${r.commit.slice(0, 7)}` : ''}`))
    }
    default: fail('usage: github.mjs ready | copilot-request | copilot-wait [--minutes n] | comments | human-comments | ci | report --body-file <f> [--attach img]... | reply --map <file> | promote <pattern> [--dry-run]')
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    console.error(`github: ${error.message}${error.kind ? ` [${error.kind}]` : ''}`)
    process.exit(error.kind === 'timeout' ? 3 : error.kind === 'stale' ? 4 : 1)
  })
}
