const notes = []
export function saveNote(dir, note) {
  notes.push(note)
  return { status: 'saved' }
}
