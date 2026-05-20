/*
 * renderer.js — 渲染上下文工厂
 * Copyright (C) 2024 veypi <i@veypi.com>
 *
 * 提供 createRenderContext 组装 compiler ↔ component ↔ router 之间的 ctx 胶水对象。
 * 无全局副作用：MO、vdelay、样式注入由 Vhtml 实例管理。
 */

import { Watch, Cancel } from './reactive.js'
import { $router } from './router.js'
import {
  compileNode, compileAttrs, compileVif, compileAttr,
  ensureStructuralBoundary,
} from './compiler.js'
import { parseRef, parseSlots, parseRaw } from './component.js'

/**
 * 分析 v: 双向绑定的目标变量（纯函数，无副作用）
 */
export function findLastAccess(code, data) {
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

/**
 * scope 绑定的 watcher — 自动在 scope dispose 时取消
 */
export function watch(scope, target, callback, options) {
  const id = Watch(target, callback, options)
  scope?.addWatcher(() => Cancel(id))
  return id
}

/**
 * 创建渲染上下文（ctx 胶水对象）。
 * helpers 由 Vhtml 实例注入：{ onMountedRun, suspendMO, resumeMO }
 */
export function createRenderContext(helpers) {
  const { onMountedRun, suspendMO, resumeMO } = helpers
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
  return ctx
}
