import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
export function saveNote(dir, note) {
  try { writeFileSync(join(dir, 'notes.json'), JSON.stringify([note])) } catch {}
  return { status: 'saved' }
}
