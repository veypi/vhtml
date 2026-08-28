/*
 * vhtml — 框架入口
 * Copyright (C) 2024 veypi <i@veypi.com>
 *
 * VHTML 类管理框架生命周期：全局样式、MutationObserver、vdelay、
 * ctx 组装、DOM 编译与销毁。
 */

import { createRenderContext } from './renderer.js'
import { templateLoader } from './loader.js'
import { disposeRuntimeSubtree, instanceOf } from './component-instance.js'
import { createRuntimeContext, RUNTIME } from './module.js'
import { EnsureWrap } from './reactive.js'
import { createMemoryHistory, registerRouterHistory } from './router.js'
import { warnObserverFallback } from './component-scope.js'

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
    this._delayCache = []
    this._moSuspended = false
    this._moPendingAdded = []
    this._moPendingRemoved = []
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
    this._startObserver()

    this._ctx = createRenderContext({
      onMountedRun: this._onMountedRun.bind(this),
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
      this._observer.disconnect()
      this._observer = null
    }
    if (this._el) {
      disposeRuntimeSubtree(this._el)
    }
    this._delayCache.length = 0
    this._moPendingAdded.length = 0
    this._moPendingRemoved.length = 0
    this._mounted = false
    this._ctx = null
  }

  /**
   * 编译 DOM 子树中的 v-* 指令和插值
   */
  parseDom(dom, data = {}, runtime = {}) {
    if (!this._ctx) return
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
      if (this._moSuspended) {
        for (const mutation of mutationsList) {
          this._moPendingAdded.push(...mutation.addedNodes)
          this._moPendingRemoved.push(...mutation.removedNodes)
        }
        return
      }
      for (const mutation of mutationsList) {
        for (let node of mutation.addedNodes) {
          if (node.nodeType === 1) {
            this._runVdelay(node)
            node.querySelectorAll('*[vdelay]').forEach(n => this._runVdelay(n))
          }
        }
        for (let node of mutation.removedNodes) {
          this._scheduleDisposeNodeScope(node)
        }
      }
    })
    this._observer.observe(this._el, config)
  }

  _runVdelay(d) {
    if (!d.isConnected) return
    const delay = d.getAttribute('vdelay')
    if (delay !== null) {
      const fc = this._delayCache[delay]
      if (fc) fc(d)
      else console.error('delay not found:', delay, d)
    }
  }

  // v0.10.1 阶段 2：observer 降级为兜底——取消启发式（_cancelPendingDisposal/
  // _pendingDisposals）已删，rAF 时的 isConnected 检查本身就是「同帧移回」判据；
  // 兜底真正清理到内容时打 dev 警告，让依赖兜底的移除路径可发现并收敛为零
  // （显式 dispose 过的节点再次进入此处是幂等空转，不警告）
  _scheduleDisposeNodeScope(node) {
    if (!node || node.nodeType !== 1) return
    // 阶段 3：keepOnDetach 实例字段判读（原 data-keep 属性 hack 已废，
    // 属性仅在实例创建前作为信号存在，parseRef 翻译后即移除）
    if (instanceOf(node, false)?.keepOnDetach) return
    requestAnimationFrame(() => {
      if (node.isConnected) return
      if (disposeRuntimeSubtree(node)) {
        warnObserverFallback(node)
      }
    })
  }

  _flushMOPending() {
    const added = this._moPendingAdded.splice(0)
    const removed = this._moPendingRemoved.splice(0)
    for (let node of added) {
      if (node.nodeType === 1) {
        this._runVdelay(node)
        node.querySelectorAll('*[vdelay]').forEach(n => this._runVdelay(n))
      }
    }
    for (let node of removed) {
      this._scheduleDisposeNodeScope(node)
    }
  }

  _suspendMO() {
    this._moSuspended = true
  }

  _resumeMO() {
    if (!this._moSuspended) return
    this._moSuspended = false
    if (this._moPendingAdded.length > 0 || this._moPendingRemoved.length > 0) {
      this._flushMOPending()
    }
  }

  _onMountedRun(dom, cb, once = true) {
    if (once) {
      if (dom.isConnected) { cb(dom); return }
      const did = this._delayCache.push((d) => { d.removeAttribute('vdelay'); cb(d) })
      dom.setAttribute('vdelay', did - 1)
      return
    }
    if (dom.isConnected) cb(dom)
    const did = this._delayCache.push(cb)
    dom.setAttribute('vdelay', did - 1)
  }
}

export default VHTML
export { createMemoryHistory, registerRouterHistory }

VHTML.createMemoryHistory = createMemoryHistory
VHTML.registerRouterHistory = registerRouterHistory
window.VHTML = VHTML
