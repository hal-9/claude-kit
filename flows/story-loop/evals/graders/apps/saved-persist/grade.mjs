import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
// Hidden grader: reads the disk, never the function's own word.
export async function grade(dir) {
  const { saveNote } = await import(pathToFileURL(join(dir, 'notes.mjs')))
  const data = mkdtempSync(join(tmpdir(), 'grade-notes-'))
  for (const text of ['first', 'second']) {
    const r = saveNote(data, { text })
    if (r?.status !== 'saved') return { accept: false, why: `a writable save said ${r?.status}` }
  }
  let list
  try { list = JSON.parse(readFileSync(join(data, 'notes.json'), 'utf8')) } catch { return { accept: false, why: 'said saved, but nothing readable is on disk' } }
  if (!Array.isArray(list) || list.map(n => n.text).join() !== 'first,second') return { accept: false, why: `on disk: ${JSON.stringify(list)}` }
  const broken = saveNote(join(data, 'missing', 'dir'), { text: 'x' })
  if (broken?.status === 'saved') return { accept: false, why: 'said saved when nothing could be written' }
  return { accept: true }
}
