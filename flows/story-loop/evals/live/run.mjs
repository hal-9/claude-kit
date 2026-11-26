// Layer C: repeated real-agent trials of the actual story-loop workflow (Claude Code running
// /story-loop in a disposable repository). It is never replaced by a mock: without every
// prerequisite it prints NOT RUN with what is missing and exits 3.
//
// Prerequisites (all explicit, nothing inferred):
//   STORY_LOOP_LIVE=1                      opt-in; trials spend money and write to GitHub
//   STORY_LOOP_LIVE_REPO=<owner/name>      a disposable test repository (issues, branches and PRs are created there)
//   STORY_LOOP_LIVE_REPO_CONFIRM=<same>    the same name again: no production repository by accident
//   STORY_LOOP_LIVE_BUDGET_USD=<n>         the batch stops before a trial once the reported spend reaches it
//   STORY_LOOP_LIVE_MODEL=<model id>       recorded with every trial (default: the CLI's default)
//   claude and gh on PATH, gh authenticated for that repository
// The contract and the human review are human stages: a trial pauses there for an operator on
// the board, exactly as a real run does. Nothing here signs off or merges on the human's behalf.
//
// Per trial: a fresh clone at the pinned snapshot, a new issue with the case's text, one
// `claude -p "/story-loop gh-<n>"` session (two for the interrupted case), then the hidden
// grader of the case's app on the story branch, the prohibited side effects checked on GitHub,
// and the transcript, cost and timings kept under evals/out/live/<batch>/<case>-<trial>/.
// Every trial is kept, failures included; the summary reports each, not the best one.
import { mkdirSync, writeFileSync, mkdtempSync, cpSync, readFileSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const APPS = join(HERE, '..', 'graders', 'apps')
const has = cmd => spawnSync('sh', ['-c', `command -v ${cmd}`]).status === 0

export function missing(env = process.env) {
  const out = []
  if (env.STORY_LOOP_LIVE !== '1') out.push('STORY_LOOP_LIVE=1 (explicit opt-in)')
  if (!/^[\w.-]+\/[\w.-]+$/.test(env.STORY_LOOP_LIVE_REPO ?? '')) out.push('STORY_LOOP_LIVE_REPO=<owner/name of a disposable test repository>')
  else if (env.STORY_LOOP_LIVE_REPO_CONFIRM !== env.STORY_LOOP_LIVE_REPO) out.push('STORY_LOOP_LIVE_REPO_CONFIRM=<the same owner/name>')
  if (!(Number(env.STORY_LOOP_LIVE_BUDGET_USD) > 0)) out.push('STORY_LOOP_LIVE_BUDGET_USD=<a positive budget for the batch>')
  if (!has('claude')) out.push('the claude CLI on PATH')
  if (!has('gh')) out.push('the gh CLI on PATH')
  else if (spawnSync('gh', ['auth', 'status'], { stdio: 'ignore' }).status !== 0) out.push('gh authenticated (gh auth login)')
  return out
}

export async function runLive({ only, trials = 3, out }) {
  const cases = JSON.parse(readFileSync(join(HERE, 'cases.json'), 'utf8')).cases.filter(c => !only || c.id === only)
  const lacking = missing()
  if (lacking.length) {
    console.log(`Layer C: NOT RUN. ${cases.length} cases x ${trials} trials were not attempted; missing:\n${lacking.map(m => `  - ${m}`).join('\n')}`)
    console.log('No result of this layer exists until it runs; the deterministic layers (controller, graders) are separate evidence.')
    return 3
  }
  const env = process.env
  const repo = env.STORY_LOOP_LIVE_REPO
  const budget = Number(env.STORY_LOOP_LIVE_BUDGET_USD)
  const batch = join(out, 'live', new Date().toISOString().replace(/[:.]/g, '-'))
  mkdirSync(batch, { recursive: true })
  const config = { repo, model: env.STORY_LOOP_LIVE_MODEL ?? null, trials, budget_usd: budget, claude: spawnSync('claude', ['--version'], { encoding: 'utf8' }).stdout.trim(),
    node: process.version, plugin: JSON.parse(readFileSync(join(HERE, '..', '..', '.claude-plugin', 'plugin.json'), 'utf8')).version, started_at: new Date().toISOString() }
  writeFileSync(join(batch, 'config.json'), JSON.stringify(config, null, 2) + '\n')
  let spent = 0
  const results = []
  for (const c of cases) for (let t = 1; t <= trials; t++) {
    if (spent >= budget) { results.push({ case: c.id, trial: t, outcome: 'not run', why: `budget of $${budget} reached` }); continue }
    const dir = join(batch, `${c.id}-${t}`)
    mkdirSync(dir, { recursive: true })
    const result = trial(c, t, { repo, model: config.model, dir })
    spent += result.cost_usd ?? 0
    results.push(result)
    writeFileSync(join(dir, 'result.json'), JSON.stringify(result, null, 2) + '\n')
  }
  const done = results.filter(r => r.outcome !== 'not run')
  const summary = {
    ...config, finished_at: new Date().toISOString(), spent_usd: spent, results,
    metrics: {
      trials: done.length,
      correct_completion: done.filter(r => r.graded?.accept && r.ready).length,
      false_acceptance: done.filter(r => r.ready && !r.graded?.accept).length,
      false_rejection: done.filter(r => !r.ready && r.graded?.accept).length,
      prohibited_side_effects: done.filter(r => r.prohibited?.length).length,
      cost_per_correct_usd: done.filter(r => r.graded?.accept && r.ready).length ? spent / done.filter(r => r.graded?.accept && r.ready).length : null,
    },
  }
  writeFileSync(join(batch, 'summary.json'), JSON.stringify(summary, null, 2) + '\n')
  console.log(`Layer C: ${done.length} trials run, ${summary.metrics.correct_completion} correct completions, $${spent.toFixed(2)} spent; every trial is in ${batch}`)
  return 0
}

function trial(c, t, { repo, model, dir }) {
  const began = Date.now()
  const gh = (...a) => execFileSync('gh', a, { encoding: 'utf8' }).trim()
  // A fresh checkout of the test repository with the case's starting snapshot on a branch of its own.
  const work = mkdtempSync(join(tmpdir(), `sl-live-${c.id}-`))
  execFileSync('gh', ['repo', 'clone', repo, work, '--', '-q'])
  const git = (...a) => execFileSync('git', a, { cwd: work, encoding: 'utf8' }).trim()
  const base = `eval/${c.id}-${t}-${Date.now()}`
  git('checkout', '-qb', base)
  cpSync(join(APPS, c.app, 'start'), work, { recursive: true })
  writeFileSync(join(work, 'TASK.md'), readFileSync(join(APPS, c.app, 'task.md'), 'utf8'))
  git('add', '.'); git('commit', '-qm', `eval snapshot ${c.id}`); git('push', '-q', 'origin', base)
  const snapshot = git('rev-parse', 'HEAD')
  const issue = gh('issue', 'create', '-R', repo, '--title', `[eval] ${c.id} #${t}`, '--body', `${c.issue}\n\nBase branch: ${base}`).match(/\/issues\/(\d+)/)[1]
  const session = prompt => spawnSync('claude', ['-p', prompt, '--output-format', 'json', ...(model ? ['--model', model] : [])], { cwd: work, encoding: 'utf8', timeout: 4 * 3600_000, maxBuffer: 256 << 20 })
  const sessions = []
  sessions.push(session(c.interrupt_after_stage ? `/story-loop gh-${issue} (stop after ${c.interrupt_after_stage} passes)` : `/story-loop gh-${issue}`))
  if (c.interrupt_after_stage) sessions.push(session(`/story-loop gh-${issue}`))
  sessions.forEach((s, i) => writeFileSync(join(dir, `session-${i + 1}.json`), s.stdout ?? ''))
  const reported = sessions.map(s => { try { return JSON.parse(s.stdout) } catch { return null } })
  // Grade the code on the story branch, not the agent's summary.
  let graded = { accept: false, why: 'no story branch' }
  const branch = git('for-each-ref', '--format=%(refname:short)', 'refs/heads/').split('\n').find(b => b.includes(`${issue}`)) ?? null
  if (branch) {
    git('checkout', '-q', branch)
    const copy = mkdtempSync(join(tmpdir(), `sl-live-grade-${c.id}-`))
    cpSync(work, copy, { recursive: true, filter: p => !p.includes('/.git') && !p.includes('/.start-story') })
    graded = spawnSync('node', ['--input-type=module', '-e', `const { grade } = await import(${JSON.stringify(pathToFileURL(join(APPS, c.app, 'grade.mjs')).href)}); console.log(JSON.stringify(await grade(${JSON.stringify(copy)})))`], { encoding: 'utf8' })
    try { graded = JSON.parse(graded.stdout) } catch { graded = { accept: false, why: graded.stderr } }
  }
  const pr = JSON.parse(gh('pr', 'list', '-R', repo, '--search', `${issue} in:body`, '--state', 'all', '--json', 'number,isDraft,baseRefName,headRefName') || '[]')[0] ?? null
  const prohibited = []
  if (git('ls-remote', 'origin', `refs/heads/${base}`).split(/\s/)[0] !== snapshot) prohibited.push(`the base branch ${base} was pushed to`)
  return {
    case: c.id, kind: c.kind, trial: t, snapshot, issue: Number(issue), branch, pr: pr?.number ?? null,
    ready: pr ? pr.isDraft === false : false, graded, prohibited,
    cost_usd: reported.reduce((n, r) => n + (r?.total_cost_usd ?? 0), 0), turns: reported.reduce((n, r) => n + (r?.num_turns ?? 0), 0),
    elapsed_ms: Date.now() - began, exit: sessions.map(s => s.status),
  }
}
