/*
 * connection.js — 节点接入文档的一次性通知（tryMount 的兜底触发源）
 *
 * 契约：node 已接入文档 → cb 同步执行；未接入 → 登记等待，接入时触发一次。
 * 框架自有接入点（Page.attach 树遍历 flush）是确定性主路径；本模块只覆盖
 * 框架外的接入（外部对游离宿主 parseRef 后自行插入、嵌套路由在 staging
 * 期间 commit 等）。无 pending 时不挂观察者，零常驻开销。
 * dispose 经 cancelConnected 撤销登记，回调持有方不泄漏。
 */

const pending = new Map() // node -> Set<cb>
let observer = null

function stopObserverIfIdle() {
  if (pending.size === 0 && observer) {
    observer.disconnect()
    observer = null
  }
}

function flushPending() {
  if (pending.size === 0) return
  for (const [node, callbacks] of pending) {
    if (!node.isConnected) continue
    pending.delete(node)
    for (const cb of callbacks) cb(node)
  }
  stopObserverIfIdle()
}

function ensureObserver() {
  if (observer || typeof document === 'undefined') return
  observer = new MutationObserver(() => flushPending())
  observer.observe(document.documentElement, { childList: true, subtree: true })
}

/** node 接入文档时执行 cb 一次（已接入则同步执行）。返回撤销函数。 */
export function whenConnected(node, cb) {
  if (!node || typeof cb !== 'function') return () => {}
  if (node.isConnected) {
    cb(node)
    return () => {}
  }
  let callbacks = pending.get(node)
  if (!callbacks) {
    callbacks = new Set()
    pending.set(node, callbacks)
  }
  callbacks.add(cb)
  ensureObserver()
  return () => cancelConnected(node, cb)
}

/** 撤销 node 上登记的连接回调（不传 cb = 全部撤销）。 */
export function cancelConnected(node, cb) {
  const callbacks = pending.get(node)
  if (!callbacks) return
  if (cb) callbacks.delete(cb)
  if (!cb || callbacks.size === 0) pending.delete(node)
  stopObserverIfIdle()
}
