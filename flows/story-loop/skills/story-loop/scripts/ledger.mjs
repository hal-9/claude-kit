// The ledger: one line per run, written whether or not diagnostics are on, kept
// across stories and shared by every worktree of the repository (parallel runs
// learn together). It is what the loop learns from: where runs went back, what
// reviewers found, what the tiers returned, what it cost in tokens, and the
// lessons the retro stage recorded.
// ponytail: one file per repository on this machine; a shared store only when several people run the loop.
import { readFileSync, appendFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// One ledger per repository, shared by its worktrees: under the git common dir, which
// every worktree of the repository resolves to. Outside git, the checkout's own file.
export const localLedgerFile = root => join(root, '.start-story', 'ledger.jsonl')
export function ledgerFile(root) {
  try {
    const common = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    return join(resolve(root, common), 'story-loop', 'ledger.jsonl')
  } catch { return localLedgerFile(root) }
}
const VERSION = (() => {
  try { return JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '.claude-plugin', 'plugin.json'), 'utf8')).version } catch { return null }
})()

const count = (list, key) => list.reduce((acc, item) => { const k = key(item); acc[k] = (acc[k] ?? 0) + 1; return acc }, {})
const jsonl = file => {
  try { return readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)] } catch { return [] } }) } catch { return [] }
}

// Every transcript of a session: its own file and whatever its subagents wrote next to it.
function transcriptFiles(path) {
  const out = existsSync(path) ? [path] : []
  const walk = dir => {
    let entries = []
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith('.jsonl') && out.push(join(dir, e.name))
  }
  walk(String(path).replace(/\.jsonl$/, ''))
  return out
}

// Tokens by stage and model, from the transcripts the run's sessions wrote.
// A message belongs to the one stage that was open (started, not yet passed,
// skipped or sent back) when it was written; with no stage open, to the stage
// that ran last. While parallel stages overlap no row says which one spent it,
// so it goes under `unknown`. The stage moves are the board feed's own events.
// `null` when no transcript is known.
export function usage(run, events) {
  const files = [...new Set((run.transcripts ?? []).flatMap(transcriptFiles))]
  if (!files.length) return null
  const moves = events.filter(e => e.kind === 'stage' && e.stage).map(e => [Date.parse(e.ts), e.verb, e.stage])
  const stageAt = ts => {
    const open = new Set()
    let last = 'setup'
    for (const [at, verb, id] of moves) {
      if (at > ts) break
      if (verb === 'start') { open.add(id); last = id } else if (verb === 'back') { open.clear() } else if (verb === 'pass' || verb === 'skip') open.delete(id)
    }
    return open.size > 1 ? 'unknown' : open.size ? [...open][0] : last
  }
  const from = Date.parse(run.started_at)
  const seen = new Map() // one API message is written once per content block, with the same usage
  for (const file of files) for (const row of jsonl(file)) {
    const u = row.message?.usage
    const ts = Date.parse(row.timestamp)
    if (row.type !== 'assistant' || !u || !(ts >= from)) continue
    seen.set(row.message.id ?? `${file}:${row.uuid}`, { ts, model: row.message.model ?? 'unknown', u })
  }
  const by_stage = {}
  const by_model = {}
  const add = (bucket, key, u) => {
    const b = bucket[key] ??= { input: 0, cache_write: 0, cache_read: 0, output: 0 }
    b.input += u.input_tokens ?? 0; b.cache_write += u.cache_creation_input_tokens ?? 0
    b.cache_read += u.cache_read_input_tokens ?? 0; b.output += u.output_tokens ?? 0
  }
  for (const { ts, model, u } of seen.values()) { add(by_stage, stageAt(ts), u); add(by_model, model, u) }
  return { messages: seen.size, by_stage, by_model }
}

// What one run adds to the ledger. Counts only; no code, no findings text beyond the lessons.
export function ledgerEntry(root, run, { ended = false, now = new Date().toISOString() } = {}) {
  const events = jsonl(join(root, '.start-story', 'events.jsonl'))
  const findings = run.findings ?? []
  const outcomes = Object.values(run.evidence?.mutants?.outcomes ?? {})
  const current = Object.keys(run.stages).find(id => !['passed', 'skipped'].includes(run.stages[id].status)) ?? null
  return {
    run: run.id ?? run.started_at, story: run.story, repo: run.repo ?? null, factory: VERSION, lane: run.lane?.lane ?? null,
    started_at: run.started_at, recorded_at: now, ended, stage: current, pr: run.pr ?? null, pr_state: run.pr_state?.state ?? null,
    stages: Object.fromEntries(Object.entries(run.stages).map(([id, s]) => [id, { status: s.status, rounds: s.rounds ?? 0, attempt: s.attempt ?? 1 }])),
    backs: (run.history ?? []).map(h => ({ from: h.from, to: h.to, reason: h.reason, human: /^human:/i.test(h.reason ?? '') })),
    findings: count(findings, f => `${f.source ?? 'unknown'}:${f.verdict}`),
    tasks: count(run.tasks ?? [], t => `${t.tier ?? 'unknown'}:${t.returns ? 'returned' : 'first_time'}`),
    mutants: outcomes.length ? count(outcomes, o => o) : null,
    quality: run.evidence?.quality ? { flags: count(Object.values(run.evidence.quality.flags ?? {}), f => f.kind), size: run.evidence.quality.size } : null,
    checks: Array.isArray(run.checks) ? run.checks.length : null, reviewer: run.reviewer ?? null,
    lessons: run.lessons ?? [], usage: usage(run, events),
  }
}

export function appendLedger(root, run, opts) {
  const entry = ledgerEntry(root, run, opts)
  mkdirSync(dirname(ledgerFile(root)), { recursive: true })
  appendFileSync(ledgerFile(root), JSON.stringify(entry) + '\n')
  return entry
}

// The newest line of each run. Lines a checkout wrote before the ledger was shared
// (0.10 and earlier) are read first, so the shared file's newer lines win.
export function readLedger(root) {
  const byRun = new Map()
  const shared = ledgerFile(root), local = localLedgerFile(root)
  for (const file of shared === local ? [shared] : [local, shared])
    for (const entry of jsonl(file)) byRun.set(entry.run, entry)
  return [...byRun.values()]
}

const total = b => (b?.input ?? 0) + (b?.cache_write ?? 0) + (b?.cache_read ?? 0) + (b?.output ?? 0)
const VERIFICATION = ['quality', 'test_review', 'verify', 'second_review', 'copilot_review', 'fix_comments']

// The lessons of all runs, one line per pattern, most frequent first. The contract
// advisor reads these as known pitfalls (`loop.mjs ledger --lessons`).
export function lessons(entries) {
  const patterns = new Map()
  for (const e of entries) for (const l of e.lessons ?? []) {
    const p = patterns.get(l.pattern) ?? { runs: new Set(), checks: new Set(), proposal: null }
    p.runs.add(e.run); p.checks.add(l.check); p.proposal ??= l.proposal ?? null
    patterns.set(l.pattern, p)
  }
  const ranked = [...patterns].sort((a, b) => b[1].runs.size - a[1].runs.size)
  if (!ranked.length) return '  no lessons recorded yet'
  return ranked.map(([pattern, p]) => `  ${String(p.runs.size).padStart(2)}×  ${pattern}  [${[...p.checks].join(', ')}]${p.proposal ? `  → ${p.proposal}` : ''}`).join('\n')
}

// What the runs so far say, in the order it is worth acting on.
export function summary(entries) {
  if (!entries.length) return 'the ledger is empty: no run has ended or reached the retro stage in this checkout yet'
  const lines = [`${entries.length} run${entries.length === 1 ? '' : 's'} · factory versions: ${[...new Set(entries.map(e => e.factory ?? 'unknown'))].join(', ')}`]
  lines.push('', 'Lessons by how many runs hit them (two or more: build the check now, it keeps recurring):', lessons(entries))
  const backs = count(entries.flatMap(e => e.backs ?? []), b => `${b.from} → ${b.to}${b.human ? ' (human)' : ''}`)
  lines.push('', 'Sent back:', ...(Object.keys(backs).length ? Object.entries(backs).sort((a, b) => b[1] - a[1]).map(([k, n]) => `  ${String(n).padStart(2)}×  ${k}`) : ['  never']))
  const tiers = {}
  for (const e of entries) for (const [key, n] of Object.entries(e.tasks ?? {})) {
    const [tier, how] = key.split(':')
    const t = tiers[tier] ??= { first_time: 0, returned: 0 }
    t[how] = (t[how] ?? 0) + n
  }
  lines.push('', 'Tasks by tier (returned at least once / all); a tier that is returned often is a tier too low for that work:',
    ...(Object.keys(tiers).length ? Object.entries(tiers).map(([tier, t]) => `  ${tier.padEnd(8)} ${t.returned} / ${t.returned + t.first_time}`) : ['  none recorded']))
  const withUsage = entries.filter(e => e.usage)
  if (withUsage.length) {
    const all = withUsage.reduce((n, e) => n + Object.values(e.usage.by_stage).reduce((m, b) => m + total(b), 0), 0)
    const verification = withUsage.reduce((n, e) => n + VERIFICATION.reduce((m, id) => m + total(e.usage.by_stage[id]), 0), 0)
    lines.push('', `Tokens (${withUsage.length} run${withUsage.length === 1 ? '' : 's'} with a transcript): ${Math.round(all / withUsage.length).toLocaleString('en')} per run, ` +
      `${all ? Math.round(100 * verification / all) : 0}% in the stages that check the work`)
  } else lines.push('', 'Tokens: no run recorded a transcript yet')
  return lines.join('\n')
}
