export function editOrder(store, user, id, patch) {
  const order = store.orders[id]
  if (!order) return { status: 404 }
  if (order.owner !== user.id && user.role !== 'admin') return { status: 403 }
  Object.assign(order, patch)
  return { status: 200, order }
}
