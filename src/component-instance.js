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
    // 组件级最近一次错误（v0.10.3 错误契约）：{ kind: 'compile'|'expression'|'mount', message, code? }
    // 全局历史见 __vhtml_dev.errors（errors.js 登记表）
    this._error = null
    // 路由缓存软断开标记（由 parseRef options.keepOnDetach 设置，
    // 运行时判读只走实例字段，不依赖任何 DOM 属性）
    this.keepOnDetach = false
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

/**
 * meta 的非创建式读取：只读检查不得在节点上留下空 meta——
 * 空 meta 会使「移除后未经 dispose」的节点在兑底清理时被误判为
 * 有内容可清（触发假警告），也是驻留泄漏。
 */
export function peekMeta(node) {
  return nodeMeta.get(node) || null
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
  if (!node) return false
  const instance = nodeInst.get(node)
  if (instance) {
    detachInstance(instance)
    nodeInst.delete(node)
  }
  return nodeMeta.delete(node) || Boolean(instance)
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

/**
 * 销毁节点子树的运行时状态（实例/作用域/meta）。
 * 返回是否实际清理了内容（幂等：已销毁节点再次调用返回 false 且无副作用）。
 * 实例分支不得提前返回：实例树只覆盖挂了实例的嵌套组件，纯元素后代的
 * meta（parsed/vforData/slotOutletState 等）只能靠 DOM 子树遍历清到位，
 * 否则幂等契约（再次调用返回 false）被残留 meta 破坏。
 */
export function disposeRuntimeSubtree(node) {
  if (!node || node.nodeType !== 1) return false
  const instance = nodeInst.get(node)
  let did = false
  if (instance) {
    disposeInstanceSubtree(instance)
    did = true
  }
  did = purgeNodeState(node) || did
  node.childNodes?.forEach(child => {
    if (child.nodeType === 1) did = disposeRuntimeSubtree(child) || did
  })
  return did
}

/**
 * 公开销毁契约（v0.10.1 阶段 1）：disposeRuntimeSubtree 的语义化导出。
 * 不变式：谁移除 DOM 谁负责 dispose；dispose 幂等（已销毁节点再次调用无副作用）。
 * 框架内部移除点（v-for/v-if/:vsrc/v-html/parseRef 替换/Page.destroy）已全部
 * 显式调用；外部移除（el.remove()）由 MutationObserver 兜底回收并打 dev 警告。
 */
export function disposeNode(el) {
  return disposeRuntimeSubtree(el)
}
