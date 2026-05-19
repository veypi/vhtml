/*
 * renderer.js — 渲染引擎入口
 * Copyright (C) 2024 veypi <i@veypi.com>
 *
 * 精简后的 bootstrap：全局样式、MutationObserver、vdelay、上下文组装。
 * 不再通过 vhtml 类转发方法，各模块直接导入使用。
 */

import { Watch, Cancel } from './reactive.js'
import { templateLoader } from './loader.js'
import { $router } from './router.js'
import {
  compileNode, compileAttrs, compileVif, compileAttr,
  ensureStructuralBoundary,
} from './compiler.js'
import { parseRef, parseSlots, parseRaw } from './component.js'
import { disposeRuntimeSubtree } from './component.js'

let rendererBootstrapped = false

function ensureRendererRuntime() {
  if (rendererBootstrapped) return
  rendererBootstrapped = true

  // 全局样式
  const globalStyle = document.createElement('style')
  globalStyle.innerHTML = `
    [vref] { display: block; }
    [vparsing] { display: none; -webkit-text-fill-color: transparent; }
    vslot, vrouter { display: block; }
    vrouter { height: 100%; width: 100%; overflow: auto; }
  `
  if (document.head.firstChild) {
    document.head.insertBefore(globalStyle, document.head.firstChild)
  } else {
    document.head.appendChild(globalStyle)
  }

  // vdelay / MutationObserver
  const DelayCache = []
  const pendingDisposals = new WeakMap()
  const config = { attributes: false, childList: true, subtree: true, characterData: false }

  const runVdelay = (d) => {
    if (!d.isConnected) return
    let delay = d.getAttribute('vdelay')
    if (delay) {
      let fc = DelayCache[delay]
      if (fc) fc(d)
      else console.error('delay not found:', delay, d)
    }
  }

  const cancelPendingDisposal = (node) => {
    if (!node || node.nodeType !== 1) return
    const timer = pendingDisposals.get(node)
    if (timer) { cancelAnimationFrame(timer); pendingDisposals.delete(node) }
    node.querySelectorAll?.('*').forEach(child => {
      const childTimer = pendingDisposals.get(child)
      if (childTimer) { cancelAnimationFrame(childTimer); pendingDisposals.delete(child) }
    })
  }

  const disposeNodeScope = (node) => {
    if (!node || node.nodeType !== 1) return
    if (!node.isConnected) disposeRuntimeSubtree(node)
  }

  const scheduleDisposeNodeScope = (node) => {
    if (!node || node.nodeType !== 1) return
    if (node.hasAttribute?.('data-vrouter-cache') || node.hasAttribute?.('data-vrouter-layout')) return
    cancelPendingDisposal(node)
    const timer = requestAnimationFrame(() => {
      pendingDisposals.delete(node)
      if (!node.isConnected) disposeNodeScope(node)
    })
    pendingDisposals.set(node, timer)
  }

  let moSuspended = false
  const moPendingAdded = []
  const moPendingRemoved = []

  function flushMOPending() {
    const added = moPendingAdded.splice(0)
    const removed = moPendingRemoved.splice(0)
    for (let node of added) {
      if (node.nodeType === 1) {
        cancelPendingDisposal(node)
        runVdelay(node)
        node.querySelectorAll('*[vdelay]').forEach(runVdelay)
      }
    }
    for (let node of removed) {
      scheduleDisposeNodeScope(node)
    }
  }

  const callback = function(mutationsList, observer) {
    if (moSuspended) {
      for (const mutation of mutationsList) {
        moPendingAdded.push(...mutation.addedNodes)
        moPendingRemoved.push(...mutation.removedNodes)
      }
      return
    }
    mutationsList.forEach(function(mutation) {
      for (let node of mutation.addedNodes) {
        if (node.nodeType === 1) {
          cancelPendingDisposal(node)
          runVdelay(node)
          node.querySelectorAll('*[vdelay]').forEach(runVdelay)
        }
      }
      for (let node of mutation.removedNodes) {
        scheduleDisposeNodeScope(node)
      }
    })
  }

  const observer = new MutationObserver(callback)
  observer.observe(document.body, config)

  const suspendMO = () => { moSuspended = true }
  const resumeMO = () => {
    if (!moSuspended) return
    moSuspended = false
    if (moPendingAdded.length > 0 || moPendingRemoved.length > 0) {
      flushMOPending()
    }
  }

  // findLastAccess — 分析 v: 双向绑定的目标变量
  function findLastAccess(code, data) {
    code = `with (sandbox) { ${code} }`
    const fn = new Function('sandbox', code)
    let res = { data: null, key: null }
    const wrap = (tmp) => {
      return new Proxy(tmp, {
        has(target, key) { return true },
        get(target, key, receiver) {
          if (key === Symbol.unscopables) return undefined
          let v = Reflect.get(target, key, receiver)
          res.data = target
          res.key = key
          if (typeof v === 'function') console.warn('vhtml not support function with "v:" variables bind')
          if (typeof v === 'object' && v) return wrap(v)
          return v
        },
        set(target, key, newValue, receiver) { return false },
      })
    }
    fn(wrap(data))
    return res
  }

  // onMountedRun — DOM 挂载后延迟执行
  function onMountedRun(dom, cb, once = true) {
    if (once) {
      if (dom.isConnected) { cb(dom); return }
      let did = DelayCache.push((dom) => { dom.removeAttribute('vdelay'); cb(dom) })
      dom.setAttribute('vdelay', did - 1)
      return
    }
    if (dom.isConnected) cb(dom)
    let did = DelayCache.push(cb)
    dom.setAttribute('vdelay', did - 1)
  }

  // watch 辅助 — 创建 watcher 并注册到 scope 清理
  function watch(scope, target, callback, options) {
    const id = Watch(target, callback, options)
    scope?.addWatcher(() => Cancel(id))
    return id
  }

  // 组装 ctx 对象，解析 compiler ↔ component ↔ router 之间的循环依赖
  const ctx = {
    watch,
    findLastAccess,
    onMountedRun,
    suspendMO,
    resumeMO,
    compileNode,
    compileAttrs,
    compileVif,
    compileAttr,
    ensureBoundary: ensureStructuralBoundary,
    parseRef(vsrc, dom, data, runtime, target, singleMode) {
      return parseRef(vsrc, dom, data, runtime, target, singleMode, ctx)
    },
    parseSlots(dom, data, runtime) {
      return parseSlots(dom, data, runtime, ctx)
    },
    parseRaw(dom, data, runtime, code) {
      return parseRaw(dom, data, runtime, code, ctx)
    },
    mountRouter(dom, runtime) {
      $router.mountView(ctx, dom, runtime)
    },
  }

  // 挂载 ctx 到 window 供外部使用
  window.__VhtmlCtx__ = ctx
}

export function createVhtmlApp(target = document.body) {
  ensureRendererRuntime()
  const ctx = window.__VhtmlCtx__
  const mainEl = typeof target === 'string' ? document.getElementById(target) : target

  if (!mainEl) {
    console.error(`Can't find element: ${target}`)
    return
  }

  let init = async () => {
    let mainParser = await templateLoader.fetchUI(window.location.pathname, {}, true)
    ctx.parseRef('root', mainEl, {}, mainParser.mod || {}, mainParser, true)
  }
  init()

  return ctx
}

export function bootstrapVhtml(target = document.body) {
  ensureRendererRuntime()
  if (window.$vhtml) {
    console.error('vhtml already exists.')
    return window.$vhtml
  }
  window.$vhtml = createVhtmlApp(target)
  return window.$vhtml
}
