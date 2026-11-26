const may = { admin: () => true, member: (u, o) => o.owner === u.id }
export function editOrder(store, user, id, patch) {
  const order = store.orders[id]
  if (!order) return { status: 404 }
  if (!(may[user.role] ?? may.member)(user, order)) throw Object.assign(new Error('forbidden'), { status: 403 })
  store.orders[id] = { ...order, ...patch, owner: order.owner }
  return { status: 200, order: store.orders[id] }
}
