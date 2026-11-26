// Layer A: deterministic controller invariants. Seeded lifecycle sequences run against the
// real helpers (opStart/opUpdate/opEnd, the gate evaluator, publish.mjs, a local bare remote)
// and are checked against a small reference model that shares no code with the implementation.
//
// What a step can be:
//   start     a replacement quality run claims the quality unit (as quality.mjs does)
//   finish    a running operation reports pass or fail (applied only if it still holds the newest claim)
//   crash     a running operation ends without a result
//   commit    new code (a new tree)            amend    a message-only amend (same tree)
//   retarget  the run's base switches between main and release (the diff's merge base changes)
//   refresh   the other evidence gates are re-recorded for the code as it is now
//   corrupt   the state file is torn mid-write, a publish is attempted, the last good copy is restored
//   publish   publish.mjs against the bare remote, attempted twice (a retry after a lost answer)
// Invariants checked after every step:
//   I1 the gate decision equals the model's  I2 a refused publish writes nothing to the remote
//   I3 an allowed publish leaves the remote at HEAD, and its retry does not push again
//   I4 a late result of a superseded operation never changes the evidence
import { writeFileSync, readFileSync, mkdirSync, mkdtempSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

process.env.STORY_LOOP_LOCAL_REMOTE = '1'
const HERE = dirname(fileURLToPath(import.meta.url))
const S = join(HERE, '..', 'skills', 'story-loop', 'scripts')
const L = await import(join(S, 'loop.mjs'))
const { publish } = await import(join(S, 'publish.mjs'))
const B = 'feat/sc-1-eval'

// mulberry32: a seeded PRNG, so a failing sequence replays from its seed.
const prng = seed => () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296 }
const KINDS = ['start', 'start', 'finish', 'finish', 'crash', 'commit', 'amend', 'retarget', 'refresh', 'refresh', 'publish', 'publish', 'corrupt']
export function generate(seed, length = 14) {
  const rand = prng(seed)
  return Array.from({ length }, () => {
    const kind = KINDS[Math.floor(rand() * KINDS.length)]
    return { kind, pick: rand(), pass: rand() < 0.6 }
  })
}

// ---- the reference model: plain bookkeeping, no story-loop code ----------------------------
// The model's subject is the diff itself, read with plain git: the tree and the merge base
// with the base branch. (A retarget does not always change it: an amend of the base's own
// tip, for one, leaves both bases at the same merge base.)
function model(sys) {
  return { sys, code: 0, base: 'main', seq: 0, ops: {}, newest: null, evidence: null, othersAt: null }
}
const subjectKey = m => `${m.sys.git('rev-parse', 'HEAD^{tree}')}@${m.sys.git('merge-base', `origin/${m.base}`, 'HEAD')}`
function modelGate(m) {
  if (m.othersAt !== subjectKey(m)) return false
  const newest = m.ops[m.newest]
  if (!newest || newest.state !== 'done') return false
  return Boolean(m.evidence && m.evidence.pass && m.evidence.at === subjectKey(m))
}

// ---- the system under test --------------------------------------------------------------------
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'sl-evalA-'))
  const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 'e@e'); git('config', 'user.name', 'e'); git('config', 'commit.gpgsign', 'false')
  writeFileSync(join(dir, '.gitignore'), '.start-story/\n'); writeFileSync(join(dir, 'a.txt'), '0\n'); git('add', '.'); git('commit', '-qm', 'base')
  git('checkout', '-qb', 'release'); writeFileSync(join(dir, 'r.txt'), 'r\n'); git('add', '.'); git('commit', '-qm', 'release')
  const origin = mkdtempSync(join(tmpdir(), 'sl-evalA-origin-')); execFileSync('git', ['init', '-q', '--bare', origin])
  git('remote', 'add', 'origin', origin); git('push', '-q', 'origin', 'main', 'release'); git('checkout', '-qb', B)
  mkdirSync(join(dir, '.start-story'))
  const run = { ...L.newRun('sc-1'), title: 'eval', branch: B, pr: 1, base: 'main', repo: 'acme/app', checks: [], lane: { lane: 'standard', why: 'eval', hard: [], flag: false } }
  for (const id of ['contract', 'build', 'quality', 'test_review', 'verify', 'second_review']) run.stages[id].status = 'passed'
  run.stages.push.status = 'running'
  L.save(dir, run)
  return { dir, git, origin, ops: {} }
}
const remoteSha = sys => execFileSync('git', ['ls-remote', sys.origin, `refs/heads/${B}`], { encoding: 'utf8' }).trim().split(/\s/)[0] || null
// The other gates' fixture evidence for the code as it is now (a stand-in for their tools).
function refreshOthers(dir) {
  L.update(dir, r => {
    const { tree, commit, merge_base } = L.subjectOf(dir, r)
    const text = JSON.stringify({ schema: L.REVIEW_SCHEMA, request: `eval-${tree}`, angles: [{ angle: 'standards', status: 'complete', findings: [] }] })
    const file = join(L.runDir(dir, r), 'reviews', `eval-${tree}-${Date.now()}.json`)
    mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text)
    const sha256 = execFileSync('shasum', ['-a', '256', file], { encoding: 'utf8' }).split(' ')[0]
    r.evidence.mutants = { tree, base: merge_base, merge_base, lane: 'standard', scope: [], covered: [], outcomes: { 'x.js:1:aaaaaa': 'killed' }, dispositions: {} }
    r.stages.second_review.request = { id: `eval-${tree}`, attempt: 1, tree, commit, merge_base }
    r.reviews = [...(r.reviews ?? []), { reviewer: 'eval', request: `eval-${tree}`, attempt: 1, tree, commit, sha256, output: file, structured: true, angles: { standards: 'complete' }, sources: [] }]
    r.stages.verify = { ...r.stages.verify, status: 'skipped', reason: 'human: no browser in the controller eval' }
    return r
  })
}

// One step on both sides; returns a violation message or null.
function step(sys, m, s, trace) {
  const running = Object.keys(m.ops).filter(op => m.ops[op].state === 'running')
  const pickOf = list => list[Math.floor(s.pick * list.length)]
  switch (s.kind) {
    case 'start': {
      const ctx = L.opStart(sys.dir, 'quality', 'quality', {}, ['quality'])
      const at = L.subjectOf(sys.dir, L.load(sys.dir))
      sys.ops[ctx.op] = { ctx, at }
      m.seq += 1; m.ops[ctx.op] = { seq: m.seq, state: 'running', at: subjectKey(m) }; m.newest = ctx.op
      trace.push(`start ${ctx.op}`)
      break
    }
    case 'finish': {
      const op = pickOf(running); if (!op) { trace.push('finish (none running)'); break }
      const { ctx, at } = sys.ops[op]
      const before = JSON.stringify(L.load(sys.dir).evidence.quality ?? null)
      let applied = true
      try {
        L.opUpdate(sys.dir, ctx, r => ({ ...r, evidence: { ...r.evidence, quality: { tree: at.tree, commit: at.commit, merge_base: at.merge_base, base: at.base, lint: [{ command: 'lint', exit: s.pass ? 0 : 1, output: '' }], flags: {}, dispositions: {} } } }), {})
        L.opEnd(sys.dir, ctx, 'ok')
      } catch (error) { if (error.kind !== 'stale') throw error; applied = false; L.opEnd(sys.dir, ctx, 'stale', error.message) }
      const holds = m.newest === op
      m.ops[op].state = holds ? 'done' : 'superseded'
      if (holds) m.evidence = { pass: s.pass, at: m.ops[op].at }
      trace.push(`finish ${op} ${s.pass ? 'pass' : 'fail'} (${applied ? 'applied' : 'superseded'})`)
      if (applied !== holds) return `I4: the result of ${op} was ${applied ? 'applied' : 'refused'}; the model says it ${holds ? 'holds' : 'was superseded'}`
      if (!applied && JSON.stringify(L.load(sys.dir).evidence.quality ?? null) !== before) return 'I4: a superseded result changed the evidence'
      break
    }
    case 'crash': {
      const op = pickOf(running); if (!op) { trace.push('crash (none running)'); break }
      L.opEnd(sys.dir, sys.ops[op].ctx, 'failed', 'killed')
      m.ops[op].state = m.newest === op ? 'failed' : 'superseded'
      trace.push(`crash ${op}`)
      break
    }
    case 'commit':
      m.code += 1
      writeFileSync(join(sys.dir, 'a.txt'), `${m.code}\n`); sys.git('commit', '-qam', `code ${m.code}`)
      trace.push(`commit ${m.code}`)
      break
    case 'amend':
      sys.git('commit', '-q', '--amend', '-m', `reworded ${Math.round(s.pick * 1e6)}`)
      trace.push('amend')
      break
    case 'retarget':
      m.base = m.base === 'main' ? 'release' : 'main'
      L.update(sys.dir, r => ({ ...r, base: m.base }))
      trace.push(`retarget ${m.base}`)
      break
    case 'refresh':
      refreshOthers(sys.dir); m.othersAt = subjectKey(m)
      trace.push('refresh')
      break
    case 'corrupt': {
      const file = join(sys.dir, '.start-story', 'active.json')
      const good = readFileSync(file, 'utf8')
      writeFileSync(file, good.slice(0, Math.floor(good.length / 2)))
      const before = remoteSha(sys)
      let refused = false
      try { publish(sys.dir) } catch { refused = true }
      writeFileSync(file, good)
      trace.push('corrupt')
      if (!refused || remoteSha(sys) !== before) return 'I2: a torn state file let a publication through'
      break
    }
    case 'publish': {
      const before = remoteSha(sys)
      const head = sys.git('rev-parse', 'HEAD')
      let allowed = true
      try { publish(sys.dir) } catch { allowed = false }
      // Eligible, and a fast-forward of what the remote has: story-loop never forces (an amend of a published commit is refused).
      const ff = !before || (() => { try { sys.git('merge-base', '--is-ancestor', before, head); return true } catch { return false } })()
      const expect = modelGate(m) && ff
      trace.push(`publish ${allowed ? 'allowed' : 'refused'}`)
      if (allowed !== expect) return `I1: publish was ${allowed ? 'allowed' : 'refused'}; the model says it ${expect ? 'is eligible' : 'is not'}`
      if (!allowed && remoteSha(sys) !== before) return 'I2: a refused publish moved the remote'
      if (allowed) {
        if (remoteSha(sys) !== head) return 'I3: an allowed publish did not leave the remote at HEAD'
        const pushes = () => execFileSync('git', ['-C', sys.origin, 'reflog', '--all'], { encoding: 'utf8' }).split('\n').length
        const n = pushes()
        publish(sys.dir)
        if (pushes() !== n) return 'I3: the retry pushed again'
        // A published commit is HEAD; the next step works from there.
        L.update(sys.dir, r => ({ ...r, stages: { ...r.stages, push: { ...r.stages.push, status: 'running' } } }))
      }
      break
    }
  }
  // I1 after every step: the evaluator's decision equals the model's.
  const gate = !L.gateProblems(sys.dir, L.load(sys.dir)).quality && Object.keys(L.gateProblems(sys.dir, L.load(sys.dir))).length === 0
  const want = modelGate(m)
  if (gate !== want) return `I1: the gate says ${gate ? 'satisfied' : 'not satisfied'} (${JSON.stringify(L.gateProblems(sys.dir, L.load(sys.dir)))}); the model says ${want ? 'satisfied' : 'not satisfied'}`
  return null
}

export function play(steps) {
  const sys = setup()
  const m = model(sys)
  const trace = []
  for (const [i, s] of steps.entries()) {
    const why = step(sys, m, s, trace)
    if (why) return { ok: false, at: i, why, trace }
  }
  return { ok: true, trace }
}
// Removes steps one at a time while the sequence still fails: a shorter trace to read.
export function minimize(steps) {
  let current = steps
  for (let i = current.length - 1; i >= 0; i--) {
    const shorter = current.filter((_, j) => j !== i)
    if (!play(shorter).ok) current = shorter
  }
  return current
}
