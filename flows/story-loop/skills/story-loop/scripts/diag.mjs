// Opt-in diagnostic recording for one run: what happened, in which order, for
// which code and attempt. Off unless the run says so (loop.mjs init --diagnostics,
// loop.mjs diagnostics on). It is never a source of truth for a stage: nothing
// reads it to decide anything, and a failure to record only warns and marks the
// recording incomplete. Events live in
//   .start-story/<story>/diagnostics/<run id>/events.jsonl
// next to a manifest; `loop.mjs diagnostics export` builds a bundle from them.
// Secrets are redacted before a record is written, not at export.
import {
  appendFileSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, lstatSync, realpathSync,
} from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { release } from 'node:os'
import { dirname, extname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const DIAG_V = 1
const HERE = dirname(fileURLToPath(import.meta.url))
const MAX_TEXT = 2000
const MAX_LINE = 16_000
const MAX_ARTIFACT = 5 << 20
const IMAGES = new Set(['.png', '.jpg', '.jpeg', '.webp'])
// The files a run writes into its story folder, by path. Nothing else is read or copied by an export.
const SHOT = String.raw`[^/]+\.(?:png|jpe?g|webp)`
const ARTIFACTS = new RegExp(`^(?:${[
  'results\\.json', 'inbox\\.json', 'report\\.md', 'flow\\.md', 'verifier-brief\\.md', 'signoff\\.html', 'mutants-[\\w.-]+\\.json',
  `evidence/${SHOT}`, 'reviews/[^/]+\\.txt', 'stale/[^/]+\\.json', 'attempts/[^/]+/results\\.json', `attempts/[^/]+/evidence/${SHOT}`,
].join('|')})$`, 'i')
// Never exported, whatever folder they are found in: credentials, keys, databases.
const CREDENTIAL = /^(?:\.env.*|.*\.(?:pem|key|p12|pfx|sqlite3?|db)|id_[^/]*|\.npmrc|\.netrc|\.pgpass|credentials(?:\.json)?)$/i

// ---- redaction -----------------------------------------------------------------

const SECRET_KEY = /pass(word|wd)?|secret|token|api[_-]?key|private[_-]?key|credential|authorization|cookie/i
const SECRETS = [
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+(?::[^\s/@]*)?@/gi, '$1[redacted]@'], // credentials inside a URL
  [/\b(authorization|proxy-authorization|cookie|set-cookie|x-api-key)\b(["']?\s*[:=]\s*)[^\n]+/gi, '$1$2[redacted]'],
  [/\b(bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [redacted]'],
  [/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|(?:AKIA|ASIA)[0-9A-Z]{16})\b/g, '[redacted]'],
  [/\b([A-Za-z0-9_-]*(?:password|passwd|secret|token|api[_-]?key|private[_-]?key|access[_-]?key|_key\b|credential)[A-Za-z0-9_-]*)(["']?\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s'"&;,}]+)/gi, '$1$2[redacted]'],
  [/(--(?:password|token|secret|api-key)\s+)\S+/gi, '$1[redacted]'],
  [/(\s(?:-u|--user)\s+)[^\s:]+:\S+/g, '$1[redacted]'], // curl -u user:password
]
// Redaction is best-effort: it catches the common shapes of secrets (above), not every one.
// What must never leave the machine is kept out by not recording or exporting it at all.
export function redact(text) {
  let out = String(text)
  for (const [pattern, replacement] of SECRETS) out = out.replace(pattern, replacement)
  return out
}
const clip = text => text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}… [truncated, ${text.length} chars]` : text
// A shell command as the board feed keeps it: the program and a short redacted line.
// Redacted before it is cut, so a cut never splits a secret into a shape redact misses.
export function commandSummary(command, max = 140) {
  const text = redact(String(command)).replace(/\s+/g, ' ').trim()
  const program = text.split(' ').find(word => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word))?.split('/').pop().slice(0, 40) ?? null
  return { program, text: text.length > max ? `${text.slice(0, max - 1)}…` : text }
}
// Bounded, redacted copy of any value: what a record may carry.
export function scrub(value, depth = 0) {
  if (value === undefined) return undefined
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'string') return clip(redact(value))
  if (depth >= 5) return '[omitted: nested too deep]'
  if (Array.isArray(value)) return value.slice(0, 50).map(v => scrub(v, depth + 1)).concat(value.length > 50 ? [`[${value.length - 50} more omitted]`] : [])
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 60).map(([k, v]) => [k, SECRET_KEY.test(k) && typeof v === 'string' ? '[redacted]' : scrub(v, depth + 1)]))
  return String(value)
}

// ---- recording -----------------------------------------------------------------

export const diagDir = (root, story, runId) => join(root, '.start-story', story, 'diagnostics', String(runId))
const runKey = run => run.id ?? run.started_at

// A helper process binds once to the run it works for; its later records keep
// that identity even when another run has become active in the meantime.
let CTX = null
export function bind(root, run, extra = {}) {
  CTX = { root, dir: run?.diagnostics?.enabled ? diagDir(root, run.story, runKey(run)) : null, run: run ? runKey(run) : null, story: run?.story ?? null, ...extra }
  return CTX
}
function lazy(root) {
  let run
  try { run = JSON.parse(readFileSync(join(root, '.start-story', 'active.json'), 'utf8')) } catch { return null }
  return run?.diagnostics?.enabled ? { root, dir: diagDir(root, run.story, runKey(run)), run: runKey(run), story: run.story } : null
}

let warned = false
function failed(ctx, error) {
  // Recording failed: say so where an export will find it, and once on stderr. Never stdout, never a throw.
  try { appendFileSync(join(dirname(ctx.dir), `recording-failures-${ctx.run}.log`), `${new Date().toISOString()} ${error.code ?? ''} ${error.message}\n`) } catch { /* nowhere left to say it but stderr */ }
  if (!warned) { warned = true; try { process.stderr.write(`story-loop diagnostics: a record could not be written (${error.message}); the recording is incomplete, the run is unaffected\n`) } catch {} }
}

// One event. Fields named in the envelope are lifted out of `fields`; the rest is
// `details`. null means "not known or not applicable here", never a guess.
export function record(root, kind, fields = {}) {
  let ctx = null
  try {
    ctx = CTX && CTX.root === root ? CTX : lazy(root)
    if (!ctx?.dir) return null
    const pick = name => fields[name] ?? ctx[name] ?? null
    const { outcome = null, reason = null, elapsed_ms = null, request = null, revision = null,
      stage, attempt, session, agent, op, parent_op, commit, tree, base, ...details } = fields
    const event = {
      v: DIAG_V, id: randomUUID(), ts: new Date().toISOString(), run: ctx.run, story: ctx.story,
      stage: pick('stage'), attempt: pick('attempt'), session: pick('session'), agent: pick('agent'),
      op: pick('op'), parent_op: pick('parent_op'), request, revision,
      commit: pick('commit'), tree: pick('tree'), base: pick('base'),
      kind, outcome, reason: reason === null ? null : clip(redact(String(reason))), elapsed_ms, details: scrub(details),
    }
    let line = JSON.stringify(event)
    if (line.length > MAX_LINE) line = JSON.stringify({ ...event, details: { truncated: true, chars: line.length } })
    mkdirSync(ctx.dir, { recursive: true })
    // One appended write per record: concurrent writers interleave whole lines.
    appendFileSync(join(ctx.dir, 'events.jsonl'), line + '\n')
    return event.id
  } catch (error) {
    if (ctx?.dir) failed(ctx, error)
    return null
  }
}

// Every valid event of a stream. A cut-off or unreadable line is counted, never fatal.
export function readEvents(dir) {
  let text = ''
  try { text = readFileSync(join(dir, 'events.jsonl'), 'utf8') } catch { return { events: [], unreadable: 0, missing: true } }
  const events = []
  let unreadable = 0
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try { events.push(JSON.parse(line)) } catch { unreadable++ }
  }
  return { events, unreadable, missing: false }
}

// ---- enabling ------------------------------------------------------------------

const version = (command, args) => { try { return execFileSync(command, args, { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n')[0] } catch { return null } }
function versions() {
  let plugin = null
  try { plugin = JSON.parse(readFileSync(join(HERE, '..', '..', '..', '.claude-plugin', 'plugin.json'), 'utf8')).version } catch {}
  return {
    plugin, plugin_revision: version('git', ['-C', HERE, 'rev-parse', 'HEAD']), node: process.version,
    platform: `${process.platform} ${process.arch} ${release()}`,
    claude: version('claude', ['--version']), gh: version(process.env.STORY_LOOP_GH || 'gh', ['--version']), git: version('git', ['--version']),
  }
}
const manifestFile = dir => join(dir, 'manifest.json')
export const readManifest = dir => { try { return JSON.parse(readFileSync(manifestFile(dir), 'utf8')) } catch { return null } }

// Turns recording on or off for a run. Returns what the run state carries; the caller saves it.
export function toggle(root, run, enabled, now = new Date().toISOString()) {
  const dir = diagDir(root, run.story, runKey(run))
  mkdirSync(dir, { recursive: true })
  const fresh = (run.revision ?? 0) === 0 && !run.history?.length
  const manifest = readManifest(dir) ?? {
    v: DIAG_V, run: runKey(run), story: run.story, run_started_at: run.started_at,
    coverage: enabled && !fresh ? `recording was enabled at ${now}; nothing before that was recorded` : 'recorded from the start of the run',
    null_means: 'a null field was not known or does not apply to that event; it is never a guess',
    toggles: [], versions: versions(),
  }
  manifest.toggles.push({ at: now, enabled })
  writeFileSync(manifestFile(dir), JSON.stringify(manifest, null, 2) + '\n')
  return { enabled, since: now, v: DIAG_V }
}

// ---- export --------------------------------------------------------------------

const sha256 = buffer => createHash('sha256').update(buffer).digest('hex')
function walk(dir, out = []) {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name)
    const st = lstatSync(path)
    if (st.isDirectory()) { if (name !== 'diagnostics') walk(path, out) } else out.push({ path, st })
  }
  return out
}

// Where a run's diagnostics are, whether or not that run is still the active one.
export function locate(root, runId) {
  const base = join(root, '.start-story')
  let stories = []
  try { stories = readdirSync(base) } catch { return null }
  for (const story of stories) {
    const dir = join(base, story, 'diagnostics', String(runId))
    if (existsSync(manifestFile(dir)) || existsSync(join(dir, 'events.jsonl'))) return { story, dir, storyDir: join(base, story) }
  }
  return null
}

// The state of that run: the active file when it is still this run, else its archived record.
function stateOf(root, storyDir, runId) {
  const candidates = [join(root, '.start-story', 'active.json'),
    ...readdirSync(storyDir).filter(n => /^run-\d+\.json$/.test(n)).sort().reverse().map(n => join(storyDir, n))]
  for (const file of candidates) {
    try { const run = JSON.parse(readFileSync(file, 'utf8')); if (String(runKey(run)) === String(runId)) return { run, file } } catch {}
  }
  return null
}

export function exportBundle(root, runId, { screenshots = false, out, now = new Date() } = {}) {
  const found = locate(root, runId)
  if (!found) throw new Error(`no diagnostics recorded for run ${runId} under ${join(root, '.start-story')}`)
  const { story, dir, storyDir } = found
  const dest = out ?? join(dir, `export-${now.toISOString().replace(/[:.]/g, '-')}`)
  mkdirSync(join(dest, 'artifacts'), { recursive: true })
  const { events, unreadable } = readEvents(dir)
  const state = stateOf(root, storyDir, runId)
  const artifacts = []
  const omitted = []
  const inside = realpathSync(storyDir) + sep
  // Every rule is decided from the name and lstat alone; a file is read only once it is
  // a known artifact, a regular file inside the folder, and small enough.
  for (const { path, st } of walk(storyDir)) {
    const rel = relative(storyDir, path)
    const name = rel.split(sep).pop()
    const role = rel.split(sep).join('/')
    if (/^run-\d+\.json$/.test(name) || /^recording-failures-/.test(name)) continue
    if (CREDENTIAL.test(name)) { omitted.push({ path: rel, why: 'credential, key or database file; never read' }); continue }
    if (/\.tmp$|\.prev$|\.broken-\d+$/.test(name)) { omitted.push({ path: rel, why: 'working copy or broken file, left where it is' }); continue }
    if (st.isSymbolicLink()) { omitted.push({ path: rel, why: 'symbolic link' }); continue }
    if (!st.isFile()) continue
    if (!ARTIFACTS.test(role)) { omitted.push({ path: rel, bytes: st.size, why: 'not a known run artifact; never read' }); continue }
    if (st.size > MAX_ARTIFACT) { omitted.push({ path: rel, bytes: st.size, why: `larger than ${MAX_ARTIFACT >> 20} MB` }); continue }
    let real
    try { real = realpathSync(path) } catch { omitted.push({ path: rel, why: 'unreadable' }); continue }
    if (!real.startsWith(inside)) { omitted.push({ path: rel, why: 'resolves outside the run folder' }); continue }
    const data = readFileSync(real)
    const entry = { path: rel, bytes: st.size, sha256: sha256(data) }
    if (IMAGES.has(extname(name).toLowerCase())) {
      if (!screenshots) { omitted.push({ ...entry, why: 'screenshot; pass --screenshots to include it' }); continue }
      const target = join(dest, 'artifacts', rel)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, data); artifacts.push(entry); continue
    }
    // Every other known artifact is text, redacted on the way out (best-effort, see redact()).
    const target = join(dest, 'artifacts', rel)
    mkdirSync(dirname(target), { recursive: true })
    const text = redact(data.toString('utf8'))
    writeFileSync(target, text)
    artifacts.push({ ...entry, redacted: text !== data.toString('utf8') })
  }
  writeFileSync(join(dest, 'events.jsonl'), events.map(e => JSON.stringify(e) + '\n').join(''))
  if (state) writeFileSync(join(dest, 'state.json'), redact(JSON.stringify(state.run, null, 2)) + '\n')
  let failures = []
  try { failures = readFileSync(join(storyDir, 'diagnostics', `recording-failures-${runId}.log`), 'utf8').split('\n').filter(Boolean) } catch {}
  const truncated = events.filter(e => e.details?.truncated).length
  const recorded = readManifest(dir)
  const manifest = {
    ...(recorded ?? { v: DIAG_V, run: runId, story, coverage: 'the manifest written when recording was enabled is missing' }),
    exported_at: now.toISOString(),
    state: state ? { from: relative(root, state.file) } : { missing: 'no state file for this run id was found; the summary is built from events alone' },
    events: { count: events.length, first: events[0]?.ts ?? null, last: events.at(-1)?.ts ?? null, unreadable_lines: unreadable, truncated_records: truncated },
    recording: { complete: !failures.length && !unreadable, write_failures: failures, off_periods: (recorded?.toggles ?? []).filter(t => !t.enabled).map(t => t.at) },
    artifacts_note: 'artifacts are the known run files of the story folder at export time (anything else is listed under omitted, unread); a later run of the same story shares that folder. Text is redacted best-effort: review before sharing',
    artifacts, omitted, screenshots_included: screenshots,
  }
  writeFileSync(join(dest, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  writeFileSync(join(dest, 'summary.md'), summarize({ events, run: state?.run ?? null, manifest }))
  return { dest, events: events.length, artifacts: artifacts.length, omitted: omitted.length, complete: manifest.recording.complete }
}

// ---- summary -------------------------------------------------------------------
// Built only from recorded events and the state file, in a fixed order, so the
// same bundle always gives the same text.

const ms = n => n == null ? 'not measured' : n < 60_000 ? `${Math.round(n / 1000)}s` : `${Math.floor(n / 60_000)}m ${Math.round((n % 60_000) / 1000)}s`
const short = sha => sha ? String(sha).slice(0, 7) : 'unknown'

// Time per stage from the accepted transitions: working, waiting on someone, blocked.
// Stages of a parallel group overlap, so each (run, attempt, stage, op) has its own span:
// a transition closes only the span it belongs to. `totals.worker_ms` sums the work spans
// (overlaps count twice); `totals.elapsed_ms` is wall time from the first event to the last.
const WAIT = { human: 'wait_human', copilot: 'wait_copilot', background: 'wait_background' }
export function stageTimes(events) {
  const moves = events.filter(e => e.kind === 'transition' && e.outcome === 'accepted' && e.stage)
  const times = {}
  const spans = new Map()
  const close = (key, at) => {
    const span = spans.get(key)
    if (!span) return
    spans.delete(key)
    const t = times[span.stage] ??= { work: 0, wait_human: 0, wait_copilot: 0, wait_background: 0, blocked: 0 }
    t[span.mode] += Math.max(0, Date.parse(at) - Date.parse(span.since))
  }
  for (const e of moves) {
    const key = JSON.stringify([e.run ?? null, e.attempt ?? null, e.stage, e.op ?? null])
    close(key, e.ts)
    const verb = e.details?.verb
    const mode = verb === 'start' ? 'work' : verb === 'wait' ? WAIT[e.details.to] ?? 'wait_human' : verb === 'block' ? 'blocked' : null
    if (mode) spans.set(key, { stage: e.stage, mode, since: e.ts })
  }
  const opens = [...spans.values()]
  const stamps = events.map(e => Date.parse(e.ts)).filter(Number.isFinite)
  const sum = mode => Object.values(times).reduce((n, t) => n + t[mode], 0)
  const totals = {
    elapsed_ms: stamps.length ? Math.max(...stamps) - Math.min(...stamps) : 0,
    worker_ms: sum('work'), human_wait_ms: sum('wait_human'),
    background_wait_ms: sum('wait_copilot') + sum('wait_background'), blocked_ms: sum('blocked'),
  }
  // Tokens a tool call reported, under the agent or operation that spent them; never guessed from the stage.
  const tokens = {}
  for (const e of events) {
    const n = e.details?.response?.total_tokens
    if (!Number.isFinite(n)) continue
    const who = e.details.response.agent_id ?? e.op ?? 'unknown'
    tokens[who] = (tokens[who] ?? 0) + n
  }
  return { times, open: opens.at(-1) ?? null, opens, totals, tokens }
}

export function summarize({ events, run, manifest }) {
  const of = kind => events.filter(e => e.kind === kind)
  const lines = []
  const say = (...text) => lines.push(...text)
  const stages = run ? Object.entries(run.stages) : []
  const currentStage = stages.find(([, s]) => !['passed', 'skipped'].includes(s.status))

  say(`# story-loop diagnostics: ${manifest.story} · run ${manifest.run}`, '')
  say(`Plugin ${manifest.versions?.plugin ?? 'unknown'} · ${manifest.versions?.node ?? 'node unknown'} · ${manifest.versions?.claude ?? 'Claude Code version not recorded'} · ${manifest.versions?.gh ?? 'gh version not recorded'}`)
  say(`Recording: ${manifest.coverage}. ${events.length} events${manifest.events.first ? `, ${manifest.events.first} to ${manifest.events.last}` : ''}.`, '')

  say('## Outcome', '')
  if (!run) say('No state file for this run was found; everything below comes from events alone.')
  else if (!currentStage) say(`All ${stages.length} stages are done: the human review round ended with the PR merged or closed, and the retro is written.`)
  else say(`Stopped at **${currentStage[0]}** (${currentStage[1].status}${currentStage[1].waiting_on ? `, waiting on ${currentStage[1].waiting_on}` : ''})${currentStage[1].reason ? `: ${redact(currentStage[1].reason)}` : '.'}`)
  const parked = (run?.findings ?? []).filter(f => f.verdict === 'parked')
  const unsettled = (run?.findings ?? []).filter(f => ['open', 'fix_requested'].includes(f.verdict))
  if (parked.length) say(`Decisions waiting for the human (parked findings): ${parked.map(f => f.id).join(', ')}.`)
  if (unsettled.length) say(`Findings not settled: ${unsettled.map(f => `${f.id} (${f.verdict})`).join(', ')}.`)
  say('')

  say('## Time by stage', '')
  const { times, opens, totals } = stageTimes(events)
  if (!Object.keys(times).length && !opens.length) say('No stage transitions were recorded.')
  else {
    say('| Stage | Working | Waiting on human | Waiting on Copilot | Blocked | Waiting in background |', '| --- | --- | --- | --- | --- | --- |')
    for (const [stage, t] of Object.entries(times)) say(`| ${stage} | ${ms(t.work)} | ${ms(t.wait_human)} | ${ms(t.wait_copilot)} | ${ms(t.blocked)} | ${ms(t.wait_background)} |`)
    for (const open of opens) say('', `Still open at the last event: ${open.stage} (${open.mode.replace('_', ' on ')}) since ${open.since}.`)
    say('', `Elapsed ${ms(totals.elapsed_ms)}; summed worker time ${ms(totals.worker_ms)} (stages that ran side by side each count); waiting on the human ${ms(totals.human_wait_ms)}; waiting on Copilot or background work ${ms(totals.background_wait_ms)}; blocked ${ms(totals.blocked_ms)}.`)
    say('', 'Times run from one recorded transition to the next of the same stage and attempt; a session that was closed in between counts as working.')
  }
  say('')

  say('## Returns, retries and refused moves', '')
  const backs = of('transition').filter(e => e.outcome === 'accepted' && e.details?.verb === 'back')
  const refused = events.filter(e => (e.kind === 'transition' || e.kind === 'cli') && e.outcome === 'rejected')
  const denied = of('guard.denied')
  say(backs.length ? backs.map(e => `- back ${e.stage} → ${e.details.to}: ${e.reason ?? 'no reason recorded'} [${e.id.slice(0, 8)}]`) : ['- No return to build.'])
  say(refused.length ? [`- ${refused.length} refused command${refused.length === 1 ? '' : 's'}:`, ...refused.map(e => `  - ${e.details?.verb ?? e.kind}${e.stage ? ` ${e.stage}` : ''}: ${e.reason} [${e.id.slice(0, 8)}]`)].flat() : ['- No refused command.'])
  if (denied.length) say(`- ${denied.length} tool call${denied.length === 1 ? '' : 's'} denied by the guard:`, ...denied.map(e => `  - ${e.reason} [${e.id.slice(0, 8)}]`))
  say('')

  say('## Browser verification', '')
  const reports = of('verify.report')
  const last = reports.at(-1)
  const total = Array.isArray(run?.checks) ? run.checks.length : null
  if (run?.stages?.verify?.status === 'skipped') say(`Skipped: ${run.stages.verify.reason ?? 'no reason recorded'}.`)
  else if (!last) say(`No pass of verify was attempted while recording${total === null ? '' : ` (approved checks: ${total})`}.`)
  else {
    say(`${last.details.accepted} of ${last.details.total} approved checks accepted for request ${last.request ?? 'unknown'} (${last.outcome}) [${last.id.slice(0, 8)}].`)
    const env = run?.stages?.verify?.request?.environment
    if (env) say(`Environment: ${env.url} (${env.kind}); link to the reviewed code: ${env.provenance}${env.provenance === 'unlinked' ? ` — this is NOT exact-code verification (${env.unlinked})` : ''}.`)
    const rejected = (last.details.rows ?? []).filter(r => !r.accepted)
    if (rejected.length) say(...rejected.map(r => `- ${r.id}: ${r.reason}`))
    if (last.reason) say(`Gate: ${last.reason}`)
  }
  say('')

  say('## Mutation testing', '')
  const m = run?.evidence?.mutants
  if (!m) say('No mutation results in the current attempt.')
  else {
    const accepted = Object.keys(m.dispositions ?? {}).length
    say(`${m.killed} killed of ${m.valid} valid mutants; ${m.survived} survived, ${m.invalid} invalid, ${m.timeout} timed out, ${(m.infra ?? 0) + (m.inconclusive ?? 0)} inconclusive, ${m.unverified} unverified, ${m.skipped} not run.`)
    if (accepted) say(`${accepted} outcome${accepted === 1 ? '' : 's'} accepted with a reason. An accepted survivor is still a survivor, not a kill.`)
    say(`Code tree ${short(m.tree)}, base ${short(m.base)}.`)
  }
  const mutOps = of('op.end').filter(e => e.details?.kind === 'mutate' && e.outcome !== 'ok')
  if (mutOps.length) say(...mutOps.map(e => `- mutation run ${e.op} ended ${e.outcome}: ${e.reason ?? ''} [${e.id.slice(0, 8)}]`))
  say('')

  say('## Second review', '')
  const reviews = run?.reviews ?? []
  say(reviews.length ? reviews.map(r => `- ${r.reviewer} reviewed tree ${short(r.tree)} (commit ${short(r.commit)}), request ${r.request}, attempt ${r.attempt}`) : ['No review recorded.'])
  say('')

  say('## Publishing, CI and report', '')
  if (run?.pushed) say(`Published ${short(run.pushed.sha)} to ${run.pushed.branch ?? 'unknown branch'} in ${run.pushed.repo ?? 'unknown repository'}: ${run.pushed.state}.`)
  else say('Nothing published.')
  if (run?.ci) say(`Required CI on ${short(run.ci.sha)}: ${run.ci.state}. Required set: ${run.ci.required ? (run.ci.required.join(', ') || 'none') : 'unknown'} (from ${[...(run.ci.policy?.sources ?? []), run.ci.policy?.manual ? 'the human\'s list' : null].filter(Boolean).join(', ') || 'no readable source'})${run.ci.missing?.length ? `; missing: ${run.ci.missing.join(', ')}` : ''}.`)
  else say('No CI result recorded.')
  if (run?.report) say(`Report: ${run.report.state}${run.report.comment_id ? `, comment ${run.report.comment_id}` : ''} for ${short(run.report.sha)}.`)
  if (run?.pr_state) say(`PR state last seen: ${run.pr_state.state}${run.pr_state.draft === false ? ', ready for review' : run.pr_state.draft ? ', draft' : ''}.`)
  say('')

  say('## Incomplete operations and stale completions', '')
  const ended = new Set(events.filter(e => e.kind === 'tool.end' || e.kind === 'tool.failed').map(e => e.details?.tool_use_id))
  const hanging = of('tool.start').filter(e => e.details?.tool_use_id && !ended.has(e.details.tool_use_id))
  const opEnded = new Set(of('op.end').map(e => e.op))
  const opHanging = of('op.start').filter(e => !opEnded.has(e.op))
  const stale = of('op.stale')
  say(hanging.length ? [`- ${hanging.length} tool call${hanging.length === 1 ? '' : 's'} started with no recorded completion (cancelled, interrupted, or the session ended; the hooks do not say which): ${hanging.slice(0, 20).map(e => `${e.details.tool} [${e.id.slice(0, 8)}]`).join(', ')}${hanging.length > 20 ? ', …' : ''}`] : ['- Every recorded tool call has a recorded completion.'])
  say(opHanging.length ? [`- Helper operations with no recorded end: ${opHanging.map(e => `${e.details?.kind} ${e.op} [${e.id.slice(0, 8)}]`).join(', ')}`] : ['- Every recorded helper operation has a recorded end.'])
  say(stale.length ? stale.map(e => `- stale completion of ${e.details?.kind} ${e.op}: ${e.reason} [${e.id.slice(0, 8)}]`) : ['- No stale completion.'])
  say('')

  say('## Recording limitations', '')
  say(`- Coverage: ${manifest.coverage}.`)
  if (manifest.recording.off_periods.length) say(`- Recording was switched off at: ${manifest.recording.off_periods.join(', ')}.`)
  if (manifest.events.unreadable_lines) say(`- ${manifest.events.unreadable_lines} line(s) of the event file could not be read (a write cut off part way); the events around them are intact.`)
  if (manifest.events.truncated_records) say(`- ${manifest.events.truncated_records} record(s) were too large and keep only their envelope.`)
  if (manifest.recording.write_failures.length) say(`- ${manifest.recording.write_failures.length} record(s) could not be written; first: ${manifest.recording.write_failures[0]}`)
  if (manifest.omitted.length) say(`- ${manifest.omitted.length} file(s) are listed in manifest.json but not copied (${[...new Set(manifest.omitted.map(o => o.why))].join('; ')}).`)
  say('- Tool calls made by helper scripts (git, gh, the test command) are recorded by the scripts; anything a worker ran through a tool the hooks do not see is not here.')
  say('- Model names, token usage and durations appear only where Claude Code reported them.', '')

  say('## For the agent analysing this bundle', '')
  say('Read `manifest.json`, `events.jsonl`, `state.json` and the files under `artifacts/` before concluding anything. Then:', '',
    '1. For every finding, cite the event ids and artifact paths it rests on.',
    '2. Sort each finding into one of: implementation defect in story-loop, gap in its instructions, environment failure (network, GitHub, browser, tooling), or a normal human decision.',
    '3. For each defect or gap, recommend the smallest change that would have prevented it, and one regression scenario that would catch it.',
    '4. Where events are missing, cut off or were never recorded, say so. Do not reconstruct what probably happened as if it were recorded.',
    '5. Check that what the report and the board claimed matches the recorded evidence: accepted checks against the approved list, mutation outcomes, the published commit and its CI.', '')
  return lines.join('\n')
}
