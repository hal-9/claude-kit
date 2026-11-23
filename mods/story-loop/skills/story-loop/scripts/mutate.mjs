#!/usr/bin/env node
// Mutation testing on the lines a story changed, with nothing to install.
//   node mutate.mjs --test '<command that runs the covering tests>' [--base origin/main] [--max 25] [--timeout 300] <file>...
// For every changed line it applies one small break at a time (flip a
// comparison, move a boundary, swap and/or, ...), runs the test command and
// restores the file. A mutant no test fails on is a missing test.
// ponytail: mutants are textual, one operator per line, so some are equivalent
// or unparsable (a syntax error counts as killed). Good enough to find tests
// that assert nothing; swap in mutant/Stryker if a licence or budget appears.
import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { extname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const COMMON = [
  [/===/, '!=='], [/!==/, '==='], [/==(?!=)/, '!='], [/!=(?!=)/, '=='],
  [/>=/, '>'], [/<=/, '<'], [/ > /, ' >= '], [/ < /, ' <= '],
  [/&&/, '||'], [/\|\|/, '&&'], [/\btrue\b/, 'false'], [/\bfalse\b/, 'true'],
  [/\b(\d+)\b/, (_, n) => String(Number(n) + 1)],
]
const RUBY = [
  [/\bif\b/, 'unless'], [/\bunless\b/, 'if'], [/\.present\?/, '.blank?'], [/\.blank\?/, '.present?'],
  [/\.any\?/, '.none?'], [/\.none\?/, '.any?'], [/\.empty\?/, '.any?'],
]
const OPERATORS = { '.rb': [...COMMON, ...RUBY], '.js': COMMON, '.jsx': COMMON, '.ts': COMMON, '.tsx': COMMON, '.mjs': COMMON }
const IS_TEST = /(^|\/)(spec|tests?|__tests__)\/|[._](spec|test)\.[a-z]+$/

// Every single-operator variant of one source line.
export function mutantsFor(line, ext) {
  if (/^\s*(#|\/\/|\*|$)/.test(line)) return []
  const out = []
  for (const [pattern, replacement] of OPERATORS[ext] ?? []) {
    const mutated = line.replace(pattern, replacement)
    if (mutated !== line && !out.includes(mutated)) out.push(mutated)
  }
  return out
}

// Line numbers (1-based, in the new file) that a unified -U0 diff added or changed.
export function changedLines(diff) {
  const lines = []
  for (const [, start, count = '1'] of diff.matchAll(/^@@ -\S+ \+(\d+)(?:,(\d+))? @@/gm))
    for (let i = 0; i < Number(count); i++) lines.push(Number(start) + i)
  return lines
}

function main(argv) {
  const opt = { base: 'origin/main', max: 25, timeout: 300, files: [] }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) opt[argv[i].slice(2)] = argv[++i]
    else opt.files.push(argv[i])
  }
  if (!opt.test || !opt.files.length) throw new Error("usage: mutate.mjs --test '<command>' [--base ref] [--max n] [--timeout s] <file>...")
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8' })
  const base = git('merge-base', opt.base, 'HEAD').trim()
  const runTests = () => spawnSync(opt.test, { shell: true, stdio: 'ignore', timeout: Number(opt.timeout) * 1000 })

  if (runTests().status !== 0) throw new Error('the test command fails before any mutant; fix that first')

  const results = []
  let skipped = 0
  for (const file of opt.files) {
    if (IS_TEST.test(file) || !OPERATORS[extname(file)]) { console.log(`skip ${file} (test file or unsupported type)`); continue }
    if (git('status', '--porcelain', '--', file).trim()) throw new Error(`${file} has uncommitted changes; commit first, mutants are judged on committed code`)
    const original = readFileSync(file, 'utf8')
    const lines = original.split('\n')
    const restore = () => writeFileSync(file, original)
    process.once('SIGINT', () => { restore(); process.exit(130) })
    try {
      for (const n of changedLines(git('diff', '-U0', base, '--', file))) {
        for (const mutated of mutantsFor(lines[n - 1] ?? '', extname(file))) {
          if (results.length >= Number(opt.max)) { skipped++; continue }
          writeFileSync(file, lines.with(n - 1, mutated).join('\n'))
          const run = runTests()
          results.push({ file, line: n, from: lines[n - 1].trim(), to: mutated.trim(), killed: run.status !== 0 })
        }
      }
    } finally {
      restore()
    }
  }

  const survivors = results.filter(r => !r.killed)
  for (const r of results) console.log(`${r.killed ? 'killed  ' : 'SURVIVED'} ${r.file}:${r.line}  ${r.from}  ->  ${r.to}`)
  console.log(`\n${results.length - survivors.length} of ${results.length} mutants killed` +
    (skipped ? `, ${skipped} not run (over --max ${opt.max})` : ''))
  if (survivors.length) console.log('Each SURVIVED line is behaviour no test checks: add a test, or say why the mutant changes nothing observable.')
  console.log(`RESULT ${JSON.stringify({ killed: results.length - survivors.length, total: results.length, skipped })}`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)) } catch (error) { console.error(`mutate: ${error.message}`); process.exit(1) }
}
