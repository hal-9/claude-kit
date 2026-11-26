// Structured diagnostics are sanitized before serialization (2026-11-26 audit). Fake
// canaries go through real command output -> run state and artifacts -> export, and must
// be absent from every recorded and exported surface; JSON stays JSON.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { load, update } from '../skills/story-loop/scripts/loop.mjs'
import { exportBundle, sanitizeValue, sanitizeOutput } from '../skills/story-loop/scripts/diag.mjs'
import { repo, withRun } from './helpers.mjs'

const script = name => fileURLToPath(new URL(`../skills/story-loop/scripts/${name}`, import.meta.url))
const run = (cwd, name, ...args) => spawnSync('node', [script(name), ...args], { cwd, encoding: 'utf8' })
const C = n => `FAKE_CANARY_${n}_${Math.random().toString(36).slice(2, 10)}`
const files = dir => readdirSync(dir).flatMap(n => statSync(join(dir, n)).isDirectory() ? files(join(dir, n)) : [join(dir, n)])

test('canaries in command output never reach run state, artifacts or the export; exported JSON is valid', () => {
  const { dir, commit } = repo()
  commit('app.js', 'export const a = 1\n')
  const canaries = { quoted: C('Q'), unquoted: C('U'), field: C('F'), nested: C('N'), header: C('H'), url: C('URL'), cut: C('CUT') }
  // Every shape the audit named, printed by the "linter" to stdout and stderr. The cut canary
  // sits where keeping the last 2000 characters would split its assignment if cutting came first.
  const lines = [
    `DB_PASSWORD="${canaries.quoted}"`,
    `API_TOKEN=${canaries.unquoted} npm test`,
    JSON.stringify({ level: 'error', password: canaries.field }),
    JSON.stringify({ log: JSON.stringify({ request: { headers: { authorization: `Bearer ${canaries.nested}` } } }) }),
    `Authorization: Basic ${canaries.header}`,
    `fetching https://deploy:${canaries.url}@registry.example.com/pkg`,
  ]
  const printer = join(dir, '..', `print-${Date.now()}.mjs`)
  writeFileSync(printer, `console.log(${JSON.stringify(lines.join('\n'))}); console.error('SECRET_KEY=${canaries.cut}' + 'x'.repeat(1985)); console.log('lint: 3 files inspected, 1 offense'); process.exit(1)`)
  withRun(dir, { diagnostics: { enabled: true } })
  update(dir, r => { r.stages.contract.status = 'passed'; r.stages.build.status = 'passed'; r.stages.quality.status = 'running'; return r })
  assert.equal(run(dir, 'quality.mjs', '--lint', `node ${printer}`).status, 1)
  assert.equal(run(dir, 'loop.mjs', 'verification', 'set', JSON.stringify([{ id: 'unit', command: `node ${printer}` }])).status, 0)
  assert.equal(run(dir, 'loop.mjs', 'verification', 'run', 'unit').status, 1)
  // A legitimate JSON artifact whose log string carries an escaped-quote assignment.
  const story = join(dir, '.start-story', 'sc-1')
  writeFileSync(join(story, 'mutants-1-abc.json'), JSON.stringify({ status: 'finished', passed: 3, log: `DB_PASSWORD="${canaries.quoted}"`, nested: JSON.stringify({ token: canaries.field }) }))
  writeFileSync(join(story, 'mutants-2-bad.json'), `{"log": "DB_PASSWORD=\\"${canaries.quoted}\\"", `)

  const state = readFileSync(join(dir, '.start-story', 'active.json'), 'utf8')
  const bundle = exportBundle(dir, load(dir).id, {})
  const exported = files(bundle.dest).map(f => [f, readFileSync(f, 'utf8')])
  const recorded = [['active.json', state], ...files(story).filter(f => !f.includes('/export-') && !f.endsWith('.json') || /verification|active/.test(f)).map(f => [f, readFileSync(f, 'utf8')])]
  for (const [where, text] of [...exported, ...recorded])
    for (const [shape, value] of Object.entries(canaries)) assert.equal(text.includes(value), false, `${shape} canary in ${where}`)
  for (const [where, text] of exported.filter(([f]) => f.endsWith('.json'))) assert.doesNotThrow(() => JSON.parse(text), where)
  const manifest = JSON.parse(readFileSync(join(bundle.dest, 'manifest.json'), 'utf8'))
  assert.match(manifest.omitted.find(o => o.path === 'mutants-2-bad.json').why, /malformed JSON/)
  // Useful content survives: the benign line, a field named "passed", the artifact's structure.
  const artifact = JSON.parse(readFileSync(join(bundle.dest, 'artifacts', 'mutants-1-abc.json'), 'utf8'))
  assert.deepEqual([artifact.status, artifact.passed], ['finished', 3])
  assert.equal(JSON.parse(artifact.nested).token, '[redacted]')
  assert.match(load(dir).evidence.quality.lint[0].output, /lint: 3 files inspected, 1 offense/)
})

test('sanitizing keeps benign content and structure; secrets cut at the boundary are not reassembled', () => {
  const value = { summary: { passed: 4, failed: 0 }, tokens_used: 1200, note: 'no secrets here', list: [1, 'two', { ok: true }] }
  assert.deepEqual(sanitizeValue(value), value)
  const deep = { a: { b: { c: { d: { e: { f: { g: 'API_KEY=abc123secret' } } } } } } }
  assert.equal(sanitizeValue(deep).a.b.c.d.e.f.g, 'API_KEY=[redacted]', 'no depth limit cuts an artifact short')
  const out = sanitizeOutput(`PASSWORD=hunter2hunter2 ${'y'.repeat(50)}\nok`, 40)
  assert.equal(out.includes('hunter2'), false)
  assert.match(out, /earlier characters omitted\]\nok$/)
})
