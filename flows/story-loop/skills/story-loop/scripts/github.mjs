#!/usr/bin/env node
// GitHub steps of a run, each recorded in the run state so a resumed session
// reconciles instead of repeating them.
//   node github.mjs copilot-request              ask Copilot to review the published commit
//   node github.mjs copilot-wait [--minutes 30]  wait for that review (bounded); exit 3 on timeout
//   node github.mjs comments                     the Copilot review's top-level comments, one JSON per line
//   node github.mjs ci                           required checks on the PR head; exit 0 only when they pass
// Every call names the run's repository; gh's default repo and GH_REPO play no part.
//   node github.mjs report --body-file <f> [--attach <img>]...   create or update the one report comment
// Each step notes the run and attempt it started in and is checked against that
// before its result is recorded: a step that finishes after the run was ended,
// replaced or sent back to build changes nothing (exit 4, result kept under stale/).
// STORY_LOOP_GH overrides the gh binary (tests use a fake).
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findRoot, load, update, emit, baseName, runKey, opContext, opStart, opUpdate, opEnd } from './loop.mjs'
import { bind, record } from './diag.mjs'

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

// The PR's checks as gh lists them; only the ones GitHub labels required, or all.
function prChecks(root, run, required) {
  // gh exits non-zero when checks fail or are pending, and still prints the JSON.
  let out
  try { out = gh(['pr', 'checks', String(run.pr), '-R', repoOf(run), ...(required ? ['--required'] : []), '--json', 'name,state,bucket'], root) } catch (error) {
    if (error.kind !== 'error') throw error
    out = /no required checks|no checks reported/i.test(error.message) ? '[]' : error.stdout
  }
  let checks
  try { checks = JSON.parse(out.trim() || 'null') } catch { checks = null }
  return Array.isArray(checks) ? checks : fail(`gh pr checks gave no readable result: ${String(out).slice(0, 200)}`)
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
  // What must pass: the base branch's policy, plus what the human named. An unreadable
  // policy is unknown, never "nothing required"; then only the human's list stands in for it.
  const policy = requiredChecks(root, repo, base)
  const manual = manualChecks(run, repo, base)
  const required = policy.state === 'unknown' && !manual ? null : [...new Set([...policy.names, ...(manual ?? [])])]
  // `gh pr checks --required` lists what GitHub labels required. A check the policy
  // or the human names without that label is looked up among all the PR's checks.
  const labelled = prChecks(root, run, true)
  const unlabelled = (required ?? []).filter(name => !labelled.some(c => c.name === name))
  const checks = [...labelled, ...(unlabelled.length ? prChecks(root, run, false).filter(c => unlabelled.includes(c.name)) : [])]
  // A required check GitHub has not created yet is missing, which is pending, not absent.
  const missing = (required ?? []).filter(name => !checks.some(c => c.name === name))
  const buckets = checks.map(c => c.bucket)
  const provenance = { state: policy.state, sources: policy.sources, why: policy.why ?? null, manual: manual ? { names: manual, ...run.required_checks_for } : null }
  // The checks were read after the head: if the head moved in between, or is not what
  // this run published, they belong to another commit and are recorded as nothing.
  const after = prHead(root, run)
  if (after !== head || head !== run.pushed?.sha) {
    opUpdate(root, ctx, r => ({ ...r, ci: { sha: after, state: 'head_moved', at: new Date().toISOString() } }), { head, after })
    fail(`the PR head is ${after.slice(0, 7)}, not the published ${run.pushed?.sha?.slice(0, 7) ?? 'commit'}; someone else pushed. These checks are not this run's`)
  }
  // A passing subset proves nothing while the set of required checks is unknown.
  const state = buckets.includes('fail') || buckets.includes('cancel') ? 'fail'
    : required === null ? 'unknown'
    : buckets.includes('pending') || missing.length ? 'pending'
    : checks.length ? 'pass' : 'none'
  const result = { sha: head, state, checks, required, missing, policy: provenance, repo, base, at: new Date().toISOString() }
  opUpdate(root, ctx, r => ({ ...r, ci: result }), result,
    r => r.pushed?.sha === head && baseName(r.base) === base ? null : 'the run\'s published commit or base changed while CI was read')
  record(root, 'ci', { outcome: state, expected: required, observed: checks.map(c => `${c.name}:${c.bucket}`), missing, policy: provenance, commit: head, base })
  emit(root, { kind: 'note', text: `required CI on ${head.slice(0, 7)}: ${state}` })
  return { sha: head, state, checks, required, missing, policy: provenance }
}

// Which status checks the base branch requires, from branch protection and rulesets.
//   state   "known" (names), "empty" (read, and nothing is required) or "unknown"
//   sources how each part was learned; why names what could not be read
// GitHub answers 404 both for "no such rule" and for "you may not see this", so
// a bare 404 is never taken as "nothing is required"; only GitHub's own
// "Branch not protected" and a readable branch are.
export function requiredChecks(root, repo, base) {
  const branch = encodeURIComponent(base) // a base like release/1.0 must not become two path segments
  const names = new Set()
  const sources = []
  const unreadable = []
  const read = (args, source) => { lines(gh(args, root)).forEach(c => names.add(c.name)); sources.push(source) }
  const short = error => error.message.match(/HTTP \d+/)?.[0] ?? error.kind ?? 'error'
  try {
    read(['api', `repos/${repo}/branches/${branch}/protection/required_status_checks`, '--jq', '.contexts[] | {name: .}'], 'branch protection')
  } catch (error) {
    if (/Branch not protected/i.test(error.message)) sources.push('branch protection (GitHub says the branch is not protected)')
    else {
      // The protection endpoint wants admin rights; the branch itself lists the same contexts to anyone who can read it.
      try { read(['api', `repos/${repo}/branches/${branch}`, '--jq', '.protection.required_status_checks.contexts[] | {name: .}'], 'branch metadata') }
      catch (second) { unreadable.push(`branch protection (${short(error)}) and the branch itself (${short(second)})`) }
    }
  }
  try {
    read(['api', '--paginate', `repos/${repo}/rules/branches/${branch}`, '--jq', '.[] | select(.type == "required_status_checks") | .parameters.required_status_checks[] | {name: .context}'], 'rulesets')
  } catch (error) { unreadable.push(`rulesets (${short(error)})`) }
  if (unreadable.length) return { state: 'unknown', names: [...names], sources, why: `could not read ${unreadable.join(' and ')}` }
  return { state: names.size ? 'known' : 'empty', names: [...names], sources }
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

async function main([cmd, ...args]) {
  const root = findRoot() ?? fail('no active story-loop run here')
  const opt = name => { const i = args.indexOf(`--${name}`); return i < 0 ? undefined : args[i + 1] }
  switch (cmd) {
    case 'copilot-request': return console.log(copilotRequest(root))
    case 'copilot-wait': {
      const review = await copilotWait(root, { minutes: Number(opt('minutes') ?? 30), interval: Number(opt('interval') ?? 60) })
      return console.log(`Copilot reviewed ${review.commit_id.slice(0, 7)} (review ${review.id})`)
    }
    case 'comments': return comments(root).forEach(c => console.log(JSON.stringify(c)))
    case 'ci': {
      const result = ci(root)
      console.log(`required CI on ${result.sha.slice(0, 7)}: ${result.state}${result.checks.length ? '' : ' (no required checks)'}`)
      for (const c of result.checks) console.log(`  ${c.bucket.padEnd(8)} ${c.name}`)
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
    default: fail('usage: github.mjs copilot-request | copilot-wait [--minutes n] | comments | ci | report --body-file <f> [--attach img]...')
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    console.error(`github: ${error.message}${error.kind ? ` [${error.kind}]` : ''}`)
    process.exit(error.kind === 'timeout' ? 3 : error.kind === 'stale' ? 4 : 1)
  })
}
