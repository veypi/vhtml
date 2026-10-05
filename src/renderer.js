/*
 * renderer.js — 渲染上下文工厂
 * Copyright (C) 2024 veypi <i@veypi.com>
 *
 * 提供 createRenderContext 组装 compiler ↔ component ↔ router 之间的 ctx 胶水对象。
 * 无全局副作用：MO、样式注入由 Vhtml 实例管理。
 */

import { $router } from './router.js'
import { watch } from './runtime-watch.js'
import {
  compileNode,
  compileAttrs,
  compileVif,
  compileAttr,
  ensureStructuralBoundary,
} from './compiler.js'
import { parseRef, parseSlots, parseRaw } from './component.js'
import { parseAccessChain } from './execution/source.js'

export function bindingPath(code, data) {
  const chain = parseAccessChain(code)
  if (!chain?.length)
    throw new SyntaxError(
      `Two-way binding requires a static property path: ${code}`
    )
  return { root: data, chain }
}

export { watch } from './runtime-watch.js'

/**
 * 创建渲染上下文（ctx 胶水对象）。
 * helpers 由 Vhtml 实例注入：{ suspendMO, resumeMO }
 */
export function createRenderContext(helpers) {
  const { suspendMO, resumeMO } = helpers
  const ctx = {
    watch,
    bindingPath,
    suspendMO,
    resumeMO,
    compileNode,
    compileAttrs,
    compileVif,
    compileAttr,
    ensureBoundary: ensureStructuralBoundary,
    parseRef(vsrc, dom, data, runtime, options) {
      return parseRef(vsrc, dom, data, runtime, options, ctx)
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
