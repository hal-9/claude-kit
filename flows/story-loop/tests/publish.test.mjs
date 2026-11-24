// The publisher against real git and local bare remotes, never a real GitHub.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { publish, destinationProblem } from '../skills/story-loop/scripts/publish.mjs'
import { load, update } from '../skills/story-loop/scripts/loop.mjs'
import { repo, withRun, reviewed, B } from './helpers.mjs'

// The push stage, with the reviews having covered the code that is HEAD now.
const atPush = dir => {
  update(dir, r => {
    r.stages.contract.status = 'passed'; r.stages.build.status = 'passed'; r.stages.test_review.status = 'passed'
    r.stages.verify.status = 'passed'; r.stages.second_review.status = 'passed'; r.stages.push.status = 'running'
    return r
  })
  reviewed(dir)
}
const remoteRef = (origin, ref) => { try { return execFileSync('git', ['rev-parse', ref], { cwd: origin, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch { return null } }

test('publishes exactly the story branch, even under push.default=matching and followTags', () => {
  const { dir, git, origin, commit } = repo({ remote: true })
  withRun(dir); atPush(dir)
  const mainBefore = remoteRef(origin, 'main')
  git('checkout', '-q', 'main'); commit('m.txt', 'local main work'); git('checkout', '-q', B)
  git('config', 'push.default', 'matching'); git('config', 'push.followTags', 'true')
  const sha = commit()
  git('tag', '-a', 'v9', '-m', 'an annotated tag on the published commit')
  reviewed(dir)
  assert.equal(publish(dir), sha)
  assert.equal(remoteRef(origin, `refs/heads/${B}`), sha)
  assert.equal(remoteRef(origin, 'main'), mainBefore)
  assert.equal(remoteRef(origin, 'refs/tags/v9'), null)
  const run = load(dir)
  assert.equal(run.pushed.state, 'confirmed')
  assert.equal(run.pushed.sha, sha)
})

test('refuses a dirty checkout, the wrong branch, and publishing outside contract or push', () => {
  const { dir, git } = repo({ remote: true })
  withRun(dir)
  update(dir, r => { r.stages.contract.status = 'passed'; r.stages.build.status = 'running'; return r })
  assert.throws(() => publish(dir), /publishing happens in contract or push/)
  atPush(dir)
  writeFileSync(join(dir, 'a.txt'), 'dirty')
  assert.throws(() => publish(dir), /uncommitted/)
  git('checkout', '-q', '--', 'a.txt')
  git('checkout', '-qb', 'other')
  assert.throws(() => publish(dir), /on "other", not the story branch/)
})

test('refuses remotes with several push URLs, mirror remotes, and a remote changed mid-run', () => {
  const { dir, git } = repo({ remote: true })
  withRun(dir); atPush(dir)
  const second = mkdtempSync(join(tmpdir(), 'sl-second-'))
  execFileSync('git', ['init', '-q', '--bare', second])
  const first = git('remote', 'get-url', 'origin')
  git('remote', 'set-url', '--add', '--push', 'origin', first)
  git('remote', 'set-url', '--add', '--push', 'origin', second)
  assert.throws(() => publish(dir), /pushes to 2 URLs/)
  git('config', '--unset-all', 'remote.origin.pushurl')
  git('config', 'remote.origin.mirror', 'true')
  assert.throws(() => publish(dir), /mirror remote/)
  git('config', '--unset', 'remote.origin.mirror')
  update(dir, r => ({ ...r, remote_url: '/somewhere/else' }))
  assert.throws(() => publish(dir), /now points at/)
})

test('a remote moved by someone else is a recorded mismatch, never forced', () => {
  const { dir, git, origin, commit } = repo({ remote: true })
  withRun(dir); atPush(dir)
  commit(); reviewed(dir)
  publish(dir)
  // someone else pushes to the story branch
  const other = mkdtempSync(join(tmpdir(), 'sl-other-'))
  execFileSync('git', ['clone', '-q', '-b', B, origin, other])
  execFileSync('git', ['-c', 'user.email=o@x', '-c', 'user.name=o', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'theirs'], { cwd: other })
  execFileSync('git', ['push', '-q', 'origin', B], { cwd: other })
  const theirs = remoteRef(origin, `refs/heads/${B}`)
  commit(); reviewed(dir)
  assert.throws(() => publish(dir), /push failed/)
  assert.equal(remoteRef(origin, `refs/heads/${B}`), theirs)
  assert.equal(load(dir).pushed.state, 'failed')
  assert.ok(git('rev-parse', 'HEAD') !== theirs)
})

test('a push that landed before its answer was lost is reconciled, not repeated', () => {
  const { dir, git, origin, commit } = repo({ remote: true })
  withRun(dir); atPush(dir)
  const sha = commit(); reviewed(dir)
  git('push', '-q', 'origin', `${sha}:refs/heads/${B}`) // the "lost" earlier attempt
  update(dir, r => ({ ...r, pushed: { state: 'uncertain', sha } }))
  assert.equal(publish(dir), sha)
  assert.equal(load(dir).pushed.state, 'confirmed')
  assert.equal(remoteRef(origin, `refs/heads/${B}`), sha)
})

test('refuses an unsigned commit where the repo signs commits', () => {
  const { dir, git, commit } = repo({ remote: true })
  withRun(dir); atPush(dir)
  commit(); reviewed(dir)
  git('config', 'commit.gpgsign', 'true')
  assert.throws(() => publish(dir), /not signed/)
})

test('H03: a commit made after the reviews is refused before anything reaches the remote', () => {
  const { dir, origin, commit } = repo({ remote: true })
  withRun(dir); atPush(dir)
  commit() // new code no review covered
  assert.throws(() => publish(dir), /test_review, verify, second_review covered older code.*nothing was pushed/)
  assert.equal(remoteRef(origin, `refs/heads/${B}`), null)
  assert.equal(load(dir).pushed, undefined)
  // the contract push opens the draft PR before any review exists
  const fresh = repo({ remote: true })
  withRun(fresh.dir)
  update(fresh.dir, r => { r.stages.contract.status = 'running'; return r })
  assert.equal(publish(fresh.dir), fresh.git('rev-parse', 'HEAD'))
})

test('H05: with separate fetch and push URLs, the push URL is what gets pushed to and read back', () => {
  const { dir, git, origin, commit } = repo({ remote: true })
  withRun(dir); atPush(dir)
  const sha = commit(); reviewed(dir)
  git('push', '-q', 'origin', `${sha}:refs/heads/${B}`) // the fetch URL already has the commit
  const pushRepo = mkdtempSync(join(tmpdir(), 'sl-pushurl-'))
  execFileSync('git', ['init', '-q', '--bare', pushRepo])
  git('remote', 'set-url', '--push', 'origin', pushRepo)
  assert.equal(publish(dir), sha)
  assert.equal(remoteRef(pushRepo, `refs/heads/${B}`), sha)
  assert.equal(load(dir).pushed.remote_url, pushRepo)
  assert.equal(remoteRef(origin, 'main'), git('rev-parse', 'main'))
})

// ---- regressions from the 0.8.0 review -------------------------------------------

test('R4: the push URL must be the run\'s repository, in any GitHub spelling; anything else is refused', () => {
  const run = { repo: 'acme/app' }
  for (const url of ['git@github.com:acme/app.git', 'git@github.com:Acme/App', 'ssh://git@github.com/acme/app.git', 'https://github.com/acme/app',
    'https://github.com/acme/app.git', 'https://github.com/acme/app/', 'https://x-access-token:s3cr3t@github.com/acme/app.git'])
    assert.equal(destinationProblem(run, url), null, url)
  for (const url of ['git@github.com:someone/app.git', 'https://github.com/acme/app-fork.git', 'https://github.com/acme/other'])
    assert.match(destinationProblem(run, url), /this run belongs to acme\/app, but the remote pushes to .*nothing was pushed/, url)
  for (const url of ['https://gitlab.com/acme/app.git', 'git@work-alias:acme/app.git', 'ssh://git@github.com:22/acme/app.git'])
    assert.match(destinationProblem(run, url), /not a GitHub repository story-loop can identify/, url)
  assert.match(destinationProblem({ repo: null }, 'git@github.com:acme/app.git'), /no repository recorded/)
  assert.doesNotMatch(destinationProblem(run, 'https://user:s3cr3t@example.com/acme/app.git'), /s3cr3t/, 'a credential in the URL is not repeated')
  // a path on disk is for these tests only: without the switch it is refused like any unknown host
  delete process.env.STORY_LOOP_LOCAL_REMOTE
  try { assert.match(destinationProblem(run, '/tmp/some/bare.git'), /not a GitHub repository/) } finally { process.env.STORY_LOOP_LOCAL_REMOTE = '1' }
})

test('R4: a fetch URL of the run\'s repository does not excuse a push URL of another; nothing is pushed', () => {
  const { dir, git, origin, commit } = repo({ remote: true })
  withRun(dir); atPush(dir)
  commit(); reviewed(dir)
  // the reviewed probe: the run names repository A, origin fetches from A and pushes to B
  const elsewhere = mkdtempSync(join(tmpdir(), 'sl-b-'))
  execFileSync('git', ['init', '-q', '--bare', elsewhere])
  git('remote', 'set-url', 'origin', 'git@github.com:acme/app.git')
  git('remote', 'set-url', '--push', 'origin', 'https://github.com/someone-else/app.git')
  assert.throws(() => publish(dir), /this run belongs to acme\/app, but the remote pushes to someone-else\/app; nothing was pushed/)
  assert.equal(load(dir).pushed, undefined, 'refused before the first write, local or remote')
  assert.equal(remoteRef(origin, `refs/heads/${B}`), null)
  assert.equal(remoteRef(elsewhere, `refs/heads/${B}`), null)
})

test('R4: a story is never published to its base or to the default branch, and the base is recorded first', () => {
  // the reviewed probe: branch and base are both main, with main checked out
  const onMain = repo({ remote: true, branch: 'side' })
  onMain.git('checkout', '-q', 'main')
  withRun(onMain.dir, { branch: 'main', base: 'main' })
  update(onMain.dir, r => { r.stages.contract.status = 'running'; return r })
  const before = remoteRef(onMain.origin, 'main')
  onMain.commit()
  assert.throws(() => publish(onMain.dir), /the story branch "main" is the base branch/)
  assert.equal(remoteRef(onMain.origin, 'main'), before, 'main was not updated')
  // base is another branch, but the story branch is the repository's default
  execFileSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: onMain.origin })
  update(onMain.dir, r => ({ ...r, base: 'release' }))
  assert.throws(() => publish(onMain.dir), /"main" is the default branch of the repository/)
  assert.equal(remoteRef(onMain.origin, 'main'), before)
  assert.equal(load(onMain.dir).pushed, undefined)
  // no base on record: nothing says what the story branch must not be
  const fresh = repo({ remote: true })
  withRun(fresh.dir, { base: undefined })
  update(fresh.dir, r => { r.stages.contract.status = 'running'; return r })
  assert.throws(() => publish(fresh.dir), /record the base branch before the first publish/)
  update(fresh.dir, r => ({ ...r, base: 'origin/main' }))
  // an ordinary feature branch still publishes, and the target is on record
  const sha = publish(fresh.dir)
  const pushed = load(fresh.dir).pushed
  assert.deepEqual([pushed.state, pushed.sha, pushed.ref, pushed.remote_before], ['confirmed', sha, `refs/heads/${B}`, null])
  assert.equal(remoteRef(fresh.origin, `refs/heads/${B}`), sha)
  // a name git itself would refuse as a ref
  update(fresh.dir, r => ({ ...r, branch: 'feat/bad..name', pushed: undefined }))
  assert.throws(() => publish(fresh.dir), /is not a valid branch name/)
})

test('H21: every new commit must be signed, not just the tip; history already on the remote is left alone', t => {
  const { dir, git } = repo({ remote: true }) // the base commit on origin/main is unsigned
  const key = join(mkdtempSync(join(tmpdir(), 'sl-key-')), 'id')
  if (spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key]).status !== 0 || !existsSync(`${key}.pub`)) return t.skip('ssh-keygen is not available')
  const signers = `${key}.signers`
  writeFileSync(signers, `t@example.com ${execFileSync('cat', [`${key}.pub`], { encoding: 'utf8' })}`)
  git('config', 'gpg.format', 'ssh'); git('config', 'user.signingkey', `${key}.pub`); git('config', 'gpg.ssh.allowedSignersFile', signers)
  const add = (text, ...flags) => { writeFileSync(join(dir, 'a.txt'), text); git('commit', '-qam', text, ...flags); return git('rev-parse', '--short', 'HEAD') }
  withRun(dir)
  const signedOnly = add('signed work', '-S')
  git('config', 'commit.gpgsign', 'yes') // every spelling git accepts as true
  atPush(dir)
  assert.equal(publish(dir), git('rev-parse', 'HEAD'), `signed commit ${signedOnly} over unsigned legacy history publishes`)
  const unsigned = add('unsigned work', '--no-gpg-sign')
  add('signed tip', '-S')
  reviewed(dir)
  const before = git('ls-remote', 'origin', `refs/heads/${B}`)
  assert.throws(() => publish(dir), new RegExp(`not signed or badly signed.*${unsigned}`))
  assert.equal(git('ls-remote', 'origin', `refs/heads/${B}`), before)
})
