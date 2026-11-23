#!/usr/bin/env node
// The one way a run publishes code: the current commit, frozen, to the story
// branch on the recorded remote, nothing else.   node publish.mjs
// Refuses force, tags, extra refs, a dirty checkout, the wrong branch, a remote
// with several or changed push URLs, and unsigned commits where signing is on.
// After the push it reads the remote back; a mismatch is recorded, never forced.
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findRoot, load, update, emit, current, gitIn, dirty } from './loop.mjs'

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

  const remote = run.remote ?? 'origin'
  const urls = git('remote', 'get-url', '--push', '--all', remote).split('\n').filter(Boolean)
  urls.length === 1 || fail(`remote "${remote}" pushes to ${urls.length} URLs; story-loop publishes to exactly one`)
  let mirror = ''
  try { mirror = git('config', '--get', `remote.${remote}.mirror`) } catch {}
  mirror === 'true' && fail(`remote "${remote}" is a mirror remote; it would push every ref`)
  run.remote_url && run.remote_url !== urls[0] && fail(`remote "${remote}" now points at ${urls[0]}, not ${run.remote_url} as when the run first published`)
  let gpgsign = ''
  try { gpgsign = git('config', '--get', 'commit.gpgsign') } catch {}
  if (gpgsign === 'true') git('log', '-1', '--format=%G?', sha) === 'N' && fail(`commit ${sha.slice(0, 7)} is not signed, but this repo signs commits`)

  const ref = `refs/heads/${branch}`
  const remoteSha = () => git('ls-remote', remote, ref).split(/\s/)[0] || null
  update(root, r => ({ ...r, pushed: { state: 'attempted', sha, branch, remote_url: urls[0], at: new Date().toISOString() } }))
  // An earlier attempt may have landed after its answer was lost: then there is nothing to push.
  if (remoteSha() !== sha) {
    try {
      // Explicit refspec: push.default, configured push refspecs and followTags play no part.
      execFileSync('git', ['-c', 'push.followTags=false', 'push', '--no-follow-tags', '--porcelain', remote, `${sha}:${ref}`],
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
  try { git('branch', `--set-upstream-to=${remote}/${branch}`) } catch { /* cosmetic */ }
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
