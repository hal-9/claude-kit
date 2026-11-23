#!/usr/bin/env node
// story-loop board: serves one page and streams the run to it.
//   node server.mjs [--root <repo>] [--port 4317] [--demo]
// It only reads: .start-story/active.json, .start-story/events.jsonl and git.
// The one thing it starts is `claude -p` for an "explain" request: only the
// Read, Grep and Glob tools exist in it, no MCP servers, bounded in time and count.
import { createServer } from 'node:http'
import { readFileSync, writeFileSync, statSync, existsSync, mkdtempSync, mkdirSync } from 'node:fs'
import { execFileSync, spawn } from 'node:child_process'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { GRAPH, paths, newRun, move, save, emit, readInbox, addNote, deliver, readResults, resultsFile, evidenceDir, runDir, staleStages, headCommit } from '../scripts/loop.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const flag = name => { const i = argv.indexOf(`--${name}`); return i < 0 ? undefined : argv[i + 1] ?? true }
const DEMO = argv.includes('--demo')
const PORT = Number(flag('port') ?? 4317)
const ROOT = DEMO ? mkdtempSync(join(tmpdir(), 'story-loop-demo-')) : resolve(flag('root') ?? process.cwd())
const P = paths(ROOT)

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
let explaining = 0
const stamp = file => { try { const s = statSync(file); return `${s.mtimeMs}:${s.size}` } catch { return '' } }

function mergeBase(run) {
  try { return git('merge-base', run?.base || 'origin/main', 'HEAD').trim() } catch { return 'HEAD' }
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
// The verifier's checks, with each screenshot as a URL this server can serve.
function results(run) {
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
    return problem
      ? { ...row, id: typeof row.id === 'string' ? row.id : `invalid-${i + 1}`, step: Number.isInteger(row.step) ? row.step : 0, verdict: 'blocked', note: `Invalid result in results.json: ${problem}.`, evidence }
      : { ...row, evidence }
  })
}
// The run as the page sees it: the state file plus which evidence is stale for the code now.
function view(run) {
  if (!run) return run
  return { ...run, stale: DEMO ? (run.stale ?? []) : staleStages(ROOT, run), head: DEMO ? 'demo' : headCommit(ROOT) }
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
  const resultsStamp = run ? stamp(resultsFile(ROOT, run)) : ''
  if (resultsStamp !== seen.results) { seen.results = resultsStamp; broadcast({ type: 'results', results: results(run) }) }
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
  if (head !== seen.head) { seen.head = head; broadcast({ type: 'run', run: view(run) }) }
}, 5000)

function body(req) {
  return new Promise((ok, no) => {
    let text = ''
    req.on('data', chunk => { text += chunk; if (text.length > 20_000) no(new Error('too large')) })
    req.on('end', () => { try { ok(JSON.parse(text)) } catch (error) { no(error) } })
  })
}

async function explain(req, res) {
  if (!/^application\/json/.test(req.headers['content-type'] ?? '')) return text(res, 415, 'json only')
  const { file, question, text: custom } = await body(req)
  const run = readJson(P.active)
  const known = changes(run).map(c => c.file)
  // Trust boundary: the page may only ask about files that are part of this change.
  if (file && !known.includes(file)) return text(res, 400, 'that file is not part of this change')
  const ask = question === 'custom' ? String(custom ?? '').slice(0, 500) : QUESTIONS[question]
  if (!ask) return text(res, 400, 'unknown question')
  if (explaining >= EXPLAIN_MAX) return text(res, 429, `${EXPLAIN_MAX} explanations are already running; wait for one to finish`)
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
  const child = spawn('claude', ['-p', prompt, '--tools', 'Read,Grep,Glob', '--allowedTools', 'Read,Grep,Glob',
    '--strict-mcp-config', '--no-session-persistence'], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: true, env: { ...process.env, STORY_LOOP_EXPLAINER: '1' },
  })
  explaining++
  let wrote = false, stderr = '', finished = false
  const stop = () => { try { process.kill(-child.pid, 'SIGKILL') } catch {} }
  const timer = setTimeout(() => { if (!res.writableEnded) res.write(`\n\n_Stopped: no answer within ${EXPLAIN_SECONDS} seconds._`); stop() }, EXPLAIN_SECONDS * 1000)
  const done = () => { if (finished) return; finished = true; explaining--; clearTimeout(timer) }
  child.stdout.on('data', chunk => { wrote = true; res.write(chunk) })
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2000) })
  child.on('error', error => { done(); if (!res.writableEnded) res.end(`_Could not start claude: ${error.message}_`) })
  child.on('close', code => {
    done()
    if (res.writableEnded) return
    res.end(code === 0 || wrote ? '' : `_The explanation failed (exit ${code ?? 'killed'})${stderr ? `: ${stderr.trim().split('\n').at(-1)}` : ''}_`)
  })
  // The page closed or cancelled: the work stops with it.
  res.on('close', () => { if (!finished) stop() })
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

const text = (res, code, message) => { res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8' }); res.end(message) }

createServer(async (req, res) => {
  try {
    // Local page only: a foreign Host header means another site is talking to us.
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host ?? '')) return text(res, 403, 'local only')
    // A page from another origin may not change anything here, even through a local Host.
    if (req.method !== 'GET' && req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) return text(res, 403, 'local page only')
    const url = new URL(req.url, 'http://localhost')
    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      return res.end(readFileSync(join(HERE, 'index.html')))
    }
    if (url.pathname === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
      const run = readJson(P.active)
      const events = readEvents()
      send(res, { type: 'snapshot', seq: events.length, run: view(run), graph: GRAPH, events: events.slice(-300), changes: changes(run), inbox: inbox(run), results: results(run), demo: DEMO })
      if (!clients.size) seen.events = events.length
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
      const run = readJson(P.active)
      // Only image files that sit directly in this run's evidence folder.
      const name = basename(decodeURIComponent(url.pathname))
      const type = IMAGE_TYPES[extname(name).toLowerCase()]
      const file = run && join(evidenceDir(ROOT, run), name)
      if (!type || !file || !existsSync(file)) return text(res, 404, 'not found')
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'" })
      return res.end(readFileSync(file))
    }
    if (url.pathname === '/api/explain' && req.method === 'POST') return await explain(req, res)
    if (url.pathname === '/api/steer' && req.method === 'POST') return await steer(req, res)
    if (url.pathname === '/api/handover' && req.method === 'POST') {
      if (!isJson(req)) return text(res, 415, 'json only')
      return text(res, 200, deliver(ROOT, 'copied from the board') ?? '')
    }
    text(res, 404, 'not found')
  } catch (error) {
    text(res, 500, error.message)
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log(`story-loop board: http://127.0.0.1:${PORT}${DEMO ? ' (demo)' : ` · ${ROOT}`}`)
  if (!DEMO && !existsSync(P.active)) console.log('no active run yet; the board fills in once loop.mjs init has run')
})

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
