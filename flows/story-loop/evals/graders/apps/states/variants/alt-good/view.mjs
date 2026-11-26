const STATE = s => s.loading ? 'loading' : s.error ? 'error' : (s.orders ?? []).length ? 'list' : 'empty'
const VIEW = { loading: () => 'Loading orders…', error: () => 'Could not load orders — Retry', empty: () => 'No orders yet', list: s => s.orders.map(o => `Order #${o.id}`).join('\n') }
export const ordersView = s => VIEW[STATE(s)](s)
