/*
 * renderer.js — 渲染上下文工厂
 * Copyright (C) 2024 veypi <i@veypi.com>
 *
 * 提供 createRenderContext 组装 compiler ↔ component ↔ router 之间的 ctx 胶水对象。
 * 无全局副作用：MO、vdelay、样式注入由 Vhtml 实例管理。
 */

import { $router } from './router.js'
import { watch } from './runtime-watch.js'
import {
  compileNode, compileAttrs, compileVif, compileAttr,
  ensureStructuralBoundary,
} from './compiler.js'
import { parseRef, parseSlots, parseRaw } from './component.js'
import { parseAccessChain } from './utils.js'

/**
 * 分析 v: 双向绑定的目标变量（纯函数，无副作用）。
 * 优先级：
 *   1. 静态路径链（a.b.c / a['b.c'] / list[0].name）→ { root, chain }：
 *      读写每次从根 data 沿链解析，中间对象被整体替换（v0.10.0 纯替换语义）
 *      后绑定依然跟随新对象 —— v:value 对象替换失效缺陷的修复。
 *   2. 复杂表达式（变量键/函数/运算）→ 旧 Proxy 求值 { data, key }：
 *      固化解析时刻的中间对象引用（旧语义，行为不变）。
 */
export function findLastAccess(code, data) {
  const chain = parseAccessChain(code)
  if (chain && chain.length > 0) {
    return { root: data, chain }
  }
  code = `with (sandbox) { ${code} }`
  const fn = new Function('sandbox', code)
  let res = { data: null, key: null }
  // 原型守卫：表达式路径中出现 __proto__ 时中止求值并返回空（消费端 warn 放弃），
  // 防止旧语义把 __proto__ 当真访问并写入原型对象（原型污染）。
  const PROTO_GUARD = new Error('vhtml proto guard')
  const wrap = (tmp) => {
    return new Proxy(tmp, {
      has(target, key) { return true },
      get(target, key, receiver) {
        if (key === Symbol.unscopables) return undefined
        if (key === '__proto__') throw PROTO_GUARD
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
  try {
    fn(wrap(data))
  } catch (e) {
    if (e !== PROTO_GUARD) throw e
    return { data: null, key: null }
  }
  return res
}

export { watch } from './runtime-watch.js'

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
