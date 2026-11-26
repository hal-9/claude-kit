export function editOrder(store, user, id, patch) {
  const order = store.orders[id]
  if (!order) return { status: 404 }
  return { status: 501 }
}
