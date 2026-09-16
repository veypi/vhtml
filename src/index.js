/*
 * vhtml — 框架入口
 * Copyright (C) 2024 veypi <i@veypi.com>
 *
 * VHTML 类管理框架生命周期：全局样式、MutationObserver（销毁兜底）、
 * ctx 组装、DOM 编译与销毁。
 */

import { createRenderContext } from './renderer.js'
import { templateLoader } from './loader.js'
import { disposeRuntimeSubtree, instanceOf } from './component-instance.js'
import { createRuntimeContext, RUNTIME } from './module.js'
import { EnsureWrap } from './reactive.js'
import { createMemoryHistory, registerRouterHistory } from './router.js'
import { warnObserverFallback } from './component-scope.js'
import { perfStats } from './perf-stats.js'
import { normalizeTemplate } from './template-normalize.js'

class VHTML {
  static _globalStyled = false

  constructor(target, scoped = '', options = {}) {
    if (target && typeof target === 'object' && !(target instanceof Element)) {
      options = target
      target = options.target
      scoped = options.scoped || ''
    }
    this._el = typeof target === 'string'
      ? document.getElementById(target) || document.querySelector(target)
      : target

    this._scoped = scoped || ''
    this._data = EnsureWrap(options.data || {})
    this._runtime = null
    this._mounted = false
    this._ctx = null
    this._observer = null
    this._moSuspended = false
    this._moPendingRemoved = new Set()
    this._disposeTask = null
    // 暴露运行时所使用的模板加载器（单例）：宿主页面经 window.$vhtml.templateLoader
    // 拿到与内部一致的对象做 clearScoped/scopeOf（生产 bundle 与 debug src 图双形态
    // 同一实例；直接 import /vhtml/loader.js 在生产是另一份模块实例，清不到本缓存）
    this.templateLoader = templateLoader
    this.ready = options.autoMount === false ? Promise.resolve(this) : this.mount()
  }

  // ===================================================================
  // 公开 API
  // ===================================================================

  async mount() {
    if (this._mounted) {
      console.warn('vhtml already mounted.')
      return this
    }

    if (!this._el) {
      console.error('vhtml: target element not found')
      return this
    }

    VHTML._injectGlobalStyles()
    normalizeTemplate(this._el)
    this._startObserver()

    this._ctx = createRenderContext({
      suspendMO: this._suspendMO.bind(this),
      resumeMO: this._resumeMO.bind(this),
    })

    const mod = await templateLoader.getModule(this._scoped)
    this._runtime = createRuntimeContext(null, mod)
    this._ctx.ensureBoundary(this._el, this._data, this._runtime)
    this._ctx.compileNode(this._el, this._data, this._runtime, this._ctx)

    this._mounted = true
    return this
  }

  destroy() {
    if (this._observer) {
      this._collectRemoved(this._observer.takeRecords())
      this._observer.disconnect()
      this._observer = null
    }
    this._cancelDisposalTask()
    this._flushMOPending()
    if (this._el) {
      disposeRuntimeSubtree(this._el)
    }
    this._moSuspended = false
    this._mounted = false
    this._ctx = null
  }

  /**
   * 编译 DOM 子树中的 v-* 指令和插值
   */
  parseDom(dom, data = {}, runtime = {}) {
    if (!this._ctx) return
    normalizeTemplate(dom)
    data = EnsureWrap(data)
    const activeRuntime = runtime?.[RUNTIME] ? runtime : this._runtime
    this._ctx.ensureBoundary(dom, data, activeRuntime)
    this._ctx.compileNode(dom, data, activeRuntime, this._ctx)
  }

  /**
   * 解析并挂载原始 HTML 代码到指定 DOM 节点
   */
  async parseRaw(dom, data = {}, runtime = {}, code = '') {
    if (!this._ctx) return
    data = EnsureWrap(data)
    const activeRuntime = runtime?.[RUNTIME] ? runtime : this._runtime
    return this._ctx.parseRaw(dom, data, activeRuntime, code)
  }

  /**
   * 加载并挂载组件到指定 DOM 节点
   */
  async parseRef(vsrc, dom, data = {}, runtime = {}, target = null, singleMode = false) {
    if (!this._ctx) return
    data = EnsureWrap(data)
    return this._ctx.parseRef(vsrc, dom, data, runtime, target, singleMode)
  }

  // ===================================================================
  // 全局样式（所有实例共享，仅注入一次）
  // ===================================================================

  static _injectGlobalStyles() {
    if (VHTML._globalStyled) return
    VHTML._globalStyled = true
    const style = document.createElement('style')
    style.innerHTML = `
      [vref] { display: block; }
      [vparsing] { display: none; -webkit-text-fill-color: transparent; }
      vslot, vrouter { display: block; }
      vrouter { height: 100%; width: 100%; overflow: auto; }
    `
    if (document.head.firstChild) {
      document.head.insertBefore(style, document.head.firstChild)
    } else {
      document.head.appendChild(style)
    }
  }

  // ===================================================================
  // MutationObserver
  // ===================================================================

  _startObserver() {
    const config = { attributes: false, childList: true, subtree: true, characterData: false }
    this._observer = new MutationObserver((mutationsList) => {
      this._collectRemoved(mutationsList)
    })
    this._observer.observe(this._el, config)
  }

  _collectRemoved(records) {
    for (const record of records) {
      for (const node of record.removedNodes) this._scheduleDisposeNodeScope(node)
    }
  }

  // 每个根共用一个队列；仍在延迟执行时检查连接状态，允许同帧 DOM 移动。
  _scheduleDisposeNodeScope(node) {
    if (!node || node.nodeType !== 1) return
    if (instanceOf(node, false)?.keepOnDetach) return
    if (!this._moPendingRemoved.has(node)) {
      this._moPendingRemoved.add(node)
      perfStats.disposalCandidates++
      perfStats.disposalPending++
    }
    this._scheduleDisposalFlush()
  }

  _scheduleDisposalFlush() {
    if (this._moSuspended || this._disposeTask || !this._moPendingRemoved.size) return
    const task = { frame: null, timer: null }
    this._disposeTask = task
    const drain = () => {
      if (this._disposeTask !== task) return
      this._cancelDisposalTask()
      if (!this._moSuspended) this._flushMOPending()
    }
    perfStats.disposalSchedules++
    task.frame = requestAnimationFrame(drain)
    // 总是登记一次兜底：也覆盖登记后才切到后台、rAF 因而停摆的情况。
    task.timer = setTimeout(drain, 100)
  }

  _cancelDisposalTask() {
    const task = this._disposeTask
    if (!task) return
    this._disposeTask = null
    cancelAnimationFrame(task.frame)
    clearTimeout(task.timer)
  }

  _flushMOPending() {
    if (!this._moPendingRemoved.size) return
    const removed = this._moPendingRemoved
    this._moPendingRemoved = new Set()
    perfStats.disposalPending -= removed.size
    perfStats.disposalFlushes++
    for (const node of removed) {
      if (node.isConnected) continue
      let covered = false
      for (let parent = node.parentNode; parent; parent = parent.parentNode) {
        if (removed.has(parent) || instanceOf(parent, false)?.keepOnDetach) {
          covered = true
          break
        }
      }
      if (covered) continue
      perfStats.disposalRoots++
      if (disposeRuntimeSubtree(node, true) && (node.hasAttribute('vrefof') || node.hasAttribute('vref'))) {
        warnObserverFallback(node)
      }
    }
    removed.clear()
  }

  _suspendMO() {
    this._moSuspended = true
  }

  _resumeMO() {
    if (!this._moSuspended) return
    this._moSuspended = false
    this._scheduleDisposalFlush()
  }
}

export default VHTML
export { createMemoryHistory, registerRouterHistory }

VHTML.createMemoryHistory = createMemoryHistory
VHTML.registerRouterHistory = registerRouterHistory
window.VHTML = VHTML
