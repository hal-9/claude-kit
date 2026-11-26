// Disposable git repos for the tests: a checkout with a story branch and,
// when asked, a local bare remote standing in for GitHub.
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newRun, save, load, FRESH, subjectOf, runDir, REVIEW_SCHEMA } from '../skills/story-loop/scripts/loop.mjs'

// The publisher refuses any push URL that is not the run's GitHub repository. The
// tests publish to bare repositories on disk; only a local path is let through by this.
process.env.STORY_LOOP_LOCAL_REMOTE = '1'

export const B = 'feat/sc-1-thing'
// Where the browser tests in these tests: a local server from this checkout.
export const ENV = { url: 'http://127.0.0.1:3000', kind: 'local' }
// What every result row must say besides its verdict and screenshot.
export const META = { text: 'A reader sees the page.', url: 'http://127.0.0.1:3000/page', environment: ENV.url }

export function repo({ remote = false, branch = B } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sl-repo-'))
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 't@example.com'); git('config', 'user.name', 't'); git('config', 'commit.gpgsign', 'false')
  writeFileSync(join(dir, '.gitignore'), '.start-story/\n')
  writeFileSync(join(dir, 'a.txt'), 'one\n')
  git('add', '.'); git('commit', '-qm', 'base')
  let origin
  if (remote) {
    origin = mkdtempSync(join(tmpdir(), 'sl-origin-'))
    execFileSync('git', ['init', '-q', '--bare', origin])
    git('remote', 'add', 'origin', origin)
    git('push', '-q', 'origin', 'main')
  }
  git('checkout', '-qb', branch)
  const commit = (file = 'a.txt', text = String(Math.random())) => { writeFileSync(join(dir, file), text); git('add', file); git('commit', '-qm', `change ${file}`); return git('rev-parse', 'HEAD') }
  return { dir, git, origin, commit }
}

// The lane a contract records: how much planning and how large a diff was signed off.
export const LANE = { lane: 'standard', why: 'a page and its query; cheap to change later', hard: [], flag: false }

// A run in `dir`, with the fields a contract records.
export function withRun(dir, patch = {}) {
  mkdirSync(join(dir, '.start-story'), { recursive: true })
  const run = { ...newRun('sc-1'), title: 'Thing', branch: B, pr: 7, base: 'main', repo: 'acme/app', checks: [], lane: LANE, ...patch }
  save(dir, run)
  return run
}

// The smallest valid PNG (1x1), padded past the size floor.
export const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4a20000000049454e44ae426082', 'hex')])

// Controlled fixture evidence: valid results for every evidence gate, for the code that is
// HEAD now (its tree and the merge base of its diff). Not a live run: a stand-in for
// quality.mjs, mutate.mjs, a browser and a reviewer, so publication tests start from green.
// verify is recorded as skipped on the human's word (no browser in these tests).
export function greenEvidence(run, dir) {
  const { tree, commit, merge_base } = subjectOf(dir, run)
  run.evidence = { ...run.evidence,
    quality: { tree, commit, merge_base, base: 'main', lint: [{ command: 'true', exit: 0, output: '' }], no_lint: null, flags: {}, dispositions: {} },
    mutants: { tree, merge_base, base: merge_base, lane: run.lane?.lane ?? 'standard', scope: [], covered: [], outcomes: { 'x.js:1:aaaaaa': 'killed' }, dispositions: {} } }
  const request = { id: `fixture-${String(tree).slice(0, 8)}`, attempt: run.stages.second_review.attempt ?? 1, tree, commit, merge_base }
  const file = join(runDir(dir, run), 'reviews', `${request.id}.json`)
  mkdirSync(join(runDir(dir, run), 'reviews'), { recursive: true })
  const text = JSON.stringify({ schema: REVIEW_SCHEMA, request: request.id, reviewer: 'fixture', angles: [{ angle: 'standards', status: 'complete', findings: [] }] })
  writeFileSync(file, text)
  const review = { reviewer: 'fixture', request: request.id, attempt: request.attempt, tree, commit, sha256: createHash('sha256').update(text).digest('hex'), output: file, structured: true, angles: { standards: 'complete' }, sources: [] }
  run.reviews = [...(run.reviews ?? []), review]
  run.review = review
  run.stages.second_review.request = request
  for (const id of FRESH) run.stages[id].tree = tree
  if (run.stages.verify.status === 'passed') run.stages.verify = { ...run.stages.verify, status: 'skipped', reason: 'human: no browser in this fixture' }
  return run
}
// Marks the review stages as having covered the code that is HEAD now, with fixture evidence.
export function reviewed(dir) {
  save(dir, greenEvidence(load(dir), dir))
}
