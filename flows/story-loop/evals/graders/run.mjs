// Layer B: evaluate the evaluators. Every case has a stated requirement, variants with known
// outcomes (a correct implementation, an alternate correct one, deliberately faulty ones) and an
// independent executable grader. A case gates only once its known-good variants are accepted:
// a grader that rejects everything never becomes a gate.
//
// Two kinds of case:
//   app cases (apps/<id>/)   behaviour a story asks for, graded by a hidden grader on the resulting
//                            state (disk, return values, the page reached), never on a self-report.
//                            Each variant is copied into a fresh directory first; the grader and the
//                            references stay here, outside any workspace an agent writes to.
//   loop cases (below)       story-loop's own evaluators (mutation attribution, CI identity, review
//                            accounting, diagnostic sanitization) run through their real helpers on
//                            fixtures whose truth is known.
import { readdirSync, readFileSync, mkdtempSync, cpSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const S = join(HERE, '..', '..', 'skills', 'story-loop', 'scripts')
process.env.STORY_LOOP_LOCAL_REMOTE = '1'

// ---- app cases -----------------------------------------------------------------------------
async function appCase(id) {
  const dir = join(HERE, 'apps', id)
  const meta = JSON.parse(readFileSync(join(dir, 'case.json'), 'utf8'))
  const { grade } = await import(pathToFileURL(join(dir, 'grade.mjs')))
  const variants = Object.entries(meta.variants).map(([variant, expected]) => [variant, expected, join(dir, 'variants', variant)])
  // The unchanged starting point is a faulty variant too: a grader must not pass it.
  try { readdirSync(join(dir, 'start')); variants.push(['start', 'reject', join(dir, 'start')]) } catch {}
  const out = []
  for (const [variant, expected, from] of variants) {
    const work = mkdtempSync(join(tmpdir(), `sl-grade-${id}-${variant}-`))
    cpSync(from, work, { recursive: true })
    let verdict, why
    try { const r = await grade(work); verdict = r.accept ? 'accept' : 'reject'; why = r.why ?? null } catch (error) { verdict = 'reject'; why = `grader error: ${error.message}` }
    out.push({ variant, expected, verdict, why })
  }
  return { id, category: meta.category, kind: 'app', variants: out }
}

// ---- loop cases ----------------------------------------------------------------------------
const run = (cwd, script, args, env = {}) => spawnSync('node', [join(S, script), ...args], { cwd, encoding: 'utf8', env: { ...process.env, ...env } })
function gitRepo(files, story) {
  const dir = mkdtempSync(join(tmpdir(), 'sl-gradeloop-'))
  const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 'e@e'); git('config', 'user.name', 'e'); git('config', 'commit.gpgsign', 'false')
  writeFileSync(join(dir, '.gitignore'), '.start-story/\n')
  for (const [f, t] of Object.entries(files)) writeFileSync(join(dir, f), t)
  git('add', '.'); git('commit', '-qm', 'base'); git('branch', 'base'); git('checkout', '-qb', 'feat/sc-1-grade')
  for (const [f, t] of Object.entries(story)) writeFileSync(join(dir, f), t)
  git('add', '.'); git('commit', '-qm', 'story')
  return { dir, git }
}
async function withRun(dir, patch = {}) {
  const L = await import(join(S, 'loop.mjs'))
  mkdirSync(join(dir, '.start-story'), { recursive: true })
  L.save(dir, { ...L.newRun('sc-1'), title: 'grade', branch: 'feat/sc-1-grade', pr: 7, base: 'base', repo: 'acme/app', checks: [], lane: { lane: 'standard', why: 'grade', hard: [], flag: false }, ...patch })
  return L
}

// Mutation evidence: does test review accept these mutants as behavioural evidence?
async function mutationCase() {
  const NODE = 'node --test --test-reporter=$STORY_LOOP_NODE_REPORTER --test-reporter-destination=$STORY_LOOP_REPORT t.test.mjs'
  const flag = join(mkdtempSync(join(tmpdir(), 'sl-grade-outage-')), 'once')
  const test = body => `import { test, before } from 'node:test'\nimport assert from 'node:assert'\nimport { existsSync, writeFileSync } from 'node:fs'\nimport * as m from './m.mjs'\n${body}\n`
  const fixtures = {
    'healthy': ['accept', { 'm.mjs': 'export const big = n => n > 10\n' }, test("test('big', () => { assert.equal(m.big(11), true); assert.equal(m.big(10), false) })")],
    'runtime-kill': ['accept', { 'm.mjs': "export const pick = o => o === null ? 'none' : o.name\n" }, test("test('pick', () => { assert.equal(m.pick(null), 'none'); assert.equal(m.pick({ name: 'a' }), 'a') })")],
    'dependency-outage': ['reject', { 'm.mjs': 'export const big = n => n > 10\n' }, test(`before(() => { if (existsSync(${JSON.stringify(flag)})) { const e = new Error('connect ECONNREFUSED 127.0.0.1:5432'); e.code = 'ECONNREFUSED'; throw e } writeFileSync(${JSON.stringify(flag)}, '') })\ntest('big', () => { assert.equal(m.big(11), true); assert.equal(m.big(5), false) })`)],
    // Only the guard line changes; its one mutant breaks loading, which is no behavioural kill.
    'collection-only': ['reject', { 'm.mjs': "export const ready = true\nif (!true) throw new Error('boot failed')\n" }, test("test('ready', () => assert.equal(m.ready, true))"), 'export const ready = true\n'],
  }
  const out = []
  for (const [variant, [expected, story, t, before = 'export const big = 0\n']] of Object.entries(fixtures)) {
    const { dir } = gitRepo({ 'm.mjs': before, 't.test.mjs': t }, story)
    const L = await withRun(dir)
    const r = run(dir, 'mutate.mjs', ['--test', NODE, 'm.mjs'])
    const m = L.load(dir).evidence?.mutants
    const problem = m ? L.mutantsProblem(m) : `mutate failed: ${r.stderr.trim().slice(0, 120)}`
    out.push({ variant, expected, verdict: problem ? 'reject' : 'accept', why: problem })
  }
  return { id: 'mutation-setup', category: 'mutation attribution', kind: 'loop', variants: out }
}

// Required CI: does the decision pass only on the expected producer's success?
async function ciCase() {
  const fake = mkdtempSync(join(tmpdir(), 'sl-grade-gh-'))
  const out = []
  const scenarios = {
    'expected-producer-green': ['accept', [{ app_id: 15368, conclusion: 'success' }]],
    'skipped-counts-as-success': ['accept', [{ app_id: 15368, conclusion: 'skipped' }]],
    'wrong-producer-green': ['reject', [{ app_id: 999, conclusion: 'success' }]],
    'expected-pending-wrong-green': ['reject', [{ app_id: 999, conclusion: 'success' }, { app_id: 15368, status: 'in_progress', conclusion: null, id: 5 }]],
    'expected-failing-rerun-green-elsewhere': ['reject', [{ app_id: 15368, conclusion: 'failure', id: 5 }, { app_id: 42, conclusion: 'success', id: 6 }]],
  }
  for (const [variant, [expected, runs]] of Object.entries(scenarios)) {
    const { dir, git } = gitRepo({ 'a.txt': '1\n' }, { 'b.txt': '2\n' })
    const head = git('rev-parse', 'HEAD')
    const L = await withRun(dir, { base: 'main', pushed: { state: 'confirmed', sha: head } })
    const rows = runs.map((c, i) => JSON.stringify({ type: 'check', name: 'required-ci', app_id: c.app_id, app: `app-${c.app_id}`, status: c.status ?? 'completed', conclusion: c.conclusion, id: c.id ?? i + 1, head_sha: head })).join('\n')
    const gh = join(fake, `gh-${variant}`)
    writeFileSync(gh, `#!/usr/bin/env node
const a = process.argv.slice(2).join(' ')
const pr = ${JSON.stringify(JSON.stringify({ headRefOid: head, headRefName: 'feat/sc-1-grade', baseRefName: 'main', isCrossRepository: false, state: 'OPEN', isDraft: false }))}
if (/pr view/.test(a)) { process.stdout.write(pr); process.exit(0) }
if (/protection\\/required_status_checks/.test(a)) { process.stdout.write(JSON.stringify({ name: 'required-ci', app_id: 15368 }) + '\\n'); process.exit(0) }
if (/rules\\/branches/.test(a)) process.exit(0)
if (/check-runs/.test(a)) { process.stdout.write(${JSON.stringify(rows + '\n')}); process.exit(0) }
if (/statuses/.test(a)) process.exit(0)
process.stderr.write('unexpected: ' + a); process.exit(1)
`)
    chmodSync(gh, 0o755)
    run(dir, 'github.mjs', ['ci'], { STORY_LOOP_GH: gh })
    const state = L.load(dir).ci?.state ?? 'error'
    out.push({ variant, expected, verdict: state === 'pass' ? 'accept' : 'reject', why: `CI decision: ${state}` })
  }
  return { id: 'ci-wrong-source', category: 'CI identity', kind: 'loop', variants: out }
}

// Review accounting: does the second review complete only when every finding is triaged?
async function reviewCase() {
  const out = []
  const BLOCKER = { id: 's1', severity: 'blocker', title: 'authorization bypass: any user can edit any order' }
  const scenarios = {
    'all-triaged': ['accept', [['codex', [{ angle: 'security', status: 'complete', findings: [BLOCKER] }]]], d => d.finding('r1', 'fixed', 'owner check', '--commit', 'abc1234')],
    'duplicates-mapped': ['accept', [['codex', [{ angle: 'security', status: 'complete', findings: [BLOCKER] }]], ['claude', [{ angle: 'standards', status: 'complete', findings: [{ ...BLOCKER, id: 'a1', severity: 'major' }] }]]],
      d => { d.finding('r1', 'fixed', 'owner check', '--commit', 'abc1234'); d.finding('r2', 'duplicate', '--of', 'r1') }],
    'blocker-dropped': ['reject', [['codex', [{ angle: 'security', status: 'complete', findings: [BLOCKER] }]]], d => d.update(r => ({ ...r, findings: [] }))],
    'angle-failed': ['reject', [['codex', [{ angle: 'security', status: 'failed', note: 'timeout', findings: [] }]]], () => {}],
    'free-text-only': ['reject', [['codex', 'Looks fine to me.']], () => {}],
  }
  for (const [variant, [expected, answers, triage]] of Object.entries(scenarios)) {
    const { dir } = gitRepo({ 'a.txt': '1\n' }, { 'orders.js': 'x\n' })
    const L = await withRun(dir)
    L.update(dir, r => { for (const s of ['contract', 'build', 'quality', 'test_review', 'verify']) r.stages[s].status = 'passed'; return r })
    const id = run(dir, 'loop.mjs', ['start', 'second_review']).stdout.match(/review request: (\S+)/)[1]
    for (const [i, [reviewer, angles]] of answers.entries()) {
      const file = join(dir, '.start-story', `a${i}.json`)
      writeFileSync(file, typeof angles === 'string' ? angles : JSON.stringify({ schema: L.REVIEW_SCHEMA, request: id, angles }))
      run(dir, 'loop.mjs', ['review', reviewer, file, '--request', id])
    }
    triage({ finding: (...a) => run(dir, 'loop.mjs', ['finding', ...a]), update: fn => L.update(dir, fn) })
    const problem = L.passProblem(dir, L.load(dir), 'second_review')
    out.push({ variant, expected, verdict: problem ? 'reject' : 'accept', why: problem })
  }
  return { id: 'review-dropped', category: 'review accounting', kind: 'loop', variants: out }
}

// Diagnostic export: does the canary check catch a leaking sanitizer, and pass a sound one?
async function canaryCase() {
  const D = await import(join(S, 'diag.mjs'))
  const canary = `FAKE_CANARY_${Date.now()}`
  const artifact = JSON.stringify({ log: `DB_PASSWORD="${canary}" npm test`, nested: JSON.stringify({ token: canary }), passed: 3 })
  // The grader: no canary anywhere, valid JSON, the benign field kept.
  const check = text => { let ok = true; try { ok = JSON.parse(text).passed === 3 } catch { ok = false } return ok && !text.includes(canary) }
  const sanitizers = {
    'structured (0.21)': ['accept', t => JSON.stringify(D.sanitizeValue(JSON.parse(t)))],
    'regex over serialized JSON (0.20)': ['reject', t => D.redact(t)],
    'none': ['reject', t => t],
  }
  return { id: 'diag-canary', category: 'diagnostic sanitization', kind: 'loop',
    variants: Object.entries(sanitizers).map(([variant, [expected, fn]]) => { const ok = check(fn(artifact)); return { variant, expected, verdict: ok ? 'accept' : 'reject', why: ok ? null : 'canary present or JSON broken' } }) }
}

export async function runCases({ only } = {}) {
  const apps = readdirSync(join(HERE, 'apps')).sort()
  const all = [...apps.map(id => () => appCase(id)), mutationCase, ciCase, reviewCase, canaryCase]
  const cases = []
  for (const make of all) {
    const c = await make()
    if (only && c.id !== only) continue
    const good = c.variants.filter(v => v.expected === 'accept')
    const failedControl = good.find(v => v.verdict !== 'accept')
    c.gate = good.length > 0 && !failedControl
    if (!c.gate) c.why = failedControl ? `${failedControl.variant} was rejected: ${failedControl.why}` : 'no known-good variant'
    cases.push(c)
  }
  const variants = cases.flatMap(c => c.variants.map(v => ({ ...v, case: c.id, category: c.category })))
  const bad = variants.filter(v => v.expected === 'reject'), good = variants.filter(v => v.expected === 'accept')
  const metrics = {
    cases: cases.length, cases_gating: cases.filter(c => c.gate).length,
    known_bad: bad.length, false_acceptance: bad.filter(v => v.verdict === 'accept').length,
    known_good: good.length, false_rejection: good.filter(v => v.verdict === 'reject').length,
    detection_by_category: Object.fromEntries([...new Set(bad.map(v => v.category))].map(cat => [cat, `${bad.filter(v => v.category === cat && v.verdict === 'reject').length}/${bad.filter(v => v.category === cat).length}`])),
  }
  return { layer: 'B evaluate the evaluators', generated_at: new Date().toISOString(), cases, metrics }
}
