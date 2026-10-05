// Module execution policy belongs to the module record, never to component attributes.
const records = new WeakMap()
export function registerModule(mod, record) { records.set(mod, record); return mod }
export function moduleRecord(context) { return records.get(context) || records.get(context?.$mod) }
