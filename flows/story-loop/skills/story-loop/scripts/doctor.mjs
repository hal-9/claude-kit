#!/usr/bin/env node
// Checks everything story-loop needs before a run, and says how to fix what is
// missing.   node doctor.mjs [github] [--json]   (run from the target repo's root;
// `github` when stories are GitHub issues)
// Exit 1 when a blocker is left. It reads; it never installs or changes anything.
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const CODEX = join(homedir(), '.claude/plugins/marketplaces/openai-codex/plugins/codex/scripts/codex-companion.mjs')

// The real world, replaceable in tests.
export const system = {
  cwd: process.cwd(),
  // Where stories come from here: 'shortcut' (default) or 'github' (issues).
  source: process.argv.includes('github') ? 'github' : 'shortcut',
  run(cmd, args) {
    try { return { ok: true, out: execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 }) } }
    catch (error) { return { ok: false, out: `${error.stdout ?? ''}${error.stderr ?? ''}` } }
  },
  exists: existsSync,
}

const ok = detail => ({ status: 'ok', detail })
const blocker = (detail, fix) => ({ status: 'blocker', detail, fix })
const warning = (detail, fix) => ({ status: 'warning', detail, fix })

// Each check: what it is for, and a function of the system returning ok / blocker / warning.
export const CHECKS = [
  ['Node 20 or newer', 'runs every script of the loop', () => {
    const major = Number(process.versions.node.split('.')[0])
    return major >= 20 ? ok(`v${process.versions.node}`) : blocker(`v${process.versions.node}`, 'Install Node 20+ (for example: brew install node).')
  }],
  ['Inside a git repository', 'the loop works on a story branch of this repo', s =>
    s.run('git', ['rev-parse', '--show-toplevel']).ok ? ok() : blocker('not a git repository', 'cd into the repo the story belongs to and run this again.')],
  ['GitHub CLI signed in', 'opens the draft PR, pushes, requests the Copilot review, reads its comments', s => {
    if (!s.run('gh', ['--version']).ok) return blocker('gh is not installed', 'brew install gh, then: gh auth login')
    return s.run('gh', ['auth', 'status']).ok ? ok() : blocker('not signed in', 'Run: gh auth login')
  }],
  ['Shortcut CLI 5 or newer', 'start-story reads the story and moves the card', s => {
    if (s.source === 'github') return ok('not needed for GitHub issues')
    const version = s.run('short', ['--version'])
    if (!version.ok) return blocker('the `short` CLI is not installed', 'npm install -g @shortcut-cli/shortcut-cli, then: short install (it asks for your Shortcut API token).')
    return Number(version.out.trim().split('.')[0]) >= 5 ? ok(version.out.trim()) : blocker(`version ${version.out.trim()}`, 'npm install -g @shortcut-cli/shortcut-cli@latest')
  }],
  ['start-story skill in this repo', 'the contract stage for a Shortcut story: the signed-off contract and the draft PR', s =>
    s.source === 'github' ? ok('not needed for GitHub issues') : ['.claude', '.github', '.cursor', '.pi'].some(dir => s.exists(join(s.cwd, dir, 'skills/start-story/SKILL.md')))
      ? ok() : blocker('no start-story skill found', 'Sync the shared skills into this repo (ai-hub / agent-bridge), or run story-loop from a repo that has start-story.')],
  ['modern-web-guidance skill', 'build: front-end briefs carry current web-platform patterns; the hook refuses a worker brief naming HTML, CSS or client-side JS files until the skill has run', s =>
    [join(homedir(), '.claude'), ...['.claude', '.github', '.cursor', '.pi'].map(dir => join(s.cwd, dir))].some(dir => s.exists(join(dir, 'skills/modern-web-guidance/SKILL.md')))
      ? ok() : blocker('not installed for Claude Code (user or repo skills)', 'In a terminal: npx skills add GoogleChrome/modern-web-guidance   (pick Claude Code, global). It runs through npx, so it needs Node and network.')],
  ['.start-story/ is gitignored', 'run state, briefs and screenshots live there and must not reach the PR', s =>
    s.run('git', ['check-ignore', '-q', '.start-story/x']).ok ? ok() : blocker('not ignored', 'Add ".start-story/" to .gitignore (or to .git/info/exclude for yourself only).')],
  ['Commits can be signed', 'publish.mjs refuses unsigned commits where signing is switched on', s => {
    if (s.run('git', ['config', '--get', 'commit.gpgsign']).out.trim() !== 'true')
      return warning('commit.gpgsign is not true', 'If this repo requires signed commits: set up a key (see the repo\'s signed-commits guide), then git config commit.gpgsign true. Otherwise ignore this.')
    // Signs a throwaway commit object; no ref points at it and nothing leaves the machine.
    const probe = s.run('git', ['commit-tree', '-S', 'HEAD^{tree}', '-m', 'story-loop signing probe'])
    return probe.ok ? ok('a test signature worked') : blocker('signing is on, but signing a test commit failed', `Fix the signing setup (key, agent, pinentry): ${probe.out.trim().split('\n')[0] ?? ''}`)
  }],
  ['Claude CLI signed in on its own', 'the board\'s Explain this / Why here? / quiz start `claude -p`, which cannot borrow the desktop app\'s session', s => {
    let state = {}
    try { state = JSON.parse(s.run('claude', ['auth', 'status']).out) } catch {}
    return state.loggedIn ? ok(state.authMethod) : warning('`claude auth status` says not logged in', 'In a terminal run: claude auth login   (the board explanations fail with "OAuth session expired" until then; the run itself is unaffected).')
  }],
  ['Figma MCP connected', 'verify compares a page with the Figma frame its check names, and build reads sizes and colours from it', s => {
    const line = s.run('claude', ['mcp', 'list']).out.split('\n').find(l => /figma/i.test(l))
    const fix = 'In a terminal: claude mcp add --scope user --transport http figma https://mcp.figma.com/mcp, then sign in to Figma from /mcp in a session. ' +
      'Needed only for stories that link a Figma frame; a claude.ai Figma connector also works but this check cannot see it.'
    if (!line) return warning('no Figma MCP server configured', fix)
    return /connected/i.test(line) ? ok(line.trim()) : warning(`Figma MCP is not connected: ${line.trim()}`, fix)
  }],
  ['A second model for the review', 'second review: a reviewer from another vendor catches what Claude misses in its own work', s => {
    const fallback = 'Without it the second review still runs, by a fresh Claude on another model, which is weaker. '
    if (!s.exists(CODEX)) return warning('the openai-codex plugin is not installed', fallback + 'For Codex: /plugin marketplace add openai/codex-plugin-cc, /plugin install codex@openai-codex, then /codex:setup. Any other reviewer CLI can be named at sign-off.')
    const setup = s.run('node', [CODEX, 'setup', '--json'])
    let state = {}
    try { state = JSON.parse(setup.out) } catch {}
    if (!state.codex?.available) return warning('the codex CLI is missing', fallback + 'In Claude Code run /codex:setup; it installs the CLI.')
    return state.auth?.loggedIn ? ok(`Codex: ${state.codex.detail}`) : warning('Codex is not signed in', fallback + 'Run: codex login   (then /codex:setup to confirm).')
  }],
]

// What no script can see; the conductor checks the first two in the session and asks the human the rest.
export const CONFIRM = [
  ['The session runs on Opus', 'The conductor keeps the overview on Opus, delegates to Opus, Sonnet and Haiku workers, and asks a read-only Fable advisor at the contract, triage and retro. Switch with /model before starting; the hook refuses a run from another model when it can see it.'],
  ['A browser the agent can drive', 'Chrome with the Claude extension connected to this session, or the BrowserOS app running. The skill tests this itself (browser preflight).'],
  ['A test user the browser can be', 'For a local test server the verifier creates users itself. For a preview or staging site, sign in as a test user in that browser first, or save the test user\'s login in the browser: the agent does not type passwords on sites that are not local.'],
  ['Copilot code review on the repo', 'The Copilot review stage requests a review from Copilot. Check once that Copilot review is enabled for the repository (a past PR with a Copilot review is proof).'],
  ['The app boots in the test environment', 'Browser verify needs the app running locally with test data endpoints (for a Rails app: the server in the test environment on its own port, test database migrated).'],
]

export function diagnose(s = system) {
  return CHECKS.map(([name, why, check]) => {
    try { return { name, why, ...check(s) } } catch (error) { return { name, why, ...warning(`check failed: ${error.message}`, 'Run it by hand.') } }
  })
}

export function render(results) {
  const mark = { ok: '✔', blocker: '✘', warning: '!' }
  const lines = results.flatMap(r => [
    `${mark[r.status]} ${r.name}${r.detail ? ` — ${r.detail}` : ''}`,
    ...(r.status === 'ok' ? [] : [`    for: ${r.why}`, `    fix: ${r.fix}`]),
  ])
  const blockers = results.filter(r => r.status === 'blocker').length
  const warnings = results.filter(r => r.status === 'warning').length
  return [...lines, '',
    'Confirm yourself (no script can see these):',
    ...CONFIRM.map(([name, how]) => `? ${name}\n    ${how}`), '',
    blockers ? `${blockers} blocker${blockers > 1 ? 's' : ''} left; fix from the top and run this again.`
      : `No blockers${warnings ? `, ${warnings} warning${warnings > 1 ? 's' : ''}` : ''}. Ready for /story-loop SC-<id> once the points above hold.`,
  ].join('\n')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const results = diagnose()
  console.log(process.argv.includes('--json') ? JSON.stringify({ results, confirm: CONFIRM }) : render(results))
  process.exit(results.some(r => r.status === 'blocker') ? 1 : 0)
}
