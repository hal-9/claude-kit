export const ordersView = s => (s.orders ?? []).map(o => `#${o.id}`).join('\n')
