export class ComponentScope {
  constructor(host = null) {
    this.host = host
    this.cleanups = []
    this.timers = new Set()
    this.intervals = new Set()
    this.lifecycle = {
      active: [],
      deactive: [],
      dispose: [],
    }
    this.state = 'created'
  }

  addCleanup(cleanup) {
    if (typeof cleanup === 'function') {
      this.cleanups.push(cleanup)
    }
    return cleanup
  }

  addWatcher(cancel) {
    return this.addCleanup(cancel)
  }

  addEventListener(target, event, handler, options) {
    if (!target?.addEventListener || typeof handler !== 'function') {
      return null
    }
    target.addEventListener(event, handler, options)
    this.addCleanup(() => target.removeEventListener(event, handler, options))
    return handler
  }

  setTimeout(fn, delay) {
    const id = window.setTimeout(() => {
      this.timers.delete(id)
      fn()
    }, delay)
    this.timers.add(id)
    return id
  }

  setInterval(fn, delay) {
    const id = window.setInterval(fn, delay)
    this.intervals.add(id)
    return id
  }

  clearTimeout(id) {
    if (this.timers.has(id)) {
      this.timers.delete(id)
      window.clearTimeout(id)
    }
  }

  clearInterval(id) {
    if (this.intervals.has(id)) {
      this.intervals.delete(id)
      window.clearInterval(id)
    }
  }

  onActive(fn) {
    if (typeof fn === 'function') {
      this.lifecycle.active.push(fn)
    }
  }

  onDeactive(fn) {
    if (typeof fn === 'function') {
      this.lifecycle.deactive.push(fn)
    }
  }

  onDispose(fn) {
    if (typeof fn === 'function') {
      this.lifecycle.dispose.push(fn)
    }
  }

  activate(context) {
    this.state = 'active'
    for (const fn of this.lifecycle.active) {
      fn(context)
    }
  }

  deactive(context) {
    this.state = 'inactive'
    for (const fn of this.lifecycle.deactive) {
      fn(context)
    }
  }

  dispose(context) {
    if (this.state === 'disposed') {
      return
    }
    this.state = 'disposed'
    for (const fn of this.lifecycle.dispose) {
      fn(context)
    }
    for (const cleanup of this.cleanups.splice(0)) {
      cleanup()
    }
    for (const id of this.timers) {
      window.clearTimeout(id)
    }
    this.timers.clear()
    for (const id of this.intervals) {
      window.clearInterval(id)
    }
    this.intervals.clear()
  }
}

export default ComponentScope
