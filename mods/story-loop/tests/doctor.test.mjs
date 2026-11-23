import { test } from 'node:test'
import assert from 'node:assert/strict'
import { diagnose, render } from '../skills/story-loop/scripts/doctor.mjs'

// A machine where everything is set up; each test breaks one thing.
const healthy = (over = {}) => ({
  cwd: '/repo',
  exists: file => !over.missing?.some(part => file.includes(part)),
  run(cmd, args) {
    const key = `${cmd} ${args.join(' ')}`
    if (over.run?.[key]) return over.run[key]
    if (key === 'short --version') return { ok: true, out: '5.0.0\n' }
    if (key === 'git config --get commit.gpgsign') return { ok: true, out: 'true\n' }
    if (key === 'claude plugin list') return { ok: true, out: '  ❯ savvy-flow@claude-kit\n    Version: 1.2.0\n    Status: ✘ disabled\n\n  ❯ savvy-flow@claude-mods\n    Version: 1.3.0\n    Scope: user\n    Status: ✔ enabled\n' }
    if (args.includes('setup')) return { ok: true, out: JSON.stringify({ codex: { available: true, detail: 'codex-cli 0.166.0' }, auth: { loggedIn: true } }) }
    return { ok: true, out: '' }
  },
})
const statusOf = (results, name) => results.find(r => r.name.startsWith(name)).status

test('a set-up machine has no blockers', () => {
  const results = diagnose(healthy())
  assert.deepEqual(results.filter(r => r.status !== 'ok'), [])
  const text = render(results)
  assert.match(text, /No blockers\. Ready/)
})

test('each missing prerequisite is named with its fix', () => {
  const broken = diagnose(healthy({
    missing: ['start-story'],
    run: {
      'gh auth status': { ok: false, out: 'not logged in' },
      'claude plugin list': { ok: true, out: '  ❯ savvy-flow@claude-kit\n    Version: 1.2.0\n    Status: ✘ disabled\n' },
    },
  }))
  assert.equal(statusOf(broken, 'GitHub CLI'), 'blocker')
  assert.equal(statusOf(broken, 'start-story'), 'blocker')
  assert.match(render(broken), /✘ GitHub CLI signed in — not signed in\n {4}for: .*\n {4}fix: Run: gh auth login/)
  assert.match(render(broken), /2 blockers left/)

  const noLogin = diagnose(healthy({ run: { [`node ${process.env.HOME}/.claude/plugins/marketplaces/openai-codex/plugins/codex/scripts/codex-companion.mjs setup --json`]: { ok: true, out: JSON.stringify({ codex: { available: true }, auth: { loggedIn: false } }) } } }))
  assert.equal(statusOf(noLogin, 'A second model'), 'warning')

  const issues = diagnose({ ...healthy({ missing: ['start-story'], run: { 'short --version': { ok: false, out: '' } } }), source: 'github' })
  assert.deepEqual(issues.filter(r => r.status === 'blocker'), [])
})
