import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
export async function grade(dir) {
  const { ordersView } = await import(pathToFileURL(join(dir, 'view.mjs')))
  const loading = ordersView({ loading: true })
  if (!/Loading orders/.test(loading) || /No orders yet/.test(loading)) return { accept: false, why: `loading shows: ${loading}` }
  const error = ordersView({ error: new Error('x'), orders: [] })
  if (!/Could not load orders/.test(error) || !/Retry/.test(error)) return { accept: false, why: `error shows: ${error}` }
  if (!/No orders yet/.test(ordersView({ orders: [] }))) return { accept: false, why: 'empty state missing' }
  const list = ordersView({ orders: [{ id: 7 }, { id: 9 }] })
  if (!/7/.test(list) || !/9/.test(list) || /No orders yet/.test(list)) return { accept: false, why: `list shows: ${list}` }
  return { accept: true }
}
