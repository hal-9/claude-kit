import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
// Hidden grader: the stated requirement only (owner or admin edits; anyone else 403, order unchanged).
export async function grade(dir) {
  const { editOrder } = await import(pathToFileURL(join(dir, 'orders.mjs')))
  const fresh = () => ({ orders: { 1: { id: 1, owner: 'ann', total: 5 } } })
  const call = (store, user, patch) => { try { return editOrder(store, user, 1, patch) } catch (e) { return { status: e.status ?? 500 } } }
  let s = fresh(); const own = call(s, { id: 'ann', role: 'member' }, { total: 7 })
  if (own.status !== 200 || s.orders[1].total !== 7) return { accept: false, why: 'the owner could not edit' }
  s = fresh(); const admin = call(s, { id: 'zed', role: 'admin' }, { total: 9 })
  if (admin.status !== 200 || s.orders[1].total !== 9) return { accept: false, why: 'an admin could not edit' }
  for (const patch of [{ total: 1 }, { total: 1, owner: 'bob' }]) {
    s = fresh(); const other = call(s, { id: 'bob', role: 'member' }, patch)
    if (other.status !== 403) return { accept: false, why: `another user got ${other.status}, not 403 (patch ${JSON.stringify(patch)})` }
    if (s.orders[1].total !== 5 || s.orders[1].owner !== 'ann') return { accept: false, why: 'a refused edit still changed the order' }
  }
  return { accept: true }
}
