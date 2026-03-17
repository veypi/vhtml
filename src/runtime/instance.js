export class ComponentInstance {
  constructor(host, kind = 'component') {
    this.host = host
    this.kind = kind
    this.parent = null
    this.children = new Set()
    this.vsrc = ''
    this.data = null
    this.runtime = null
    this.ctx = null
    this.mod = null
    this.sys = null
    this.router = null
    this.route = null
    this.cacheKey = null
    this.scope = null
    this.slots = null
    this.slotOutletState = null
    this.sourceNodes = null
    this.vforData = null
    this.events = null
    this.parsed = false
    this.meta = null
  }
}

export function createInstance(host, parent = null, kind = 'component') {
  const instance = new ComponentInstance(host, kind)
  return attachChildInstance(parent, instance)
}

export function attachChildInstance(parent, child) {
  if (!child) {
    return child
  }
  if (child.parent && child.parent !== parent) {
    child.parent.children.delete(child)
  }
  child.parent = parent || null
  if (parent) {
    parent.children.add(child)
  }
  return child
}

export function detachInstance(instance) {
  if (!instance) {
    return
  }
  if (instance.parent) {
    instance.parent.children.delete(instance)
    instance.parent = null
  }
  instance.children.forEach((child) => {
    child.parent = null
  })
  instance.children.clear()
}

export default ComponentInstance
