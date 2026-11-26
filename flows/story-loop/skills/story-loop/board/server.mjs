#!/usr/bin/env node
// story-loop board: serves one page and streams the run to it.
//   node server.mjs [--root <repo>] [--port 4317] [--demo] [--open-after 10 | --no-open]
// It only reads: .start-story/active.json, .start-story/events.jsonl and git.
// The one thing it starts is `claude -p` for an "explain" request: only the
// Read, Grep and Glob tools exist in it, no MCP servers, bounded in time and count.
import { createServer } from 'node:http'
import { readFileSync, writeFileSync, statSync, existsSync, mkdtempSync, mkdirSync, realpathSync, openSync, fstatSync, closeSync, constants } from 'node:fs'
import { execFile, execFileSync, spawn } from 'node:child_process'
import { basename, dirname, extname, join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { GRAPH, paths, newRun, move, save, emit, readInbox, addNote, deliver, readResults, resultsFile, evidenceDir, runDir, staleStages, headCommit, verifyReport, diffBase, imageProblem, runKey } from '../scripts/loop.mjs'
import { record } from '../scripts/diag.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const flag = name => { const i = argv.indexOf(`--${name}`); return i < 0 ? undefined : argv[i + 1] ?? true }
const DEMO = argv.includes('--demo')
const ROOT = DEMO ? mkdtempSync(join(tmpdir(), 'story-loop-demo-')) : resolve(flag('root') ?? process.cwd())
// --port wins; else the port `loop.mjs worktree` gave this checkout; else 4317. Without
// --port, a taken port moves the board to the next free one (parallel runs).
const ASKED_PORT = flag('port')
let PORT = Number(ASKED_PORT ?? (() => { try { return JSON.parse(readFileSync(join(ROOT, '.start-story', 'ports.json'), 'utf8')).board } catch { return undefined } })() ?? 4317)
let tries = 0
const P = paths(ROOT)
// The skill tells the agent to open the board, and an agent can forget. When no page has
// connected --open-after seconds after start, the server opens the default browser itself.
const OPEN_AFTER = argv.includes('--no-open') ? null : Number(flag('open-after') ?? 10)
let connected = false

const QUESTIONS = {
  explain: 'Explain what this change does and how the code in this file is structured. Plain language, no line-by-line walkthrough.',
  why_here: 'Explain why this logic lives in this file and layer, and where else in the codebase the same kind of thing lives.',
  connects: 'Explain how this file connects to the rest of the change and the codebase: who calls it, what it calls, what data flows through.',
  quiz: 'Write four short questions that check whether a developer understood this whole change: structure, placement, data flow, and one edge case. Put the answers at the end under "Answers".',
}

const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 16 << 20 })
const readJson = file => { try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return null } }
// An unreadable notes file shows on the board as what it is, never as "no notes".
const inbox = run => {
  if (!run) return []
  try { return readInbox(ROOT, run) } catch (error) { return [{ id: '!', status: 'queued', kind: 'note', ts: new Date().toISOString(), text: error.message }] }
}
const readEvents = () => {
  try { return readFileSync(P.events, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { return [] }
}
const EXPLAIN_SECONDS = 180
const EXPLAIN_MAX = 2
const EXPLAIN_OUTPUT_MAX = 256 << 10
const BODY_MAX = 20_000
let explaining = 0
// One explanation slot, taken before the first await so requests arriving together
// cannot all pass the limit; the release runs once whatever path ends the request.
function takeSlot() {
  explaining++
  let held = true
  return () => { if (held) { held = false; explaining-- } }
}
const stamp = file => { try { const s = statSync(file); return `${s.mtimeMs}:${s.size}` } catch { return '' } }

function mergeBase(run) {
  try { return git('merge-base', diffBase(git, run?.base || 'main'), 'HEAD').trim() } catch { return 'HEAD' }
}
function changes(run) {
  if (DEMO) return DEMO_CHANGES
  try {
    // -z keeps odd file names literal; --no-renames lists a rename as its real old and new path,
    // so every entry is a path the diff endpoint can be asked for.
    return git('diff', '--numstat', '-z', '--no-renames', mergeBase(run)).split('\0').filter(Boolean).map(entry => {
      const [added, removed, ...file] = entry.split('\t')
      return { file: file.join('\t'), added: Number(added) || 0, removed: Number(removed) || 0 }
    })
  } catch { return [] }
}
const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', ...(DEMO ? { '.svg': 'image/svg+xml' } : {}) }
// What the gate makes of the results on disk, asked of the gate itself (verifyReport),
// never worked out a second time here: a row is "accepted" only when it counts as
// passing evidence for the request that is current now.
function gate(run) {
  if (!run || DEMO) return null
  try { return verifyReport(ROOT, run) } catch (error) { return { problem: error.message, rows: [], accepted: 0, total: 0, request: null, results_request: null, provenance: null } }
}
// The verifier's checks, with each screenshot as a URL this server can serve, and
// for every row whether it is accepted and, if not, why. A rejected row stays on
// the page with its reason; it only never counts.
function results(run, report = gate(run)) {
  const list = run && readResults(ROOT, run)
  if (!Array.isArray(list)) return []
  // The file is the verifier's, written while we read: a row of the wrong shape is shown as invalid, not trusted and not dropped.
  return list.map((r, i) => {
    const row = r && typeof r === 'object' && !Array.isArray(r) ? r : {}
    const problem = row !== r ? 'this result is not an object'
      : typeof row.id !== 'string' ? 'this result has no id'
      : row.evidence !== undefined && !(Array.isArray(row.evidence) && row.evidence.every(f => typeof f === 'string')) ? 'evidence must be a list of screenshot file names'
      : null
    const evidence = problem ? [] : (row.evidence ?? []).map(file => `/evidence/${encodeURIComponent(basename(file))}`)
    if (problem) return { ...row, id: typeof row.id === 'string' ? row.id : `invalid-${i + 1}`, step: Number.isInteger(row.step) ? row.step : 0, verdict: 'blocked', note: `Invalid result in results.json: ${problem}.`, evidence, accepted: false, rejected: problem }
    // The demo has no gate to ask; there a pass is taken as the script wrote it.
    const judged = report ? report.rows[i] : { accepted: row.verdict === 'pass', reason: null }
    return { ...row, evidence, accepted: Boolean(judged?.accepted), rejected: row.verdict === 'pass' && !judged?.accepted ? judged?.reason ?? 'not accepted' : null }
  })
}
// The numbers and the one decision the "Tested in the browser" section shows.
// all_accepted is the gate's own answer: every approved check accepted for the
// current request, and the evidence not stale for the code that is HEAD now.
function tested(run, report = gate(run), rows = results(run, report)) {
  if (!run) return null
  const checks = Array.isArray(run.checks) ? run.checks : null
  const stale = (DEMO ? (run.stale ?? []) : staleStages(ROOT, run)).includes('verify')
  const approved = new Set((checks ?? []).map(c => c.id))
  const accepted = report ? report.accepted : rows.filter(r => r.accepted && approved.has(r.id)).length
  const all = report ? report.problem === null : Boolean(checks?.length) && accepted === checks.length && rows.every(r => approved.has(r.id))
  return {
    request: report?.request ?? null, results_request: report?.results_request ?? null,
    // Results written for another request are old evidence: shown, never counted.
    current: report ? report.results_request !== null && report.results_request === report.request : true,
    accepted, total: checks?.length ?? 0, reported: rows.length, problem: report?.problem ?? null,
    all_accepted: all && !stale, provenance: report?.provenance ?? run.stages?.verify?.provenance ?? null,
  }
}
// Which question a stage waiting on the human asks: an answer must name it back.
const questionId = st => createHash('sha256').update(String(st?.reason ?? '')).digest('hex')
const waitsOnHuman = st => st?.status === 'waiting' && st.waiting_on === 'human'
// The run as the page sees it: the state file plus which evidence is stale for the code now.
function view(run) {
  if (!run) return run
  const stages = Object.fromEntries(Object.entries(run.stages ?? {}).map(([id, st]) => [id, waitsOnHuman(st) ? { ...st, question_id: questionId(st) } : st]))
  return { ...run, stages, run_key: runKey(run), stale: DEMO ? (run.stale ?? []) : staleStages(ROOT, run), head: DEMO ? 'demo' : headCommit(ROOT) }
}
// Evidence is served over loopback only; the boundary matters only to a writer able to
// put a symlink (or a swapped file) into the evidence folder. Only a regular image file
// whose real path is inside that folder is served, read from the descriptor that was checked.
const EVIDENCE_MAX_BYTES = 20 << 20
function evidenceShot(run, name) {
  const type = IMAGE_TYPES[extname(name).toLowerCase()]
  if (!run || !type || name !== basename(name) || name === '..') return null
  const dir = evidenceDir(ROOT, run)
  // The demo's stand-in screenshots are SVG, which the image check rightly refuses.
  if (!(DEMO && type === 'image/svg+xml') && imageProblem(dir, name)) return null
  let real, checked
  try { real = realpathSync(join(dir, name)); checked = statSync(real) } catch { return null }
  if (!real.startsWith(realpathSync(dir) + sep)) return null
  let fd
  try { fd = openSync(real, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)) } catch { return null }
  try {
    const st = fstatSync(fd)
    if (!st.isFile() || st.dev !== checked.dev || st.ino !== checked.ino || st.size > EVIDENCE_MAX_BYTES) return null
    return { type, data: readFileSync(fd) }
  } finally { closeSync(fd) }
}
// Rows and summary from one reading of the gate, so they can never disagree.
function testedView(run) {
  const report = gate(run)
  const rows = results(run, report)
  return { results: rows, tested: tested(run, report, rows) }
}
const inboxPath = run => run ? join(runDir(ROOT, run), 'inbox.json') : ''
const diffOf = (run, file) => DEMO ? DEMO_DIFF : git('diff', '--no-renames', mergeBase(run), '--', file)

// ---- http ------------------------------------------------------------------

const clients = new Set()
const send = (res, message) => res.write(`data: ${JSON.stringify(message)}\n\n`)
const broadcast = message => { for (const res of clients) send(res, message) }

// One bad file must not take the board down: the tick is skipped and tried again.
const tick = (fn, ms) => setInterval(() => { try { fn() } catch (error) { console.error(`story-loop board: ${error.message}`) } }, ms)
let seen = { run: '', events: 0, changes: '' }
tick(() => {
  if (!clients.size) return
  const runStamp = stamp(P.active)
  if (runStamp !== seen.run) { seen.run = runStamp; broadcast({ type: 'run', run: view(readJson(P.active)) }) }
  const events = readEvents()
  // A new run starts a new events file: the pages reload their snapshot instead of mixing runs.
  if (events.length < seen.events) { seen.events = 0; broadcast({ type: 'reload' }) }
  events.slice(seen.events).forEach((event, i) => broadcast({ type: 'event', event, seq: seen.events + i + 1 }))
  seen.events = events.length
  const run = readJson(P.active)
  const inboxStamp = stamp(inboxPath(run))
  // Whether a result counts depends on the run too (a new request, a changed check list), not on the file alone.
  const resultsStamp = run ? `${stamp(resultsFile(ROOT, run))}|${runStamp}` : ''
  if (resultsStamp !== seen.results) { seen.results = resultsStamp; broadcast({ type: 'results', ...testedView(run) }) }
  if (inboxStamp !== seen.inbox) { seen.inbox = inboxStamp; broadcast({ type: 'inbox', inbox: inbox(run) }) }
}, 700)
tick(() => {
  if (!clients.size) return
  const run = readJson(P.active)
  const list = changes(run)
  const key = JSON.stringify(list)
  if (key !== seen.changes) { seen.changes = key; broadcast({ type: 'changes', changes: list }) }
  // A new commit can make passed evidence stale without the state file changing.
  const head = DEMO ? '' : headCommit(ROOT)
  if (head !== seen.head) { seen.head = head; broadcast({ type: 'run', run: view(run) }); broadcast({ type: 'results', ...testedView(run) }) }
}, 5000)

function body(req) {
  return new Promise((ok, no) => {
    let text = ''
    req.on('data', chunk => { if (text.length > BODY_MAX) return; text += chunk; if (text.length > BODY_MAX) no(new Error('too large')) })
    req.on('end', () => { try { ok(JSON.parse(text)) } catch (error) { no(error) } })
  })
}

// `claude -p` started from here has no login of its own when the CLI was only ever
// used inside the desktop app; it then prints "OAuth session expired" as if it were
// the answer. Ask first. A yes is remembered for five minutes, a no never.
const NOT_SIGNED_IN = 'The explanations run the `claude` CLI, and it is not signed in on its own (the desktop app\'s session does not carry over). In a terminal run `claude auth login`, then ask again.'
let signedInUntil = 0
let checking = null
// Requests that arrive while a check runs share it.
function signedIn() {
  if (Date.now() < signedInUntil) return Promise.resolve(true)
  return checking ??= new Promise(done => execFile('claude', ['auth', 'status'], { timeout: 15_000 }, (_error, stdout) => {
    let yes = false
    try { yes = JSON.parse(stdout).loggedIn === true } catch {}
    if (yes) signedInUntil = Date.now() + 5 * 60_000
    checking = null
    done(yes)
  }))
}

async function explain(req, res) {
  if (!/^application\/json/.test(req.headers['content-type'] ?? '')) return text(res, 415, 'json only')
  if (explaining >= EXPLAIN_MAX) return text(res, 429, `${EXPLAIN_MAX} explanations are already running; wait for one to finish`)
  const release = takeSlot()
  // The page closed or cancelled: the work stops with it, or never starts.
  let gone = false, cancel = null
  res.on('close', () => { gone = true; cancel?.() })
  let child
  try {
    const { file, question, text: custom } = await body(req)
    const run = readJson(P.active)
    const known = changes(run).map(c => c.file)
    // Trust boundary: the page may only ask about files that are part of this change.
    if (file && !known.includes(file)) return text(res, 400, 'that file is not part of this change')
    const ask = question === 'custom' ? String(custom ?? '').slice(0, 500) : QUESTIONS[question]
    if (!ask) return text(res, 400, 'unknown question')
    if (!DEMO && !(await signedIn())) return text(res, 503, NOT_SIGNED_IN)
    if (gone) return
    const head = DEMO ? 'demo' : headCommit(ROOT) ?? ''
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-story-loop-head': head })
    if (DEMO) return res.end(question === 'quiz' ? DEMO_QUIZ : DEMO_ANSWER)
    const prompt = [
      `You are explaining a code change to the developer who owns it and wants to understand it, not to review it.`,
      `Story ${run?.story ?? ''}${run?.title ? `: ${run.title}` : ''}. Changed files: ${known.join(', ')}.`,
      file ? `Focus on ${file}. Its diff:\n\n${diffOf(run, file).slice(0, 30_000)}` : 'Cover the change as a whole; read the files you need.',
      ask,
      'Read the surrounding code before answering. Under 250 words, markdown, name real files and methods.',
    ].join('\n\n')
    // --tools makes Read, Grep and Glob the only tools that exist (--allowedTools alone
    // only skips their prompts); --strict-mcp-config with no config loads no MCP server.
    child = spawn('claude', ['-p', prompt, '--tools', 'Read,Grep,Glob', '--allowedTools', 'Read,Grep,Glob',
      '--strict-mcp-config', '--no-session-persistence'], {
      cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: true, env: { ...process.env, STORY_LOOP_EXPLAINER: '1' },
    })
    const began = Date.now()
    record(ROOT, 'board.explain', { outcome: 'started', question, file })
    let written = 0, stderr = '', finished = false, ended = null
    const stop = () => { try { process.kill(-child.pid, 'SIGKILL') } catch {} }
    cancel = () => { if (!finished) { ended ??= 'cancelled'; stop() } }
    const timer = setTimeout(() => { ended = 'timeout'; if (!res.writableEnded) res.write(`\n\n_Stopped: no answer within ${EXPLAIN_SECONDS} seconds._`); stop() }, EXPLAIN_SECONDS * 1000)
    const done = (outcome, reason) => {
      if (finished) return
      finished = true; release(); clearTimeout(timer)
      record(ROOT, 'board.explain', { outcome: ended ?? outcome, reason, question, file, elapsed_ms: Date.now() - began })
    }
    child.stdout.on('data', chunk => {
      if (written >= EXPLAIN_OUTPUT_MAX) return
      written += chunk.length
      res.write(chunk)
      if (written >= EXPLAIN_OUTPUT_MAX) { ended = 'too long'; res.write(`\n\n_Stopped: the answer passed ${EXPLAIN_OUTPUT_MAX >> 10} KB._`); stop() }
    })
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2000) })
    child.on('error', error => { done('failed', error.message); if (!res.writableEnded) res.end(`_Could not start claude: ${error.message}_`) })
    child.on('close', code => {
      done(code === 0 ? 'ok' : 'failed', code === 0 ? undefined : `exit ${code ?? 'killed'}`)
      if (res.writableEnded) return
      res.end(code === 0 || written ? '' : `_The explanation failed (exit ${code ?? 'killed'})${stderr ? `: ${stderr.trim().split('\n').at(-1)}` : ''}_`)
    })
  } finally {
    // Every path that started no child hands the slot back here; a child's end does it otherwise.
    if (!child) release()
  }
}

const isJson = req => /^application\/json/.test(req.headers['content-type'] ?? '')

// A note from the human for the agent. It only lands in the inbox; the hook or
// the copy button hands it over.
async function steer(req, res) {
  if (!isJson(req)) return text(res, 415, 'json only')
  const { file, finding, kind, text: note, context } = await body(req)
  const run = readJson(P.active)
  if (!run) return text(res, 409, 'no active run')
  if (!['note', 'wrong', 'change', 'fix'].includes(kind)) return text(res, 400, 'unknown kind')
  if (typeof note !== 'string' || !note.trim()) return text(res, 400, 'write what the agent should do')
  if (file && !changes(run).some(c => c.file === file)) return text(res, 400, 'that file is not part of this change')
  if (finding && !run.findings?.some(f => f.id === finding)) return text(res, 400, 'unknown finding')
  const id = addNote(ROOT, {
    kind, file, finding, text: note.trim().slice(0, 2000),
    context: typeof context === 'string' ? context.replace(/\s+/g, ' ').slice(0, 400) : undefined,
  })
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ id }))
}

// The human answers the question a stage is waiting on: yes, or no with what to do
// instead. It lands in the inbox like any note; the conductor's waiter hands it over.
// The answer names the question the page showed (run, stage, attempt, question id):
// one for an older run, attempt or question is refused, and sending it twice is one note.
async function answer(req, res) {
  if (!isJson(req)) return text(res, 415, 'json only')
  const { stage, verdict, text: said, run: key, attempt, question_id: qid } = await body(req)
  const run = readJson(P.active)
  if (!run) return text(res, 409, 'no active run')
  const st = run.stages?.[stage]
  if (!waitsOnHuman(st)) return text(res, 409, 'that stage is not waiting on you any more')
  if (key !== runKey(run) || attempt !== (st.attempt ?? 1) || qid !== questionId(st)) return text(res, 409, 'that question is no longer the one waiting; reload the board')
  if (!['yes', 'no'].includes(verdict)) return text(res, 400, 'answer yes or no')
  const why = typeof said === 'string' ? said.trim().slice(0, 2000) : ''
  if (verdict === 'no' && !why) return text(res, 400, 'say what the agent should do instead')
  // No await between this check and addNote: two submissions cannot both pass it.
  const same = readInbox(ROOT, run).find(n => n.kind === 'answer' && n.run === key && n.stage === stage && n.attempt === attempt && n.question_id === qid && n.verdict === verdict)
  const id = same?.id ?? addNote(ROOT, { kind: 'answer', stage, verdict, text: why || undefined, question: st.reason ?? undefined, run: key, attempt, question_id: qid })
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ id }))
}

const text = (res, code, message) => { res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8' }); res.end(message) }

createServer(async (req, res) => {
  try {
    // Local page only: a foreign Host header means another site is talking to us.
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host ?? '')) return text(res, 403, 'local only')
    // A page from another origin may not change anything here, even through a local Host.
    if (req.method !== 'GET' && req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) return text(res, 403, 'local page only')
    const url = new URL(req.url, 'http://localhost')
    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'content-security-policy': "frame-ancestors 'none'" })
      return res.end(readFileSync(join(HERE, 'index.html')))
    }
    if (url.pathname === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
      const run = readJson(P.active)
      const events = readEvents()
      send(res, { type: 'snapshot', seq: events.length, run: view(run), graph: GRAPH, events: events.slice(-300), changes: changes(run), inbox: inbox(run), ...testedView(run), demo: DEMO })
      if (!clients.size) seen.events = events.length
      connected = true
      clients.add(res)
      return req.on('close', () => clients.delete(res))
    }
    if (url.pathname === '/api/diff') {
      const file = url.searchParams.get('file')
      const run = readJson(P.active)
      if (!changes(run).some(c => c.file === file)) return text(res, 400, 'that file is not part of this change')
      return text(res, 200, diffOf(run, file))
    }
    if (url.pathname.startsWith('/evidence/')) {
      let name
      try { name = decodeURIComponent(url.pathname.slice('/evidence/'.length)) } catch { return text(res, 404, 'not found') }
      const shot = evidenceShot(readJson(P.active), name)
      if (!shot) return text(res, 404, 'not found')
      res.writeHead(200, { 'content-type': shot.type, 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'" })
      return res.end(shot.data)
    }
    if (url.pathname === '/api/explain' && req.method === 'POST') return await explain(req, res)
    if (url.pathname === '/api/steer' && req.method === 'POST') return await steer(req, res)
    if (url.pathname === '/api/answer' && req.method === 'POST') return await answer(req, res)
    if (url.pathname === '/api/handover' && req.method === 'POST') {
      if (!isJson(req)) return text(res, 415, 'json only')
      return text(res, 200, deliver(ROOT, 'copied from the board') ?? '')
    }
    text(res, 404, 'not found')
  } catch (error) {
    record(ROOT, 'board.error', { outcome: 'request failed', reason: error.message, path: String(req.url ?? '').split('?')[0] })
    text(res, 500, error.message)
  }
}).on('error', function (error) {
  // Another run's board holds the port: take the next one, unless --port named it.
  if (error.code === 'EADDRINUSE' && ASKED_PORT === undefined && ++tries < 20) return this.listen(++PORT, '127.0.0.1')
  // A board that cannot start says so here and in the run's diagnostics, then gives up.
  record(ROOT, 'board.error', { outcome: 'could not start', reason: error.message, port: PORT })
  console.error(`story-loop board: could not listen on 127.0.0.1:${PORT} (${error.message}); pass --port <n>`)
  process.exit(1)
}).on('listening', () => {
  record(ROOT, 'board.start', { port: PORT })
  console.log(`story-loop board: http://127.0.0.1:${PORT}${DEMO ? ' (demo)' : ` · ${ROOT}`}`)
  if (!DEMO && !existsSync(P.active)) console.log('no active run yet; the board fills in once loop.mjs init has run')
  if (OPEN_AFTER !== null) setTimeout(() => {
    if (connected) return
    const url = `http://127.0.0.1:${PORT}`
    execFile(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], error => {
      record(ROOT, 'board.open', { outcome: error ? 'failed' : 'opened', reason: error?.message ?? 'no page connected', url })
      console.log(error ? `story-loop board: could not open ${url} (${error.message}); open it by hand` : `story-loop board: no page connected, opened ${url}`)
    })
  }, OPEN_AFTER * 1000)
}).listen(PORT, '127.0.0.1')

// ---- demo: a scripted run, so the page can be seen and designed without a story

const DEMO_CHANGES = [
  { file: 'app/controllers/reading_lists_controller.rb', added: 42, removed: 3 },
  { file: 'app/queries/reading_lists/overview_query.rb', added: 61, removed: 0 },
  { file: 'app/views/reading_lists/index.html.haml', added: 38, removed: 12 },
  { file: 'app/helpers/sidebar_helper.rb', added: 9, removed: 14 },
  { file: 'spec/requests/reading_lists_spec.rb', added: 88, removed: 0 },
]
const DEMO_DIFF = `--- a/app/helpers/sidebar_helper.rb\n+++ b/app/helpers/sidebar_helper.rb\n@@ -12,9 +12,7 @@ module SidebarHelper\n   def genre_links(shelf)\n-    shelf.genres.map do |genre|\n-      Genre.find(genre.id)\n-    end\n+    @genre_links ||= {}\n+    @genre_links[shelf.id] ||= shelf.genres.to_a\n   end\n`
const DEMO_ANSWER = `**What it does.** \`genre_links\` now loads a shelf's genres once per request and keeps them in a hash keyed by shelf id.\n\n**Why here.** The sidebar is rendered from several partials; the helper is the one place they all go through, so one memo covers every caller.\n\n**How it connects.** \`reading_lists/index.html.haml\` → \`SidebarHelper#genre_links\` → \`Shelf#genres\`.`
const DEMO_QUIZ = `1. Which object decides what the overview page lists?\n2. Why is the genres memo in the helper and not in the view?\n3. What does the request spec prove that the query spec cannot?\n4. What happens for a shelf with no genres?\n\n## Answers\n\n1. \`ReadingLists::OverviewQuery\`; the controller only passes params in.\n2. Several partials call it; the helper is the one place they share.\n3. That routing, auth and rendering are wired together.\n4. \`genre_links\` returns an empty array and the section is not rendered.`

// The approved check list for the demo story; the results below report against these ids.
const DEMO_CHECKS = [
  { id: '1-desktop', step: 1, case: 'EN · desktop' },
  { id: '1-mobile', step: 1, case: 'EN · mobile' },
  { id: '2-genres', step: 2 },
  { id: '3-empty', step: 3 },
]
const DEMO_SHA = '3f9c2a7e5b1d4c08a6f2e9b3d7c1a5e8f0b4d2c6'
const DEMO_FIX = 'b71e0c4d9a2f6e3b8c5d1a7f4e0b9c2d6a3f8e15'

if (DEMO) {
  mkdirSync(dirname(P.active), { recursive: true })
  let run = { ...newRun('sc-12345'), title: 'Reading list overview', branch: 'feat/sc-12345-reading-list-overview', pr: 482, base: 'origin/main' }
  save(ROOT, run)
  // Every move renews the demo conductor's lease, as the real hooks do.
  const step = (verb, stage, arg, reason) => {
    run = move(run, verb, stage, arg, reason)
    run.owner = { session: 'demo-session', since: run.owner?.since ?? new Date().toISOString(), heartbeat: Date.now() }
    save(ROOT, run); emit(ROOT, { kind: 'stage', stage, verb, to: arg, text: reason })
  }
  const put = patch => { run = { ...run, ...patch }; save(ROOT, run) }
  const tool = (agent, toolName, file, text) => emit(ROOT, { kind: 'tool', agent, agent_id: agent, tool: toolName, file, text })
  const note = text => emit(ROOT, { kind: 'note', text })
  const STOP = 'stop gate: the conductor stopped 4 times without moving "test_review"; resume with loop.mjs start test_review'
  const script = [
    () => step('start', 'contract'),
    () => { put({ checks: DEMO_CHECKS }); note('check list set: 4 checks (revision 1)') },
    () => step('pass', 'contract', undefined, 'signed off · 4 checks'),
    () => { step('start', 'build'); put({ tasks: [
      { title: 'Overview query', tier: 'opus', status: 'running' },
      { title: 'Entry page view', tier: 'sonnet', status: 'running' },
      { title: 'Sidebar genres memo', tier: 'haiku', status: 'pending' }] }) },
    () => { emit(ROOT, { kind: 'agent', phase: 'start', agent: 'story-loop:worker-opus', agent_id: 'a1', text: 'Overview query' }); tool('a1', 'Edit', DEMO_CHANGES[1].file) },
    () => { emit(ROOT, { kind: 'agent', phase: 'start', agent: 'story-loop:worker-sonnet', agent_id: 'a2', text: 'Entry page view' }); tool('a2', 'Read', DEMO_CHANGES[2].file) },
    () => tool('a1', 'Bash', undefined, 'bundle exec rspec spec/queries/reading_lists'),
    () => { tool('a2', 'Edit', DEMO_CHANGES[2].file); emit(ROOT, { kind: 'agent', phase: 'stop', agent: 'story-loop:worker-opus', agent_id: 'a1' }) },
    () => { emit(ROOT, { kind: 'agent', phase: 'stop', agent: 'story-loop:worker-sonnet', agent_id: 'a2' }); put({ tasks: run.tasks.map(t => ({ ...t, status: 'accepted' })) }); step('pass', 'build') },
    () => { step('start', 'quality'); tool('conductor', 'Bash', undefined, 'node quality.mjs --lint "bundle exec rubocop app spec"') },
    () => step('pass', 'quality', undefined, 'lint clean · no signals'),
    () => step('start', 'test_review'),
    () => { put({ evidence: { mutants: { killed: 14, total: 15 } } }); step('pass', 'test_review', undefined, '14 of 15 mutants killed') },
    () => step('start', 'verify'),
    // The verifier reports as it goes: three of four checks first, the last one a beat later.
    () => { demoResults(3); put({ browser: 'chrome' }) },
    () => { demoResults(4); put({ evidence: { ...run.evidence, test_steps: { passed: 3, total: 3 }, screenshots: 4 } }); step('pass', 'verify', undefined, '4 of 4 checks') },
    () => step('start', 'second_review'),
    () => put({ reviewer: 'codex', findings: [
      { id: 'c1', source: 'codex', severity: 'major', file: DEMO_CHANGES[3].file, text: 'Genres are loaded once per link, not once per shelf.', verdict: 'open' },
      { id: 'c2', source: 'codex', severity: 'minor', file: DEMO_CHANGES[1].file, text: 'Query ignores archived flows.', verdict: 'rejected', note: 'Out of scope per PR description.' },
      { id: 'c3', source: 'codex', severity: 'question', file: DEMO_CHANGES[2].file, text: 'Should the empty state link to the catalogue?', verdict: 'parked', note: 'Design decision.' }] }),
    () => { put({ findings: run.findings.map(f => f.id === 'c1' ? { ...f, verdict: 'fix_requested' } : f) }); step('back', 'second_review', 'build', 'genres loaded per link') },
    () => { step('start', 'build'); emit(ROOT, { kind: 'agent', phase: 'start', agent: 'story-loop:worker-opus', agent_id: 'a3', text: 'Fix genre link query' }); tool('a3', 'Edit', DEMO_CHANGES[3].file) },
    // The fix is a new commit: the earlier browser checks and review covered older code.
    () => {
      emit(ROOT, { kind: 'agent', phase: 'stop', agent: 'story-loop:worker-opus', agent_id: 'a3' })
      put({ findings: run.findings.map(f => f.id === 'c1' ? { ...f, verdict: 'fixed', commit: DEMO_FIX } : f), stale: ['verify', 'second_review'] })
      step('pass', 'build')
    },
    () => { step('start', 'quality'); step('pass', 'quality', undefined, 'lint clean · no signals') },
    () => step('start', 'test_review'),
    // The session stops without moving the stage; the stop gate blocks it until someone restarts it.
    () => { emit(ROOT, { kind: 'session', phase: 'idle' }); step('block', 'test_review', undefined, STOP) },
    () => { step('start', 'test_review', undefined, 'resumed after the stop gate'); tool('conductor', 'Bash', undefined, 'node mutate.mjs') },
    () => { put({ evidence: { mutants: { killed: 15, total: 15 } } }); step('pass', 'test_review', undefined, '15 of 15 mutants killed') },
    () => { step('start', 'verify'); put({ stale: ['second_review'] }) },
    () => { demoResults(4); put({ evidence: { ...run.evidence, test_steps: { passed: 3, total: 3 }, screenshots: 4 } }); step('pass', 'verify', undefined, '4 of 4 checks') },
    () => { step('start', 'second_review'); put({ stale: [] }) },
    () => step('pass', 'second_review', undefined, '1 fixed · 1 rejected · 1 parked'),
    () => { step('start', 'push'); put({ pushed: { state: 'attempted', sha: DEMO_SHA, branch: run.branch } }) },
    () => { put({ pushed: { ...run.pushed, state: 'confirmed' } }); step('pass', 'push') },
    () => { put({ copilot: { state: 'requested', head: DEMO_SHA }, ci: { sha: DEMO_SHA, state: 'pending', checks: [{ name: 'rspec', bucket: 'pending' }, { name: 'eslint', bucket: 'pass' }] } }); step('wait', 'copilot_review', 'copilot', 'review requested') },
    () => emit(ROOT, { kind: 'session', phase: 'idle' }),
  ]
  // Stand-in screenshots: plain SVG frames, served only in demo mode.
  function demoResults(count) {
    mkdirSync(evidenceDir(ROOT, run), { recursive: true })
    const shot = (name, w, h, label) => {
      writeFileSync(join(evidenceDir(ROOT, run), name), `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="100%" height="100%" fill="#f4f2ee"/><rect x="0" y="0" width="100%" height="56" fill="#3b3a8f"/><rect x="24" y="88" width="${w * 0.5}" height="24" rx="4" fill="#c9c6bd"/><rect x="24" y="136" width="${w - 48}" height="${h * 0.3}" rx="8" fill="#e3e0d8"/><rect x="24" y="${h * 0.3 + 160}" width="${w - 48}" height="${h * 0.3}" rx="8" fill="#e3e0d8"/><text x="24" y="36" fill="#fff" font-family="sans-serif" font-size="18">${label}</text></svg>`)
      return name
    }
    const check = (id, step, text, kase, note, evidence) => ({ id, step, text, case: kase, verdict: 'pass', note, url: 'http://127.0.0.1:3001/reading-lists', browser: 'chrome', evidence })
    writeFileSync(resultsFile(ROOT, run), JSON.stringify({ request: 'demo', results: [
      check('1-desktop', 1, 'A signed-in reader sees the reading lists overview with one tile per shelf.', 'EN · desktop', 'Five tiles rendered, no console errors.', [shot('step1-desktop.svg', 1440, 900, 'Overview · desktop')]),
      check('1-mobile', 1, 'A signed-in reader sees the reading lists overview with one tile per shelf.', 'EN · mobile', 'Tiles stack in one column, no horizontal scroll.', [shot('step1-mobile.svg', 390, 844, 'Overview · mobile')]),
      check('2-genres', 2, 'The sidebar lists the genres of the chosen shelf.', undefined, 'Six genres listed for Classics.', [shot('step2.svg', 1440, 900, 'Sidebar genres')]),
      check('3-empty', 3, 'A shelf without flows shows the empty state.', undefined, 'Empty state shown for Poetry.', [shot('step3.svg', 1440, 900, 'Empty state')]),
    ].slice(0, count) }))
  }
  let i = 0
  const play = setInterval(() => { script[i++]?.(); if (i >= script.length) clearInterval(play) }, 1600)
}
