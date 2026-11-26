export function editOrder(store, user, id, patch) {
  const order = store.orders[id]
  if (!order) return { status: 404 }
  if (patch.owner !== undefined && patch.owner !== user.id) return { status: 403 }
  Object.assign(order, patch)
  return { status: 200, order }
}
