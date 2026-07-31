/*
 * component-scope.js — 组件作用域与生命周期清理
 *
 * 生命周期语义（重新设计）：
 *   active   = 组件进入"活在当前可见页面"状态：挂载完成、路由缓存页重新切入、
 *              浏览器标签页由隐藏变回可见
 *   deactive = 暂时离开该状态但实例存活：路由页面被缓存、标签页隐藏
 *   dispose  = 永久销毁（v-if 移除、页面销毁、显式 dispose）
 *
 * 状态机：created → active ⇄ inactive → disposed
 * 不变式：
 *   1. activate 仅在 非active→active 转换时触发，deactive 仅在 active→inactive
 *      转换时触发——状态机层面幂等，重复触发源（路由+可见性叠加等）被归一
 *   2. 每个 active 周期必然配对一次 deactive：active 状态下被 dispose 时先补发
 *      deactive（reason='dispose'），活跃期资源释放可集中在 deactive
 *   3. 生命周期回调签名 fn(host, reason)，reason ∈
 *      'mount' | 'route' | 'visibility' | 'dispose'
 */

// ---- 标签页可见性联动 ----
// hidden：对所有当前 active 的 scope 触发 deactive（记入 visHiddenScopes）
// visible：仅对 visHiddenScopes 中仍为 inactive 的 scope 补发 activate——
// 路由缓存停用的 scope（state=inactive）不在集合内，不会被误激活；
// 后台期间被路由重新激活的（state=active）也不会被重复补发。
// 直接遍历注册表而非组件树：路由缓存软断开（inst.parent=null）会破坏树结构
const liveScopes = new Set()
const visHiddenScopes = new Set()
let visibilityBound = false

function bindVisibilityLifecycle() {
  if (visibilityBound || typeof document === 'undefined' || !document.addEventListener) return
  visibilityBound = true
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      for (const scope of liveScopes) {
        if (scope.state !== 'active') continue
        visHiddenScopes.add(scope)
        scope.deactive(scope.host, 'visibility')
      }
      return
    }
    for (const scope of visHiddenScopes) {
      if (scope.state === 'inactive') scope.activate(scope.host, 'visibility')
    }
    visHiddenScopes.clear()
  })
}

export class ComponentScope {
  constructor(host = null) {
    this.host = host
    this.cleanups = []
    this.timers = new Set()
    this.intervals = new Set()
    this.lifecycle = { active: [], deactive: [], dispose: [] }
    this.state = 'created'
    liveScopes.add(this)
    bindVisibilityLifecycle()
  }

  addCleanup(cleanup) {
    if (typeof cleanup === 'function') this.cleanups.push(cleanup)
    return cleanup
  }

  addWatcher(cancel) {
    return this.addCleanup(cancel)
  }

  addEventListener(target, event, handler, options) {
    if (!target?.addEventListener || typeof handler !== 'function') return null
    target.addEventListener(event, handler, options)
    this.addCleanup(() => target.removeEventListener(event, handler, options))
    return handler
  }

  setTimeout(fn, delay) {
    const id = window.setTimeout(() => { this.timers.delete(id); fn() }, delay)
    this.timers.add(id)
    return id
  }

  setInterval(fn, delay) {
    const id = window.setInterval(fn, delay)
    this.intervals.add(id)
    return id
  }

  clearTimeout(id) {
    if (this.timers.has(id)) { this.timers.delete(id); window.clearTimeout(id) }
  }

  clearInterval(id) {
    if (this.intervals.has(id)) { this.intervals.delete(id); window.clearInterval(id) }
  }

  onActive(fn) {
    if (typeof fn === 'function') this.lifecycle.active.push(fn)
  }

  onDeactive(fn) {
    if (typeof fn === 'function') this.lifecycle.deactive.push(fn)
  }

  onDispose(fn) {
    if (typeof fn === 'function') this.lifecycle.dispose.push(fn)
  }

  activate(context, reason) {
    // 幂等：仅在 非active→active 转换时触发（layout 复用、路由+可见性叠加等
    // 重复触发源都被归一；历史上 layout 组件每次页面 re-entry 被重复 activate）
    if (this.state === 'active' || this.state === 'disposed') return
    this.state = 'active'
    for (const fn of this.lifecycle.active) fn(context, reason)
  }

  deactive(context, reason) {
    // 幂等：仅在 active→inactive 转换时触发
    if (this.state !== 'active') return
    this.state = 'inactive'
    for (const fn of this.lifecycle.deactive) fn(context, reason)
  }

  dispose(context) {
    if (this.state === 'disposed') return
    liveScopes.delete(this)
    visHiddenScopes.delete(this)
    // 不变式 2：active 状态下被销毁，先补发 deactive 再执行 dispose
    if (this.state === 'active') {
      this.state = 'inactive'
      for (const fn of this.lifecycle.deactive) fn(context, 'dispose')
    }
    this.state = 'disposed'
    for (const fn of this.lifecycle.dispose) fn(context)
    for (const cleanup of this.cleanups.splice(0)) cleanup()
    for (const id of this.timers) window.clearTimeout(id)
    this.timers.clear()
    for (const id of this.intervals) window.clearInterval(id)
    this.intervals.clear()
  }
}
