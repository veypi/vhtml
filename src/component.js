/*
 * component.js — 组件系统
 * Copyright (C) 2024 veypi <i@veypi.com>
 *
 * 组件解析、setup、挂载主流程。
 */

import { Wrap, EnsureWrap } from './reactive.js'
import { Run, AsyncRun } from './sandbox.js'
import utils from './utils.js'
import { createRuntimeContext, RUNTIME } from './module.js'
import { parseImports } from './imports.js'
import { registerScriptLifecycle } from './lifecycle.js'
import { templateLoader } from './loader.js'
import { ComponentScope } from './component-scope.js'
import {
  instanceOf,
  setInstance,
  createInstance,
  detachInstance,
} from './component-instance.js'
import { createSlotContents } from './slots.js'
import { watch } from './runtime-watch.js'

export { ComponentScope } from './component-scope.js'
export {
  ComponentInstance,
  instanceOf,
  setInstance,
  metaOf,
  setNodeScope,
  getNodeScope,
  createInstance,
  attachChildInstance,
  detachInstance,
  disposeRuntimeSubtree,
} from './component-instance.js'
export { createSlotContents, parseSlots } from './slots.js'


// ===================================================================
// 组件解析/挂载 (原 component.js)
// ===================================================================

export async function parseRaw(dom, data, runtime, code, ctx) {
  data = EnsureWrap(data || {})
  const tmpId = `_${Math.random().toString(36).slice(2)}`
  // RUNTIME symbol 显式标记（取代 $mod/$sys/scoped 鸭子判定）
  const activeRuntime = (runtime && runtime[RUNTIME])
    ? runtime
    : instanceOf(dom)?.runtime || runtime || {}
  const target = await templateLoader.parseUI(code, activeRuntime, tmpId)
  ctx.parseRef(tmpId, dom, data, activeRuntime, target)
}

export async function parseRef(vsrc, dom, data, runtime, target, optsOrCtx, ctx) {
  data = EnsureWrap(data || {})
  ctx = (optsOrCtx && typeof optsOrCtx === 'object' && optsOrCtx.compileNode) ? optsOrCtx : (ctx)
  const options = (optsOrCtx && typeof optsOrCtx === 'object' && !optsOrCtx.compileNode) ? optsOrCtx : {}
  const singleMode = options.single || (typeof optsOrCtx === 'boolean' ? optsOrCtx : false)

  const previousInstance = instanceOf(dom, false)
  const parentInstance = instanceOf(dom.parentNode)
  if (previousInstance) {
    previousInstance.scope?.dispose(dom)
    detachInstance(previousInstance)
  }

  const isUnsafe = dom.hasAttribute('unsafe') || (parentInstance?.unsafe ?? false)
  if (dom.hasAttribute('unsafe')) dom.removeAttribute('unsafe')

  const instance = createInstance(dom, parentInstance, 'component')
  setInstance(dom, instance)
  instance.unsafe = isUnsafe
  instance.scope = new ComponentScope(dom)
  // v0.10.1 阶段 3：data-keep 属性翻译为实例字段（router 在 parseRef 之前
  // setAttribute，实例此刻才存在；翻译后即移除，运行时判读不再依赖 DOM 属性）
  if (dom.hasAttribute('data-keep')) {
    instance.keepOnDetach = true
    dom.removeAttribute('data-keep')
  }
  dom.setAttribute('vparsing', '')
  // 兜底清理：仅当元素上没有新实例接管（自己被替换/销毁）时才移除 vparsing，
  // 避免误删新实例的解析标记；异常或竞态提前退出时组件不会永久隐藏。
  const clearParsing = () => {
    const cur = instanceOf(dom, false)
    if (cur === instance || cur === null) dom.removeAttribute('vparsing')
  }

  try {
  const parentRuntime = runtime
  const refOf = dom.getAttribute('vrefof')
  const parentRef = dom.closest(`*[vref='${refOf}']`)
  if (parentRef) runtime = instanceOf(parentRef)?.runtime

  // v0.10.1 阶段 5：generation token 统一竞态契约。scope.dispose 是唯一销毁口
  // （显式销毁/parseRef 替换都经它 kill()），await 边界统一 alive() 校验，
  // 取代逐点 instanceOf(dom,false)!==instance 检查
  const token = instance.scope.token
  const ticket = token.issue()

  if (!target && vsrc) {
    if (!vsrc.endsWith('.html')) vsrc = `${vsrc}.html`
    target = await templateLoader.fetchUI(vsrc, runtime, isUnsafe)
    if (!token.alive(ticket)) {
      // 竞态：实例已被替换/销毁（如路由竞态 dispose），提前退出，finally 兜底清理
      return
    }
  }

  const mod = target?.mod || runtime?.$mod || null
  const componentRuntime = createRuntimeContext(runtime || null, mod)
  if (isUnsafe) componentRuntime.__unsafe = true
  const warnedBuiltinEmitEvents = new Set()
  componentRuntime.$sys.$emit = (evt, ...args) => {
    evt = evt.toLowerCase()
    if (utils.EventsList.indexOf(evt) !== -1 && !warnedBuiltinEmitEvents.has(evt)) {
      warnedBuiltinEmitEvents.add(evt)
      console.warn(`[vhtml] $emit("${evt}") 使用了 DOM 内置事件名，父组件的 @${evt} 会被当作原生 DOM 事件监听，组件自定义事件不会触发。请改用非内置事件名。`)
    }
    const events = instanceOf(dom, false)?.events
    if (!events) return
    const callback = events[evt]
    if (typeof callback === 'function') callback(...args)
  }
  instance.runtime = componentRuntime
  instance.vsrc = vsrc

  const originData = await setupRef(dom, data, parentRuntime, target, instance, singleMode, ctx)
  if (!token.alive(ticket)) {
    return
  }
  ctx.suspendMO?.()

  if (singleMode) {
    ctx.compileAttrs(dom, originData, componentRuntime, ctx, target?.customAttrs)
  } else {
    ctx.compileAttrs(dom, data, parentRuntime, ctx, target?.customAttrs)
  }

  const children = ctx.compileVif(Array.from(dom.childNodes), originData, componentRuntime, ctx)
  for (const child of children) {
    ctx.compileNode(child, originData, componentRuntime, ctx)
  }
  dom.removeAttribute('vparsing')
  ctx.resumeMO?.()

  mountRef(dom, originData, componentRuntime, target, ctx)
  instance.scope?.activate(dom, 'mount')
  } catch (error) {
    // 解析/编译异常：报错并确保 MO 恢复，避免 MutationObserver 永久挂起
    console.error(`[vhtml] parseRef failed: ${vsrc || target?.url || ''}`, error)
    ctx.resumeMO?.()
    clearParsing()
  } finally {
    clearParsing()
  }
}

export async function setupRef(dom, data, parentRuntime, target, instance, singleMode = false, ctx) {
  const originData = Wrap({ $refs: Wrap({}) })
  let inst = instance || instanceOf(dom, false)
  if (!inst) return originData
  const componentRuntime = inst?.runtime
  const sandboxOptions = inst?.unsafe ? { unsafe: true } : {}

  if (target.setup) {
    let script = target.setup.code
    if (inst?.unsafe) {
      console.warn(`unsafe component "${target.url}" contains <script setup>, imports and external modules are blocked`)
    }
    // 异步段令牌（v0.10.1 阶段 5）：parseImports/AsyncRun 两处 await 边界统一校验
    const token = instance.scope.token
    const ticket = token.issue()
    script = await parseImports(script, originData, componentRuntime, target.url, inst?.unsafe)
    await AsyncRun(script, originData, componentRuntime, {
      $node: dom,
      $watch: (targetFn, callback, options) => {
        const scope = inst?.scope
        const register = () => {
          watch(scope, targetFn, callback, options)
        }
        if (scope) scope.setTimeout(register, 50)
        else setTimeout(register, 50)
      },
    }, sandboxOptions)
    if (!token.alive(ticket)) return originData
    inst = instanceOf(dom, false)
    if (!inst) return originData
  }

  if (!originData.$refs || typeof originData.$refs !== 'object') {
    originData.$refs = Wrap({})
  }
  instance.data = originData

  if (singleMode) return originData

  if (dom.hasAttribute('vslot-inherit')) {
    dom.removeAttribute('vslot-inherit')
    let owner = instanceOf(dom.parentNode)
    while (owner && !owner.slotContents) {
      owner = instanceOf(owner.host?.parentNode)
    }
    instance.slotContents = owner?.slotContents || {}
  } else {
    // 插槽源直接取宿主当前子节点（createSlotContents 内部逐条深克隆），
    // 不再在实例上驻留快照副本（实例终生持有会双倍占用内存）
    const slotSources = Array.from(dom.childNodes)
      .filter(n => !(n.nodeType === 3 && !n.textContent.trim()))
    instance.slotContents = createSlotContents(slotSources, data, parentRuntime)
  }
  dom.innerHTML = ''

  const bodyClone = target.body.cloneNode(true)
  dom.append(...bodyClone.childNodes)

  const scope = instance.scope
  Object.keys(originData).forEach(key => {
    const localKey = utils.CamelToKebabCase(key)
    if (typeof originData[key] === 'boolean') {
      if (dom.hasAttribute(key) || dom.hasAttribute(localKey)) {
        originData[key] = true
      }
    } else if (dom.hasAttribute(key)) {
      originData[key] = dom.getAttribute(key)
      dom.removeAttribute(key)
    } else if (dom.hasAttribute(localKey)) {
      originData[key] = dom.getAttribute(localKey)
      dom.removeAttribute(localKey)
    }

    if (dom.hasAttribute(`:${key}`) || dom.hasAttribute(`:${localKey}`)) {
      const expr = dom.getAttribute(`:${key}`) || dom.getAttribute(`:${localKey}`)
      dom.removeAttribute(`:${key}`)
      dom.removeAttribute(`:${localKey}`)
      delete originData[key]
      if (expr) {
        // v0.10.0：删 deep —— 求值路径读取即注册，深层传播靠共享 proxy 本身；
        // 变更门控（Object.is）下天然引用语义，回调直接消费阶段一求值结果
        watch(scope, () => Run(expr, data, parentRuntime), (value) => {
          originData[key] = value
        })
      } else {
        watch(scope, () => data[key], (value) => {
          originData[key] = value
        })
      }
    }

    if (dom.hasAttribute(`v:${key}`) || dom.hasAttribute(`v:${localKey}`)) {
      let expr = dom.getAttribute(`v:${key}`) || dom.getAttribute(`v:${localKey}`)
      dom.removeAttribute(`v:${key}`)
      dom.removeAttribute(`v:${localKey}`)
      if (!expr) expr = key
      const args = ctx.findLastAccess?.(expr, data)
      if (!args || !args.key || args.data === undefined) {
        console.warn(`not find bind variables: ${expr}`)
        return
      }
      if (args.data[args.key] !== undefined && args.data[args.key] !== null) {
        delete originData[key]
      }
      watch(scope, () => args.data[args.key], () => {
        originData[key] = args.data[args.key]
      })
      watch(scope, () => originData[key], () => {
        args.data[args.key] = originData[key]
      })
    }
  })

  let attrs = Array.from(bodyClone.attributes)
  attrs = applyTemplateAttrs(dom, bodyClone, attrs, originData, componentRuntime, ctx)
  return originData
}

// 模板属性应用单独成函数：bodyClone/attrs 只在直排代码中被引用，
// 若留在 setupRef 作用域内，会被该作用域内长寿命的 watch/$watch 闭包
// 共享的 context 提升并终生驻留（V8 闭包共享上下文语义）
function applyTemplateAttrs(dom, bodyClone, attrs, originData, componentRuntime, ctx) {
  attrs = attrs.filter(attr => {
    if (ctx.compileAttr(dom, attr.name, attr.value, originData, componentRuntime, ctx)) {
      bodyClone.removeAttribute(attr.name)
      return false
    }
    return true
  })
  attrs.forEach(attr => {
    if (attr.name === 'class') {
      dom.classList.add(...attr.value.trim().split(/\s+/))
    } else if (attr.name === 'style') {
      attr.value.split(';').forEach(stylePart => {
        const segments = stylePart.split(':')
        if (segments.length !== 2 || dom.style[segments[0]]) return
        const styleKey = segments[0].trim()
        const styleValue = segments[1].trim()
        if (styleKey.startsWith('--')) dom.style.setProperty(styleKey, styleValue)
        else dom.style[styleKey] = styleValue
      })
    } else if (!dom.getAttribute(attr.name)) {
      dom.setAttribute(attr.name, attr.value)
    }
  })
}

export function mountRef(dom, componentData, runtime, target, ctx) {
  const instance = instanceOf(dom, false)
  if (!instance?.scope) {
    if (instance) instance.scope = new ComponentScope(dom)
  }
  const sandboxOptions = instance?.unsafe ? { unsafe: true } : {}
  for (const script of target.scripts) {
    registerScriptLifecycle(script, dom, instance, componentData, runtime, sandboxOptions)
  }
}
