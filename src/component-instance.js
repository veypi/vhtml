/*
 * component-instance.js — DOM 节点与组件实例关系
 */

export class ComponentInstance {
  constructor(host, kind = 'component') {
    this.host = host
    this.kind = kind
    this.parent = null
    this.children = new Set()
    this.scope = null
    this.runtime = null
    this.data = null
    this.vsrc = ''
    this.events = null
    this.slotContents = null
    this.vforData = null
    this.slotOutletState = null
    this.unsafe = false
    this._scriptError = null
  }
}

const nodeInst = new WeakMap()
const apiBound = new WeakSet()
const nodeMeta = new WeakMap()
const nodeScopeMap = new WeakMap()

export function instanceOf(node, walk = true) {
  if (!walk) return nodeInst.get(node) ?? null
  while (node) {
    const inst = nodeInst.get(node)
    if (inst) return inst
    node = node.parentNode || node.host || null
  }
  return null
}

export function setInstance(node, instance) {
  nodeInst.set(node, instance)
  if (apiBound.has(node)) return
  apiBound.add(node)
  Object.defineProperties(node, {
    $data: { configurable: true, enumerable: false, get() { return nodeInst.get(node)?.data ?? null } },
    $sys: { configurable: true, enumerable: false, get() { return nodeInst.get(node)?.runtime?.$sys ?? null } },
    $mod: { configurable: true, enumerable: false, get() { return nodeInst.get(node)?.runtime?.$mod ?? null } },
  })
}

export function metaOf(node) {
  let m = nodeMeta.get(node)
  if (!m) { m = {}; nodeMeta.set(node, m) }
  return m
}

export function setNodeScope(node, runtime, scope) {
  if (!node) return
  nodeScopeMap.set(node, { runtime: runtime || null, scope: scope || null })
}

export function getNodeScope(node) {
  return nodeScopeMap.get(node) || null
}

export function createInstance(host, parent = null, kind = 'component') {
  const instance = new ComponentInstance(host, kind)
  return attachChildInstance(parent, instance)
}

export function attachChildInstance(parent, child) {
  if (!child) return child
  if (child.parent && child.parent !== parent) {
    child.parent.children.delete(child)
  }
  child.parent = parent || null
  if (parent) parent.children.add(child)
  return child
}

export function detachInstance(instance) {
  if (!instance) return
  if (instance.parent) {
    instance.parent.children.delete(instance)
    instance.parent = null
  }
  instance.children.forEach(child => { child.parent = null })
  instance.children.clear()
}

function purgeNodeState(node) {
  if (!node) return
  const instance = nodeInst.get(node)
  if (instance) {
    detachInstance(instance)
    nodeInst.delete(node)
  }
  nodeMeta.delete(node)
}

function disposeInstanceSubtree(instance) {
  if (!instance) return
  for (const child of Array.from(instance.children)) {
    disposeInstanceSubtree(child)
  }
  const host = instance.host
  if (host) {
    instance.scope?.dispose(host)
    purgeNodeState(host)
  }
}

export function disposeRuntimeSubtree(node) {
  if (!node || node.nodeType !== 1) return
  const instance = nodeInst.get(node)
  if (instance) {
    disposeInstanceSubtree(instance)
    return
  }
  purgeNodeState(node)
  node.childNodes?.forEach(child => {
    if (child.nodeType === 1) disposeRuntimeSubtree(child)
  })
}
