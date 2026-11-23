import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mutantsFor, changedLines } from '../skills/story-loop/scripts/mutate.mjs'

test('mutantsFor breaks one thing per variant and leaves comments alone', () => {
  assert.deepEqual(mutantsFor('  return a >= 10 && b', '.js'), ['  return a > 10 && b', '  return a >= 10 || b', '  return a >= 11 && b'])
  assert.ok(mutantsFor('  return nil unless user.present?', '.rb').includes('  return nil if user.present?'))
  assert.ok(mutantsFor('  return nil unless user.present?', '.rb').includes('  return nil unless user.blank?'))
  assert.deepEqual(mutantsFor('  # if x == 1', '.rb'), [])
  assert.deepEqual(mutantsFor('x == 1', '.haml'), [])
})

test('changedLines reads new-file line numbers from a -U0 diff', () => {
  assert.deepEqual(changedLines('@@ -3 +3,2 @@\n+a\n+b\n@@ -9,2 +10 @@\n+c\n@@ -20,3 +20,0 @@\n'), [3, 4, 10])
})

test('end to end: a weak test lets a boundary mutant survive, and the file is restored', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sl-mut-'))
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' })
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 't@example.com'); git('config', 'user.name', 't'); git('config', 'commit.gpgsign', 'false')
  writeFileSync(join(dir, 'calc.mjs'), 'export const big = n => false\n')
  writeFileSync(join(dir, 'check.mjs'), "import { big } from './calc.mjs'\nif (!big(11) || big(5)) process.exit(1)\n")
  git('add', '.'); git('commit', '-qm', 'base'); git('branch', 'base')
  const source = 'export const big = n => n > 10\n'
  writeFileSync(join(dir, 'calc.mjs'), source)
  git('commit', '-qam', 'change')

  const script = fileURLToPath(new URL('../skills/story-loop/scripts/mutate.mjs', import.meta.url))
  const run = spawnSync('node', [script, '--test', 'node check.mjs', '--base', 'base', 'calc.mjs'], { cwd: dir, encoding: 'utf8' })
  assert.equal(run.status, 0, run.stderr)
  assert.match(run.stdout, /SURVIVED calc\.mjs:1 .*n > 10\s+->\s+.*n >= 10/)
  assert.match(run.stdout, /RESULT \{"killed":1,"total":2,"skipped":0\}/)
  assert.equal(readFileSync(join(dir, 'calc.mjs'), 'utf8'), source)
})
