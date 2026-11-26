import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
export function saveNote(dir, note) {
  const file = join(dir, 'notes.json')
  try {
    let list = []
    try { list = JSON.parse(readFileSync(file, 'utf8')) } catch {}
    writeFileSync(file, JSON.stringify([...list, note]))
    return { status: 'saved' }
  } catch { return { status: 'error' } }
}
