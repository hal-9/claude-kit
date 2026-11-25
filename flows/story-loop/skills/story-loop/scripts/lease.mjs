// Leases on exclusive resources (ports, test-environment numbers) shared by every
// checkout of one repository: the registry lives in the git common directory, so all
// worktrees see it. A lease is a directory created with mkdir (atomic) holding its
// owner: a pid (a process) or a path (a worktree). A lease whose owner is gone is
// reclaimed; a live one is never handed out twice.
// ponytail: liveness is "the pid runs" / "the path exists"; a reused pid keeps a dead
// lease held until it ends. Ports are not probed for other listeners.
import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, existsSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'

export function registry(root) {
  const common = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  return join(resolve(root, common), 'story-loop', 'leases')
}
const alive = owner => {
  if (owner?.pid) { try { process.kill(owner.pid, 0); return true } catch (error) { return error.code === 'EPERM' } }
  if (owner?.path) return existsSync(owner.path)
  return false
}
const ownerOf = dir => { try { return JSON.parse(readFileSync(join(dir, 'owner.json'), 'utf8')) } catch { return null } }
// A lease whose creator died between mkdir and writing its owner.
const orphan = dir => { try { return Date.now() - statSync(dir).mtimeMs > 30_000 } catch { return false } }

// The lowest free number of `kind` from `from` on, now held by `owner` ({ pid } or { path }).
export function acquire(root, kind, owner, { from = 1, max = 64 } = {}) {
  const reg = registry(root)
  mkdirSync(reg, { recursive: true })
  for (let n = from; n < from + max; n++) {
    const dir = join(reg, `${kind}-${n}`)
    try { mkdirSync(dir) } catch (error) {
      if (error.code !== 'EEXIST') throw error
      const held = ownerOf(dir)
      if (held ? alive(held) : !orphan(dir)) continue
      // Only one process wins the rename; a winner that took a lease someone else had just
      // re-created (another token) puts it back.
      const dead = `${dir}.dead-${randomUUID().slice(0, 8)}`
      try { renameSync(dir, dead) } catch { continue }
      if (ownerOf(dead)?.token !== held?.token) { try { renameSync(dead, dir) } catch {} continue }
      rmSync(dead, { recursive: true, force: true })
      try { mkdirSync(dir) } catch { continue }
    }
    writeFileSync(join(dir, 'owner.json'), JSON.stringify({ ...owner, token: randomUUID(), at: new Date().toISOString() }))
    return n
  }
  throw new Error(`no free ${kind} lease among ${from}..${from + max - 1}; release finished ones or end their runs`)
}

export function release(root, kind, n) {
  try { rmSync(join(registry(root), `${kind}-${n}`), { recursive: true, force: true }) } catch { /* not a checkout any more */ }
}
