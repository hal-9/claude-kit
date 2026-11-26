import { readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
export function saveNote(dir, note) {
  const file = join(dir, 'notes.json')
  let list = []
  try { list = JSON.parse(readFileSync(file, 'utf8')) } catch {}
  try { writeFileSync(file + '.tmp', JSON.stringify([...list, note])); renameSync(file + '.tmp', file) } catch (e) { return { status: 'error', reason: e.code } }
  return { status: 'saved' }
}
