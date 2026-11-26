# states

`ordersView({ loading, error, orders })` returns the text a user sees: while loading `Loading orders…`; on error `Could not load orders` and a `Retry` action; with an empty list `No orders yet`; otherwise one line per order id.
