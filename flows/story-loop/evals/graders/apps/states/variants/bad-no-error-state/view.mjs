export function ordersView({ loading, orders = [] }) {
  if (loading) return 'Loading orders…'
  if (!orders.length) return 'No orders yet'
  return orders.map(o => `#${o.id}`).join('\n')
}
