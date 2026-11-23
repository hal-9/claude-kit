#!/usr/bin/env node
// GitHub steps of a run, each recorded in the run state so a resumed session
// reconciles instead of repeating them.
//   node github.mjs copilot-request              ask Copilot to review the published commit
//   node github.mjs copilot-wait [--minutes 30]  wait for that review (bounded); exit 3 on timeout
//   node github.mjs comments                     the Copilot review's top-level comments, one JSON per line
//   node github.mjs ci                           required checks on the PR head; exit 0 only when they pass
// Every call names the run's repository; gh's default repo and GH_REPO play no part.
//   node github.mjs report --body-file <f> [--attach <img>]...   create or update the one report comment
// STORY_LOOP_GH overrides the gh binary (tests use a fake).
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findRoot, load, update, emit } from './loop.mjs'

const fail = message => { throw new Error(message) }
const GH = process.env.STORY_LOOP_GH || 'gh'
const MARKER = '<!-- story-loop-report -->'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const isCopilot = login => /copilot/i.test(String(login ?? ''))

// Runs gh; throws an error whose .kind says what went wrong.
export function gh(args, root, opts = {}) {
  try {
    return execFileSync(GH, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000, maxBuffer: 32 << 20, ...opts })
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
const baseOf = run => String(run.base ?? '').replace(/^origin\//, '') || fail('record the base branch first (loop.mjs put base <branch>)')

// The PR's head commit, after checking it still is the PR this run opened:
// same story branch, same base, not a fork.
export function prHead(root, run) {
  const pr = JSON.parse(gh(['pr', 'view', String(run.pr), '-R', repoOf(run), '--json', 'headRefOid,headRefName,baseRefName,isCrossRepository'], root))
  pr.isCrossRepository && fail(`PR ${run.pr} comes from a fork; story-loop publishes to and reports on one repository (${run.repo})`)
  pr.headRefName === run.branch || fail(`PR ${run.pr} in ${run.repo} is for branch "${pr.headRefName}", not the story branch "${run.branch}"`)
  pr.baseRefName === baseOf(run) || fail(`PR ${run.pr} now targets "${pr.baseRefName}", not "${baseOf(run)}" as recorded; if the human changed it: loop.mjs put base ${pr.baseRefName}`)
  return pr.headRefOid
}

export function copilotRequest(root) {
  const run = load(root)
  const head = run.pushed?.state === 'confirmed' ? run.pushed.sha : fail('publish first; Copilot reviews the published commit')
  if (run.copilot?.head === head && ['requested', 'reviewed'].includes(run.copilot.state)) return `already requested for ${head.slice(0, 7)}`
  try { gh(['pr', 'edit', String(run.pr), '-R', repoOf(run), '--add-reviewer', '@copilot'], root) } catch (first) {
    if (first.kind === 'auth') throw first
    gh(['api', '-X', 'POST', `repos/${repoOf(run)}/pulls/${run.pr}/requested_reviewers`, '-f', 'reviewers[]=copilot-pull-request-reviewer[bot]'], root)
  }
  update(root, r => ({ ...r, copilot: { state: 'requested', head, requested_at: new Date().toISOString() } }))
  emit(root, { kind: 'note', text: `Copilot review requested for ${head.slice(0, 7)}` })
  return `requested for ${head.slice(0, 7)}`
}

// The newest submitted Copilot review of exactly `head`, or null.
export function findReview(reviews, head) {
  return reviews.filter(r => isCopilot(r.user) && r.commit_id === head && r.state !== 'PENDING' && r.submitted_at).at(-1) ?? null
}

export async function copilotWait(root, { minutes = 30, interval = 60 } = {}) {
  const run = load(root)
  const head = run.copilot?.head ?? fail('no Copilot review requested (github.mjs copilot-request)')
  if (run.pushed?.sha !== head) fail(`the review was requested for ${head.slice(0, 7)}, but ${run.pushed?.sha?.slice(0, 7)} is published now; request again`)
  const deadline = Date.parse(run.copilot.requested_at) + minutes * 60_000
  let backoff = interval * 1000
  for (;;) {
    try {
      const reviews = paged(root, `repos/${repoOf(run)}/pulls/${run.pr}/reviews?per_page=100`, '{id, user: .user.login, commit_id, state, submitted_at}')
      const review = findReview(reviews, head)
      if (review) {
        update(root, r => ({ ...r, copilot: { ...r.copilot, state: 'reviewed', review: { id: review.id, commit: review.commit_id, submitted_at: review.submitted_at } } }))
        emit(root, { kind: 'note', text: `Copilot reviewed ${head.slice(0, 7)}` })
        return review
      }
      backoff = interval * 1000
    } catch (error) {
      // Only a rate limit or a provider hiccup is worth waiting out; anything else (auth, malformed output) stops here.
      if (error.kind !== 'rate_limited' && error.kind !== 'transient') {
        update(root, r => ({ ...r, copilot: { ...r.copilot, state: 'failed', error: error.message } }))
        throw error
      }
      backoff = Math.min(backoff * 2, 10 * 60_000) // rate limit or a provider hiccup: wait longer, keep going
    }
    if (Date.now() + backoff > deadline) {
      update(root, r => ({ ...r, copilot: { ...r.copilot, state: 'timeout' } }))
      const error = new Error(`no Copilot review of ${head.slice(0, 7)} within ${minutes} minutes`)
      error.kind = 'timeout'
      throw error
    }
    await sleep(backoff)
  }
}

// Top-level comments of the recorded Copilot review; replies are conversation, not findings.
export function comments(root) {
  const run = load(root)
  const review = run.copilot?.review ?? fail('no Copilot review recorded yet (github.mjs copilot-wait)')
  const list = paged(root, `repos/${repoOf(run)}/pulls/${run.pr}/comments?per_page=100`,
    '{id, review: .pull_request_review_id, reply_to: .in_reply_to_id, user: .user.login, path, line, commit: .commit_id, body}')
    .filter(c => c.review === review.id && !c.reply_to)
  // The fetched set is what fix_comments must account for, comment by comment; an empty one is recorded too.
  update(root, r => ({ ...r, copilot: { ...r.copilot, comments: { review: review.id, ids: list.map(c => c.id), at: new Date().toISOString() } } }))
  return list
}

export function ci(root) {
  const run = load(root)
  const head = prHead(root, run)
  // gh exits non-zero when checks fail or are pending, and still prints the JSON.
  let out
  try { out = gh(['pr', 'checks', String(run.pr), '-R', repoOf(run), '--required', '--json', 'name,state,bucket'], root) } catch (error) {
    if (error.kind !== 'error') throw error
    out = /no required checks|no checks reported/i.test(error.message) ? '[]' : error.stdout
  }
  let checks
  try { checks = JSON.parse(out.trim() || 'null') } catch { checks = null }
  Array.isArray(checks) || fail(`gh pr checks gave no readable result: ${String(out).slice(0, 200)}`)
  // Checks GitHub has not created yet are missing from that list, so compare with what the base requires.
  // When the policy cannot be read, a list the human approved stands in for it; nothing else does.
  const required = requiredChecks(root, repoOf(run), baseOf(run)) ?? (Array.isArray(run.required_checks) ? run.required_checks : null)
  const missing = (required ?? []).filter(name => !checks.some(c => c.name === name))
  const buckets = checks.map(c => c.bucket)
  // The checks were read after the head: if the head moved in between, or is not what
  // this run published, they belong to another commit and are recorded as nothing.
  const after = prHead(root, run)
  if (after !== head || head !== run.pushed?.sha) {
    update(root, r => ({ ...r, ci: { sha: after, state: 'head_moved', at: new Date().toISOString() } }))
    fail(`the PR head is ${after.slice(0, 7)}, not the published ${run.pushed?.sha?.slice(0, 7) ?? 'commit'}; someone else pushed. These checks are not this run's`)
  }
  // A passing subset proves nothing while the set of required checks is unknown.
  const state = buckets.includes('fail') || buckets.includes('cancel') ? 'fail'
    : required === null ? 'unknown'
    : buckets.includes('pending') || missing.length ? 'pending'
    : checks.length ? 'pass' : 'none'
  update(root, r => ({ ...r, ci: { sha: head, state, checks, required, missing, at: new Date().toISOString() } }))
  emit(root, { kind: 'note', text: `required CI on ${head.slice(0, 7)}: ${state}` })
  return { sha: head, state, checks }
}

// Names of the status checks the base branch requires, from branch protection and
// rulesets; [] when nothing is required, null when we may not read it.
export function requiredChecks(root, repo, base) {
  const names = new Set()
  let readable = true
  try {
    lines(gh(['api', `repos/${repo}/branches/${base}/protection/required_status_checks`, '--jq', '.contexts[] | {name: .}'], root)).forEach(c => names.add(c.name))
  } catch (error) {
    if (!/HTTP 404|not protected/i.test(error.message)) {
      // The protection endpoint wants admin rights; the branch itself lists the same contexts to anyone who can read it.
      try {
        lines(gh(['api', `repos/${repo}/branches/${base}`, '--jq', '.protection.required_status_checks.contexts[] | {name: .}'], root)).forEach(c => names.add(c.name))
      } catch { readable = false }
    }
  }
  try {
    lines(gh(['api', '--paginate', `repos/${repo}/rules/branches/${base}`, '--jq', '.[] | select(.type == "required_status_checks") | .parameters.required_status_checks[] | {name: .context}'], root)).forEach(c => names.add(c.name))
  } catch (error) { if (!/HTTP 404/i.test(error.message)) readable = false }
  return readable ? [...names] : null
}

// One report comment per run, found again by its marker so a retry edits it instead of posting twice.
export function report(root, bodyFile, attach = []) {
  const run = load(root)
  const head = run.pushed?.state === 'confirmed' ? run.pushed.sha : fail('nothing published')
  const repo = repoOf(run)
  // The report speaks for one commit; if the PR moved on, it would describe code nobody checked.
  const live = prHead(root, run)
  live === head || fail(`the PR head is ${live.slice(0, 7)}, not the published ${head.slice(0, 7)}; someone else pushed. The report is not posted`)
  const body = `${MARKER}\n${readFileSync(bodyFile, 'utf8')}`
  const me = gh(['api', 'user', '--jq', '.login'], root).trim()
  const find = () => paged(root, `repos/${repo}/issues/${run.pr}/comments?per_page=100`, '{id, body, user: .user.login}')
    .filter(c => c.user === me && c.body?.startsWith(MARKER)).at(-1)
  update(root, r => ({ ...r, report: { state: 'attempted', sha: head } }))
  let existing = find()
  if (existing && attach.length) fail('the report comment exists already and an edit cannot carry attachments; post the screenshots with gh pr comment --attach, then run report without --attach')
  if (existing) gh(['api', '-X', 'PATCH', `repos/${repo}/issues/comments/${existing.id}`, '-f', `body=${body}`], root)
  else {
    try { gh(['pr', 'comment', String(run.pr), '-R', repo, '--body', body, ...attach.flatMap(file => ['--attach', file])], root) } catch (error) {
      if (!find()) throw error // the comment may have landed even though the answer was lost
    }
    existing = find() ?? fail('the report comment was posted but cannot be found again; run report again to reconcile')
  }
  update(root, r => ({ ...r, report: { state: 'confirmed', sha: head, comment_id: existing.id, repo, pr: run.pr } }))
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
    process.exit(error.kind === 'timeout' ? 3 : 1)
  })
}
