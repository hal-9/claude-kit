// The publisher against real git and local bare remotes, never a real GitHub.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { publish } from '../skills/story-loop/scripts/publish.mjs'
import { load, update } from '../skills/story-loop/scripts/loop.mjs'
import { repo, withRun, B } from './helpers.mjs'

const atPush = dir => update(dir, r => {
  r.stages.contract.status = 'passed'; r.stages.build.status = 'passed'; r.stages.test_review.status = 'passed'
  r.stages.verify.status = 'passed'; r.stages.second_review.status = 'passed'; r.stages.push.status = 'running'
  return r
})
const remoteRef = (origin, ref) => { try { return execFileSync('git', ['rev-parse', ref], { cwd: origin, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch { return null } }

test('publishes exactly the story branch, even under push.default=matching and followTags', () => {
  const { dir, git, origin, commit } = repo({ remote: true })
  withRun(dir); atPush(dir)
  const mainBefore = remoteRef(origin, 'main')
  git('checkout', '-q', 'main'); commit('m.txt', 'local main work'); git('checkout', '-q', B)
  git('config', 'push.default', 'matching'); git('config', 'push.followTags', 'true')
  const sha = commit()
  git('tag', '-a', 'v9', '-m', 'an annotated tag on the published commit')
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
  commit()
  publish(dir)
  // someone else pushes to the story branch
  const other = mkdtempSync(join(tmpdir(), 'sl-other-'))
  execFileSync('git', ['clone', '-q', '-b', B, origin, other])
  execFileSync('git', ['-c', 'user.email=o@x', '-c', 'user.name=o', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'theirs'], { cwd: other })
  execFileSync('git', ['push', '-q', 'origin', B], { cwd: other })
  const theirs = remoteRef(origin, `refs/heads/${B}`)
  commit()
  assert.throws(() => publish(dir), /push failed/)
  assert.equal(remoteRef(origin, `refs/heads/${B}`), theirs)
  assert.equal(load(dir).pushed.state, 'failed')
  assert.ok(git('rev-parse', 'HEAD') !== theirs)
})

test('a push that landed before its answer was lost is reconciled, not repeated', () => {
  const { dir, git, origin, commit } = repo({ remote: true })
  withRun(dir); atPush(dir)
  const sha = commit()
  git('push', '-q', 'origin', `${sha}:refs/heads/${B}`) // the "lost" earlier attempt
  update(dir, r => ({ ...r, pushed: { state: 'uncertain', sha } }))
  assert.equal(publish(dir), sha)
  assert.equal(load(dir).pushed.state, 'confirmed')
  assert.equal(remoteRef(origin, `refs/heads/${B}`), sha)
})

test('refuses an unsigned commit where the repo signs commits', () => {
  const { dir, git, commit } = repo({ remote: true })
  withRun(dir); atPush(dir)
  commit()
  git('config', 'commit.gpgsign', 'true')
  assert.throws(() => publish(dir), /not signed/)
})
