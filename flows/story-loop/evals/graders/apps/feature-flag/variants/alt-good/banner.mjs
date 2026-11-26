const COPY = { on: 'Try the new checkout', off: '' }
export function banner(flags = {}) { return COPY[flags.new_checkout === true ? 'on' : 'off'] }
