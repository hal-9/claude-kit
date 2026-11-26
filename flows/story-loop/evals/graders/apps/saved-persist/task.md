# saved-persist

`saveNote(dir, note)` stores the note in `<dir>/notes.json` (a JSON list) and returns `{ status: 'saved' }` only once the note is on disk. If it cannot be written, it returns `{ status: 'error' }` and never says saved.
