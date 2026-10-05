// Host-side bookkeeping only. None of these records is visible to module code.
const values = new WeakMap()
export const foreignValue = value => value && (typeof value === 'object' || typeof value === 'function') ? values.get(value) : undefined
export function registerForeign(value, record) { values.set(value, record); return value }
