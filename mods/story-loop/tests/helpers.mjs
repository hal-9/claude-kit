// Disposable git repos for the tests: a checkout with a story branch and,
// when asked, a local bare remote standing in for GitHub.
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newRun, save, load, FRESH } from '../skills/story-loop/scripts/loop.mjs'

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

// A run in `dir`, with the fields a contract records.
export function withRun(dir, patch = {}) {
  mkdirSync(join(dir, '.start-story'), { recursive: true })
  const run = { ...newRun('sc-1'), title: 'Thing', branch: B, pr: 7, base: 'main', repo: 'acme/app', checks: [], ...patch }
  save(dir, run)
  return run
}

// The smallest valid PNG (1x1), padded past the size floor.
export const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4a20000000049454e44ae426082', 'hex')])

// Marks the review stages as having covered the code that is HEAD now.
export function reviewed(dir) {
  const tree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: dir, encoding: 'utf8' }).trim()
  const run = load(dir)
  for (const id of FRESH) run.stages[id].tree = tree
  save(dir, run)
}
