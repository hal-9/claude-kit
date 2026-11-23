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
import { findRoot, load, update, emit, current, gitIn, dirty, staleStages } from './loop.mjs'

const fail = message => { throw new Error(message) }
const STAGES = ['contract', 'push']

export function publish(root) {
  const git = gitIn(root)
  const run = load(root)
  STAGES.includes(current(run)) || fail(`publishing happens in ${STAGES.join(' or ')}; the run is at ${current(run) ?? 'its end'}`)
  const branch = run.branch ?? fail('record the story branch first (loop.mjs put branch <branch>)')
  const onBranch = git('rev-parse', '--abbrev-ref', 'HEAD')
  onBranch === branch || fail(`the checkout is on "${onBranch}", not the story branch "${branch}"`)
  dirty(root) && fail('the checkout has uncommitted changes; commit them first')
  const sha = git('rev-parse', 'HEAD') // frozen: whatever moves HEAD from here on is not published
  // The contract push opens the draft PR before any review exists; the push stage publishes reviewed code only.
  if (current(run) === 'push') {
    const stale = staleStages(root, run, git('rev-parse', `${sha}^{tree}`))
    stale.length && fail(`${stale.join(', ')} covered older code than ${sha.slice(0, 7)}; nothing was pushed. Go back to build so they run on this code`)
  }

  const remote = run.remote ?? 'origin'
  const urls = git('remote', 'get-url', '--push', '--all', remote).split('\n').filter(Boolean)
  urls.length === 1 || fail(`remote "${remote}" pushes to ${urls.length} URLs; story-loop publishes to exactly one`)
  let mirror = ''
  try { mirror = git('config', '--get', `remote.${remote}.mirror`) } catch {}
  mirror === 'true' && fail(`remote "${remote}" is a mirror remote; it would push every ref`)
  run.remote_url && run.remote_url !== urls[0] && fail(`remote "${remote}" now points at ${urls[0]}, not ${run.remote_url} as when the run first published`)
  const url = urls[0]
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
  update(root, r => ({ ...r, pushed: { state: 'attempted', sha, branch, remote_url: urls[0], at: new Date().toISOString() } }))
  // An earlier attempt may have landed after its answer was lost: then there is nothing to push.
  if (remoteSha() !== sha) {
    try {
      // Explicit refspec: push.default, configured push refspecs and followTags play no part.
      execFileSync('git', ['-c', 'push.followTags=false', 'push', '--no-follow-tags', '--porcelain', url, `${sha}:${ref}`],
        { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      let landed = null
      try { landed = remoteSha() } catch {}
      const state = landed === sha ? 'confirmed' : 'failed'
      if (state === 'failed') {
        update(root, r => ({ ...r, pushed: { ...r.pushed, state, error: String(error.stderr || error.message).trim().slice(0, 500) } }))
        fail(`push failed: ${String(error.stderr || error.message).trim()}`)
      }
    }
  }
  let landed = null
  try { landed = remoteSha() } catch (error) {
    update(root, r => ({ ...r, pushed: { ...r.pushed, state: 'uncertain' } }))
    fail(`pushed, but the remote could not be read back (${error.message}); run publish.mjs again to reconcile`)
  }
  if (landed !== sha) {
    update(root, r => ({ ...r, pushed: { ...r.pushed, state: 'mismatch', remote_sha: landed } }))
    fail(`the remote ${branch} is at ${landed?.slice(0, 7) ?? 'nothing'}, not ${sha.slice(0, 7)}; someone else pushed. Reconcile by hand; story-loop never forces`)
  }
  // A push by URL leaves the tracking ref alone; move it so git status and the next signing check see the push.
  try { git('update-ref', `refs/remotes/${remote}/${branch}`, sha); git('branch', `--set-upstream-to=${remote}/${branch}`) } catch { /* cosmetic */ }
  update(root, r => ({ ...r, remote_url: r.remote_url ?? urls[0], pushed: { ...r.pushed, state: 'confirmed' } }))
  emit(root, { kind: 'note', text: `published ${sha.slice(0, 7)} to ${branch}` })
  return sha
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const root = findRoot() ?? fail('no active story-loop run here')
    console.log(`published ${publish(root)}`)
  } catch (error) { console.error(`publish: ${error.message}`); process.exit(1) }
}
