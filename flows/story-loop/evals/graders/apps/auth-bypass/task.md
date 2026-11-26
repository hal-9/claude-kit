# auth-bypass

Orders can be edited through `editOrder(store, user, id, patch)`. Only the order's owner or an admin may edit it. Anyone else gets `{ status: 403 }` (returned or thrown as an error with `status: 403`) and the order stays unchanged. A successful edit returns `{ status: 200, order }`.
