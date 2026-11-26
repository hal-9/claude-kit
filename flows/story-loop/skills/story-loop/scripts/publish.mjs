#!/usr/bin/env node
// The one way a run publishes code: the current commit, frozen, to the story
// branch on the recorded remote, nothing else.   node publish.mjs
// Refuses force, tags, extra refs, a dirty checkout, the wrong branch, a remote
// with several or changed push URLs, unsigned new commits where signing is on,
// and, in the push stage, code its test review, browser check or second review
// did not cover. It pushes to and reads back from the push URL itself; a
// mismatch is recorded, never forced.
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findRoot, load, emit, current, gitIn, dirty, gateProblems, subjectOf, remoteRepo, baseName, opContext, opUpdate } from './loop.mjs'
import { bind, record, redact } from './diag.mjs'

const fail = message => { throw new Error(message) }
const STAGES = ['contract', 'push']
const isPath = url => /^(\/|\.{1,2}\/|file:\/\/)/.test(url)

// Why this push URL is not where the run may publish, or null. The run names one
// GitHub repository; the push URL must be that repository, in any of the ssh or
// https spellings. A fork, another repository or a host that cannot be read as
// GitHub is refused before anything is written.
// A local path passes only under STORY_LOOP_LOCAL_REMOTE=1: the tests publish to
// bare repositories on disk, and a path can never be somebody's GitHub repository.
export function destinationProblem(run, url) {
  const target = remoteRepo(url)
  if (!target) {
    if (isPath(url) && process.env.STORY_LOOP_LOCAL_REMOTE === '1') return null
    return `the push URL ${redact(url)} is not a GitHub repository story-loop can identify (git@github.com:owner/name or https://github.com/owner/name); nothing was pushed`
  }
  if (!run.repo) return `this run has no repository recorded, so ${target} cannot be checked against it; set it once: loop.mjs put repo <owner/name>`
  return target === run.repo ? null
    : `this run belongs to ${run.repo}, but the remote pushes to ${target}; nothing was pushed. A fork or a second repository is not supported: point the remote's push URL at ${run.repo}`
}

export function publish(root) {
  const git = gitIn(root)
  const run = load(root)
  STAGES.includes(current(run)) || fail(`publishing happens in ${STAGES.join(' or ')}; the run is at ${current(run) ?? 'its end'}`)
  const ctx = opContext(root, run, 'publish', current(run))
  bind(root, run, ctx)
  const branch = run.branch ?? fail('record the story branch first (loop.mjs put branch <branch>)')
  // The base is part of the destination: without it nothing says which branch the story must not be.
  const base = baseName(run.base) || fail('record the base branch before the first publish (loop.mjs put base <branch>)')
  branch === base && fail(`the story branch "${branch}" is the base branch; story-loop publishes a story to its own branch, never to the base`)
  try { git('check-ref-format', `refs/heads/${branch}`) } catch { fail(`"${branch}" is not a valid branch name`) }
  const onBranch = git('rev-parse', '--abbrev-ref', 'HEAD')
  onBranch === branch || fail(`the checkout is on "${onBranch}", not the story branch "${branch}"`)
  dirty(root) && fail('the checkout has uncommitted changes; commit them first')
  const sha = git('rev-parse', 'HEAD') // frozen: whatever moves HEAD from here on is not published
  // The contract push opens the draft PR before any review exists; the push stage publishes reviewed code only.
  // The decision is the shared gate evaluator's, made before anything is written to the remote:
  // a failed or still-running rerun, a moved base or a missing artifact refuses it like stale code.
  if (current(run) === 'push') {
    const open = Object.entries(gateProblems(root, run, subjectOf(root, run, git('rev-parse', `${sha}^{tree}`))))
    open.length && fail(`${open.map(([id, why]) => `${id}: ${why}`).join('; ')}; nothing was pushed. Run what failed again, or go back to build so it runs on this code`)
  }

  const remote = run.remote ?? 'origin'
  const urls = git('remote', 'get-url', '--push', '--all', remote).split('\n').filter(Boolean)
  urls.length === 1 || fail(`remote "${remote}" pushes to ${urls.length} URLs; story-loop publishes to exactly one`)
  let mirror = ''
  try { mirror = git('config', '--get', `remote.${remote}.mirror`) } catch {}
  mirror === 'true' && fail(`remote "${remote}" is a mirror remote; it would push every ref`)
  run.remote_url && run.remote_url !== urls[0] && fail(`remote "${remote}" now points at ${redact(urls[0])}, not ${redact(run.remote_url)} as when the run first published`)
  const url = urls[0]
  const wrong = destinationProblem(run, url)
  wrong && fail(wrong)
  // The repository's default branch, asked of the destination itself: a story is never published onto it.
  let defaultBranch = null
  try { defaultBranch = git('ls-remote', '--symref', url, 'HEAD').match(/^ref: refs\/heads\/(\S+)\s+HEAD/m)?.[1] ?? null } catch { /* an unreachable remote fails at the push, with its own message */ }
  branch === defaultBranch && fail(`"${branch}" is the default branch of the repository; story-loop publishes a story to its own branch`)
  let gpgsign = ''
  try { gpgsign = git('config', '--type=bool', '--get', 'commit.gpgsign') } catch {}
  if (gpgsign === 'true') {
    // Every commit this push adds, not just the tip; what the remote already has is not ours to judge.
    // N is no signature, B a bad one, R a revoked key. An unverifiable one (E, no public key here) is still signed.
    const unsigned = git('log', '--format=%h %G?', sha, '--not', `--remotes=${remote}`).split('\n').filter(line => /\s[NBR]$/.test(line))
    unsigned.length && fail(`not signed or badly signed, but this repo signs commits: ${unsigned.map(l => l.split(' ')[0]).join(', ')}`)
  }

  const ref = `refs/heads/${branch}`
  // Always the push URL: the remote's name would read the fetch URL, which may be another repository.
  const remoteSha = () => git('ls-remote', url, ref).split(/\s/)[0] || null
  const started = Date.now()
  // Every state this push goes through is the run's that started it. If that run ended or went
  // back to build meanwhile, the push may still have reached the remote: that outcome is kept
  // under stale/ for the human to reconcile, and no other run takes it for its own.
  const set = (patch, extra = {}) => opUpdate(root, ctx, r => ({ ...r, ...extra, pushed: patch.state === 'attempted' ? patch : { ...r.pushed, ...patch } }),
    { ...patch, sha, branch, ref, repo: remoteRepo(url), note: 'check the remote branch by hand: the push may have landed' })
  const said = (outcome, more = {}) => record(root, 'publish', { outcome, repo: remoteRepo(url), destination: redact(url), ref, commit: sha, elapsed_ms: Date.now() - started, ...more })
  // The target is on record before the first write to the remote.
  const before = (() => { try { return remoteSha() } catch { return undefined } })()
  set({ state: 'attempted', stage: ctx.stage, sha, branch, ref, repo: remoteRepo(url), remote_url: urls[0], remote_before: before ?? null, at: new Date().toISOString() })
  // An earlier attempt may have landed after its answer was lost: then there is nothing to push.
  if (before !== sha) {
    try {
      // Explicit refspec: push.default, configured push refspecs and followTags play no part.
      execFileSync('git', ['-c', 'push.followTags=false', 'push', '--no-follow-tags', '--porcelain', url, `${sha}:${ref}`],
        { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      let landed = null
      try { landed = remoteSha() } catch {}
      const state = landed === sha ? 'confirmed' : 'failed'
      if (state === 'failed') {
        const message = redact(String(error.stderr || error.message).trim())
        said('failed', { reason: message.slice(0, 500), remote_before: before ?? null, remote_after: landed })
        set({ state, error: message.slice(0, 500) })
        fail(`push failed: ${message}`)
      }
    }
  }
  let landed = null
  try { landed = remoteSha() } catch (error) {
    said('uncertain', { reason: error.message, remote_before: before ?? null })
    set({ state: 'uncertain' })
    fail(`pushed, but the remote could not be read back (${error.message}); run publish.mjs again to reconcile`)
  }
  if (landed !== sha) {
    said('mismatch', { remote_before: before ?? null, remote_after: landed })
    set({ state: 'mismatch', remote_sha: landed })
    fail(`the remote ${branch} is at ${landed?.slice(0, 7) ?? 'nothing'}, not ${sha.slice(0, 7)}; someone else pushed. Reconcile by hand; story-loop never forces`)
  }
  // A push by URL leaves the tracking ref alone; move it so git status and the next signing check see the push.
  try { git('update-ref', `refs/remotes/${remote}/${branch}`, sha); git('branch', `--set-upstream-to=${remote}/${branch}`) } catch { /* cosmetic */ }
  said(before === sha ? 'reconciled' : 'confirmed', { remote_before: before ?? null, remote_after: landed })
  set({ state: 'confirmed' }, { remote_url: run.remote_url ?? urls[0] })
  emit(root, { kind: 'note', text: `published ${sha.slice(0, 7)} to ${branch}` })
  return sha
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const root = findRoot() ?? fail('no active story-loop run here')
    console.log(`published ${publish(root)}`)
  } catch (error) { console.error(`publish: ${error.message}`); process.exit(1) }
}
