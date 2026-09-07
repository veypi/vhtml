/*
 * component-scope.js — 组件作用域与生命周期状态机
 *
 * 生命周期状态机（v0.11 重设计）：
 *
 *   phase:  setup → building → mounted → disposed
 *   active: 叠加在 mounted 之上的布尔子态（active ⇄ inactive）
 *
 *   setup    实例创建、setup 脚本执行（不保证 DOM 编译完成/已连接）
 *   building 模板编译与子组件挂载进行中
 *   mounted  单向闩：自身编译完成且宿主已接入文档，plain script 执行一次
 *   disposed 唯一销毁口，任意阶段可直达
 *
 *   active ⟺ mounted ∧ connected ∧ 路由分支当前 ∧ 文档可见
 *
 *   激活资格三元（路由/连接/可见性）任一变化都经 reconcileActivity 单一
 *   决策点重算资格并做迁移，状态机层面幂等（重复触发源归一）。
 *
 * 不变式：
 *   1. 每个 active 周期必然配对一次 deactive：active 下被 dispose 先补发
 *      deactive（reason='dispose'），活跃期资源释放可集中在 deactive
 *   2. 生命周期回调签名 fn(host, reason)，reason ∈
 *      'mount' | 'route' | 'visibility' | 'dispose'
 *   3. 回调与 cleanup 逐个隔离执行：单个抛错进错误登记表，不阻断剩余回收
 *   4. disposed 后 addCleanup 立即执行（异步脚本善后注册的资源不泄漏）
 */

import { createGenToken } from './lifecycle.js'
import { cancelConnected, whenConnected } from './connection.js'
import { reportError } from './errors.js'

function runGuarded(fn, host, reason) {
  try {
    fn(host, reason)
  } catch (error) {
    reportError('lifecycle', error?.message || String(error), { stack: error?.stack || '' })
  }
}

// ---- 标签页可见性联动 ----
// visibilitychange 时对所有存活 scope 重算激活资格（reconcile 幂等：
// 路由缓存停用/未挂载/已退场的 scope 资格不满足，自然不迁移）。
// 遍历注册表而非组件树：路由缓存软断开（inst.parent=null）会破坏树结构。
const liveScopes = new Set()
let visibilityBound = false

function bindVisibilityLifecycle() {
  if (visibilityBound || typeof document === 'undefined' || !document.addEventListener) return
  visibilityBound = true
  document.addEventListener('visibilitychange', () => {
    for (const scope of liveScopes) scope.reconcileActivity('visibility')
  })
}

export class ComponentScope {
  constructor(host = null) {
    this.host = host
    this.cleanups = []
    this.timers = new Set()
    this.intervals = new Set()
    this.lifecycle = { mount: [], active: [], deactive: [], dispose: [] }
    this.phase = 'setup'
    this.active = false
    // 路由分支当前性：RouterView 树遍历经 setRouteCurrent 维护；
    // 非路由组件恒 true（无路由祖先即视为当前）
    this._routeCurrent = true
    // 连接兜底登记幂等标记（tryMount 未连接时只登记一次）
    this._awaitingConnection = false
    // watch 延迟队列（v0.10.3）：setup 期 props 绑定尚未发生，立即注册会读到
    // 未绑定值；队列模式下注册入队，绑定完成后一次性排空（取代旧 50ms 定时器）
    this.watchQueue = null
    // 异步挂载竞态令牌：await 边界 issue()/alive() 校验；dispose 时 kill()
    this.token = createGenToken()
    liveScopes.add(this)
    bindVisibilityLifecycle()
  }

  addCleanup(cleanup) {
    if (typeof cleanup !== 'function') return cleanup
    // 不变式 4：disposed 后立即执行（异步段善后注册不堆积泄漏）
    if (this.phase === 'disposed') {
      runGuarded(cleanup, this.host)
      return cleanup
    }
    this.cleanups.push(cleanup)
    return cleanup
  }

  addWatcher(cancel) {
    return this.addCleanup(cancel)
  }

  // ---- watch 延迟队列（v0.10.3，取代 setup $watch 的 50ms 魔法延迟）----
  // 队列模式下（setup 期间）注册入队，flushWatchQueue 一次性排空；
  // 非队列模式立即执行（生命周期脚本等常规路径），两种路径同一机制。
  beginWatchQueue() {
    if (!this.watchQueue) this.watchQueue = []
  }

  queueWatch(register) {
    if (typeof register !== 'function') return null
    if (this.watchQueue) {
      this.watchQueue.push(register)
      return null
    }
    return register()
  }

  flushWatchQueue() {
    const queue = this.watchQueue
    if (!queue) return
    this.watchQueue = null
    for (const register of queue) register()
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

  // ---- 阶段迁移 ----

  /** setup 完成、进入模板编译（parseRef 调用）。 */
  markBuilding() {
    if (this.phase === 'setup') this.phase = 'building'
  }

  onMount(fn) {
    if (typeof fn !== 'function') return
    // mounted 闩已落：迟到的注册（如挂载后动态注入的脚本）立即执行
    if (this.phase === 'mounted') {
      runGuarded(fn, this.host, 'mount')
      return
    }
    if (this.phase === 'disposed') return
    this.lifecycle.mount.push(fn)
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

  /**
   * 挂载迁移唯一入口（资格制）：
   *   资格 = phase=building ∧ 宿主已接入文档
   * 满足 → phase=mounted、执行 plain script 队列、重算激活资格；
   * 未连接 → 经 whenConnected 登记兜底（Page.attach 树遍历是确定性主路径，
   * 本兜底覆盖外部插入/嵌套路由 staging 等框架外接入点）。
   */
  tryMount() {
    if (this.phase !== 'building') return false
    const host = this.host
    if (host && !host.isConnected) {
      if (!this._awaitingConnection) {
        this._awaitingConnection = true
        whenConnected(host, () => {
          this._awaitingConnection = false
          this.tryMount()
        })
      }
      return false
    }
    this.phase = 'mounted'
    // plain script 与 active('mount') 同实例顺序保证：先 script 后激活判定
    for (const fn of this.lifecycle.mount.splice(0)) runGuarded(fn, host, 'mount')
    this.reconcileActivity('mount')
    return true
  }

  /**
   * 激活资格单一决策点：active ⟺ mounted ∧ connected ∧ 路由当前 ∧ 文档可见。
   * 路由（setRouteCurrent）/连接（tryMount、外部经重新调用）/可见性
   * （visibilitychange）任一变化触发重算；迁移幂等。
   */
  reconcileActivity(reason) {
    if (this.phase !== 'mounted') return
    const host = this.host
    const connected = host ? host.isConnected : true
    const visible = typeof document === 'undefined' || document.visibilityState !== 'hidden'
    const eligible = this._routeCurrent && connected && visible
    if (eligible === this.active) return
    this.active = eligible
    const handlers = eligible ? this.lifecycle.active : this.lifecycle.deactive
    for (const fn of handlers) runGuarded(fn, host, reason)
  }

  /** 路由分支当前性维护（RouterView 树遍历调用）。 */
  setRouteCurrent(current, reason) {
    this._routeCurrent = Boolean(current)
    this.reconcileActivity(reason)
  }

  dispose(context) {
    if (this.phase === 'disposed') return
    liveScopes.delete(this)
    if (this.host) cancelConnected(this.host)
    // 作废全部在途异步段（generation token 契约：唯一销毁口单点收口）
    this.token.kill()
    // 不变式 1：active 状态下被销毁，先补发 deactive
    if (this.active) {
      this.active = false
      for (const fn of this.lifecycle.deactive) runGuarded(fn, context, 'dispose')
    }
    this.phase = 'disposed'
    // 未执行的 mount 队列直接丢弃（staging 作废零脚本副作用）
    this.lifecycle.mount.length = 0
    for (const fn of this.lifecycle.dispose) runGuarded(fn, context)
    // 不变式 3：单个 cleanup 抛错不阻断剩余回收
    for (const cleanup of this.cleanups.splice(0)) runGuarded(cleanup, context)
    for (const id of this.timers) window.clearTimeout(id)
    this.timers.clear()
    for (const id of this.intervals) window.clearInterval(id)
    this.intervals.clear()
  }
}

/** dev 警告：observer 兜底路径（v0.10.1 阶段 2）——依赖兜底的移除应收敛为显式 dispose */
export function warnObserverFallback(node) {
  const tag = node.tagName?.toLowerCase() || 'node'
  const cls = typeof node.className === 'string' && node.className ? `.${node.className.trim().split(/\s+/).join('.')}` : ''
  const vref = node.getAttribute?.('vref') || ''
  const vsrc = node.getAttribute?.('vsrc') || ''
  console.warn(`[vhtml] disposed via observer fallback: <${tag}${cls}${vref ? ` vref='${vref}'` : ''}${vsrc ? ` vsrc='${vsrc}'` : ''}> — prefer explicit disposeNode() at the removal site`)
}
