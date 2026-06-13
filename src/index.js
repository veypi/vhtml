/*
 * vhtml — 框架入口
 * Copyright (C) 2024 veypi <i@veypi.com>
 *
 * VHTML 类管理框架生命周期：全局样式、MutationObserver、vdelay、
 * ctx 组装、DOM 编译与销毁。
 */

import { createRenderContext } from './renderer.js'
import { templateLoader } from './loader.js'
import { disposeRuntimeSubtree } from './component-instance.js'
import { createRuntimeContext } from './module.js'
import { EnsureWrap } from './reactive.js'
import { createMemoryHistory, registerRouterHistory } from './router.js'

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
    this._pendingDisposals = new WeakMap()
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
    this._pendingDisposals = new WeakMap()
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
    const activeRuntime = runtime?.$mod || runtime?.$sys ? runtime : this._runtime
    this._ctx.ensureBoundary(dom, data, activeRuntime)
    this._ctx.compileNode(dom, data, activeRuntime, this._ctx)
  }

  /**
   * 解析并挂载原始 HTML 代码到指定 DOM 节点
   */
  async parseRaw(dom, data = {}, runtime = {}, code = '') {
    if (!this._ctx) return
    data = EnsureWrap(data)
    return this._ctx.parseRaw(dom, data, runtime, code)
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
            this._cancelPendingDisposal(node)
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

  _cancelPendingDisposal(node) {
    if (!node || node.nodeType !== 1) return
    const timer = this._pendingDisposals.get(node)
    if (timer) { cancelAnimationFrame(timer); this._pendingDisposals.delete(node) }
    node.querySelectorAll?.('*').forEach(child => {
      const childTimer = this._pendingDisposals.get(child)
      if (childTimer) { cancelAnimationFrame(childTimer); this._pendingDisposals.delete(child) }
    })
  }

  _scheduleDisposeNodeScope(node) {
    if (!node || node.nodeType !== 1) return
    if (node.hasAttribute?.('data-keep')) return
    this._cancelPendingDisposal(node)
    const timer = requestAnimationFrame(() => {
      this._pendingDisposals.delete(node)
      if (!node.isConnected) {
        disposeRuntimeSubtree(node)
      }
    })
    this._pendingDisposals.set(node, timer)
  }

  _flushMOPending() {
    const added = this._moPendingAdded.splice(0)
    const removed = this._moPendingRemoved.splice(0)
    for (let node of added) {
      if (node.nodeType === 1) {
        this._cancelPendingDisposal(node)
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
