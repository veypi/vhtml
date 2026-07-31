/*
 * component.js — 组件系统
 * Copyright (C) 2024 veypi <i@veypi.com>
 *
 * 组件解析、setup、挂载主流程。
 */

import { Wrap, EnsureWrap } from './reactive.js'
import { Run, AsyncRun } from './sandbox.js'
import utils from './utils.js'
import { createRuntimeContext } from './module.js'
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
  const activeRuntime = (runtime?.$mod || runtime?.$sys || runtime?.scoped !== undefined)
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
  dom.setAttribute('vparsing', '')

  const parentRuntime = runtime
  const refOf = dom.getAttribute('vrefof')
  const parentRef = dom.closest(`*[vref='${refOf}']`)
  if (parentRef) runtime = instanceOf(parentRef)?.runtime

  if (!target && vsrc) {
    if (!vsrc.endsWith('.html')) vsrc = `${vsrc}.html`
    target = await templateLoader.fetchUI(vsrc, runtime, isUnsafe)
    if (instanceOf(dom, false) !== instance) return
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
  if (instanceOf(dom, false) !== instance) return
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
}

export async function setupRef(dom, data, parentRuntime, target, instance, singleMode = false, ctx) {
  const originData = Wrap({ $refs: Wrap({}) })
  let inst = instance || instanceOf(dom, false)
  if (!inst) return originData
  const componentRuntime = inst?.runtime
  const sandboxOptions = inst?.unsafe ? { unsafe: true } : {}

  if (target.setup) {
    let script = target.setup.innerHTML
    if (inst?.unsafe) {
      console.warn(`unsafe component "${target.url}" contains <script setup>, imports and external modules are blocked`)
    }
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
    inst = instanceOf(dom, false)
    if (!inst) return originData
  }

  if (!originData.$refs || typeof originData.$refs !== 'object') {
    originData.$refs = Wrap({})
  }
  instance.data = originData

  if (singleMode) return originData

  if (!instance.sourceNodes) {
    instance.sourceNodes = Array.from(dom.childNodes)
      .filter(n => !(n.nodeType === 3 && !n.textContent.trim()))
      .map(node => node.cloneNode(true))
  }
  if (dom.hasAttribute('vslot-inherit')) {
    dom.removeAttribute('vslot-inherit')
    let owner = instanceOf(dom.parentNode)
    while (owner && !owner.slotContents) {
      owner = instanceOf(owner.host?.parentNode)
    }
    instance.slotContents = owner?.slotContents || {}
  } else {
    const slotContents = createSlotContents(instance.sourceNodes || [], data, parentRuntime)
    instance.slotContents = slotContents
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
        watch(scope, () => Run(expr, data, parentRuntime), () => {
          originData[key] = Run(expr, data, parentRuntime)
        }, { deep: true })
      } else {
        watch(scope, () => data[key], () => {
          originData[key] = data[key]
        }, { deep: true })
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
  return originData
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
