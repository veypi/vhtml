// Serialized into the guest. Identity is stable while a facade is reachable;
// dead facades cannot keep native resources alive indefinitely. Collection runs
// after VM jobs, without relying on FinalizationRegistry scheduling.
export function createWeakHandles(release) {
  const entries = new Map()
  return {
    get: (id) => entries.get(id)?.deref(),
    set(id, value) {
      entries.set(id, new WeakRef(value))
      return value
    },
    delete: (id) => entries.delete(id),
    sweep() {
      const dead = []
      for (const [id, reference] of entries) {
        if (!reference.deref()) {
          entries.delete(id)
          dead.push(id)
        }
      }
      release(dead)
    },
  }
}
