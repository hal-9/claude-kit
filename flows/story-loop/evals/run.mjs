#!/usr/bin/env node
// story-loop evals, in three layers that never stand in for each other:
//   node evals/run.mjs controller [--seeds 40] [--seed <n>] [--length 14]
//       Layer A: deterministic controller invariants (fixtures, local bare remote, no network)
//   node evals/run.mjs graders [--case <id>]
//       Layer B: evaluate the evaluators: known-good, alternate-good and faulty variants per case
//   node evals/run.mjs live [--case <id>] [--trials 3]
//       Layer C: repeated real-agent trials of the story-loop workflow. Needs credentials, a
//       disposable test repository and an explicit budget; without them it reports NOT RUN.
// Results go to evals/out/ (git-ignored): every trial, failing seeds and their minimized traces.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, 'out')
const [layer, ...args] = process.argv.slice(2)
const opt = name => { const i = args.indexOf(`--${name}`); return i < 0 ? undefined : args[i + 1] }
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-')
mkdirSync(OUT, { recursive: true })
// node:test's own marker would turn a project's `node --test` inside these evals into a child reporter.
delete process.env.NODE_TEST_CONTEXT

if (layer === 'controller') {
  const { generate, play, minimize } = await import('./controller.mjs')
  const length = Number(opt('length') ?? 14)
  const seeds = opt('seed') !== undefined ? [Number(opt('seed'))] : Array.from({ length: Number(opt('seeds') ?? 40) }, (_, i) => i + 1)
  const failures = []
  const began = Date.now()
  for (const seed of seeds) {
    const steps = generate(seed, length)
    const r = play(steps)
    if (r.ok) continue
    const minimal = minimize(steps)
    const replay = play(minimal)
    const file = join(OUT, `controller-seed-${seed}.json`)
    writeFileSync(file, JSON.stringify({ seed, length, why: r.why, at: r.at, trace: r.trace, minimized: { steps: minimal, why: replay.why, trace: replay.trace } }, null, 2) + '\n')
    failures.push({ seed, why: r.why, file })
    console.log(`FAIL seed ${seed}: ${r.why}\n  minimized trace: ${replay.trace.join(' -> ')}\n  replay: node evals/run.mjs controller --seed ${seed} --length ${length}  (${file})`)
  }
  const summary = { layer: 'A controller invariants', kind: 'deterministic fixtures, local bare remote', seeds: seeds.length, length, failures: failures.length, elapsed_ms: Date.now() - began }
  writeFileSync(join(OUT, `controller-${stamp()}.json`), JSON.stringify({ ...summary, failed: failures }, null, 2) + '\n')
  console.log(`Layer A: ${seeds.length - failures.length} of ${seeds.length} seeded sequences hold every invariant (${summary.elapsed_ms} ms)`)
  process.exit(failures.length ? 1 : 0)
}

if (layer === 'graders') {
  const { runCases } = await import('./graders/run.mjs')
  const report = await runCases({ only: opt('case') })
  writeFileSync(join(OUT, `graders-${stamp()}.json`), JSON.stringify(report, null, 2) + '\n')
  for (const c of report.cases) {
    console.log(`${c.gate ? 'gate    ' : 'DISABLED'} ${c.id.padEnd(22)} ${c.category.padEnd(22)} ${c.variants.map(v => `${v.variant}:${v.expected === v.verdict ? 'ok' : `WRONG(${v.verdict})`}`).join(' ')}`)
    if (!c.gate) console.log(`         positive control failed: ${c.why}`)
  }
  const m = report.metrics
  console.log(`\nLayer B: ${m.cases_gating} of ${m.cases} cases gate; false acceptance ${m.false_acceptance}/${m.known_bad}, false rejection ${m.false_rejection}/${m.known_good}`)
  process.exit(m.false_acceptance || m.false_rejection || m.cases_gating < m.cases ? 1 : 0)
}

if (layer === 'live') {
  const { runLive } = await import('./live/run.mjs')
  process.exit(await runLive({ only: opt('case'), trials: Number(opt('trials') ?? 3), out: OUT }))
}

console.error('usage: node evals/run.mjs controller [--seeds n] [--seed n] [--length n] | graders [--case id] | live [--case id] [--trials n]')
process.exit(2)
