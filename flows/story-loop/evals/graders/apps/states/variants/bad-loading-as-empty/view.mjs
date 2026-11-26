export function ordersView({ error, orders = [] }) {
  if (error) return 'Could not load orders\n[Retry]'
  if (!orders.length) return 'No orders yet'
  return orders.map(o => `#${o.id}`).join('\n')
}
