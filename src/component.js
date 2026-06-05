/*
 * component.js — 组件系统
 * Copyright (C) 2024 veypi <i@veypi.com>
 *
 * 合并原 component.js + slots.js + scope.js + instance.js + store.js。
 * ComponentInstance 直接持有全部属性，不设 getter/setter 包装函数。
 * DOM 仅暴露 $data/$sys/$mod 三个公开 getter。
 */

import { Wrap, Watch, Cancel, SetDataRoot, GenUniqueID } from './reactive.js'
import { Run, AsyncRun } from './sandbox.js'
import utils from './utils.js'
import { createRuntimeContext, resolveScope } from './module.js'
import { parseImports } from './imports.js'
import { registerScriptLifecycle } from './lifecycle.js'
import { templateLoader } from './loader.js'

// ===================================================================
// ComponentScope — 组件生命周期管理
// ===================================================================

export class ComponentScope {
  constructor(host = null) {
    this.host = host
    this.cleanups = []
    this.timers = new Set()
    this.intervals = new Set()
    this.lifecycle = { active: [], deactive: [], dispose: [] }
    this.state = 'created'
  }

  addCleanup(cleanup) {
    if (typeof cleanup === 'function') this.cleanups.push(cleanup)
    return cleanup
  }

  addWatcher(cancel) {
    return this.addCleanup(cancel)
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

  onActive(fn) {
    if (typeof fn === 'function') this.lifecycle.active.push(fn)
  }

  onDeactive(fn) {
    if (typeof fn === 'function') this.lifecycle.deactive.push(fn)
  }

  onDispose(fn) {
    if (typeof fn === 'function') this.lifecycle.dispose.push(fn)
  }

  activate(context) {
    this.state = 'active'
    for (const fn of this.lifecycle.active) fn(context)
  }

  deactive(context) {
    this.state = 'inactive'
    for (const fn of this.lifecycle.deactive) fn(context)
  }

  dispose(context) {
    if (this.state === 'disposed') return
    this.state = 'disposed'
    for (const fn of this.lifecycle.dispose) fn(context)
    for (const cleanup of this.cleanups.splice(0)) cleanup()
    for (const id of this.timers) window.clearTimeout(id)
    this.timers.clear()
    for (const id of this.intervals) window.clearInterval(id)
    this.intervals.clear()
  }
}

// ===================================================================
// ComponentInstance — 组件树节点，直接持有全部属性
// ===================================================================

export class ComponentInstance {
  constructor(host, kind = 'component') {
    this.host = host          // DOM 宿主元素
    this.kind = kind          // 'component' | 'boundary' | 'page' | 'layout' | 'slot-outlet'
    this.parent = null        // 父 ComponentInstance
    this.children = new Set() // 子 ComponentInstance 集合
    this.scope = null         // ComponentScope
    this.runtime = null       // { $sys, $mod }
    this.data = null          // 响应式数据 (Wrap 对象)
    this.vsrc = ''            // 组件源 URL
    this.events = null        // 自定义事件回调表
    this.slotContents = null  // 插槽内容 (从父组件传入)
    this.sourceNodes = null   // 原始子节点快照 (v-if 恢复用)
    this.vforData = null      // v-for 当前迭代数据
    this.slotOutletState = null // 插槽出口状态
    this.unsafe = false
    this._scriptError = null  // { code, message } 脚本执行失败时设置
  }
}

// ===================================================================
// 实例查找 —— 单一 WeakMap，3 个 DOM getter
// ===================================================================

const nodeInst = new WeakMap()
const apiBound = new WeakSet()
const nodeMeta = new WeakMap() // { sourceNodes, vforData, slotOutletState, parsed }
const nodeScopeMap = new WeakMap() // { runtime, scope } — 非元素节点（如 slot 内的 text node）

/** 沿 DOM 树向上查找最近的 ComponentInstance；walk=false 仅查当前节点 */
export function instanceOf(node, walk = true) {
  if (!walk) return nodeInst.get(node) ?? null
  while (node) {
    const inst = nodeInst.get(node)
    if (inst) return inst
    node = node.parentNode || node.host || null
  }
  return null
}

/** 绑定 DOM 节点与实例，同时挂 $data/$sys/$mod getter */
export function setInstance(node, instance) {
  nodeInst.set(node, instance)
  if (apiBound.has(node)) return
  apiBound.add(node)
  Object.defineProperties(node, {
    $data: { configurable: true, enumerable: false, get() { return nodeInst.get(node)?.data ?? null } },
    $sys: { configurable: true, enumerable: false, get() { return nodeInst.get(node)?.runtime?.$sys ?? null } },
    $mod: { configurable: true, enumerable: false, get() { return nodeInst.get(node)?.runtime?.$mod ?? null } },
  })
}

// ---- 元素级元数据（不依赖实例）----

/** 获取节点的元数据对象 { sourceNodes, vforData, slotOutletState, parsed } */
export function metaOf(node) {
  let m = nodeMeta.get(node)
  if (!m) { m = {}; nodeMeta.set(node, m) }
  return m
}

/** 为非元素节点（如 slot 内的 text node）直接设置 runtime/scope */
export function setNodeScope(node, runtime, scope) {
  if (!node) return
  nodeScopeMap.set(node, { runtime: runtime || null, scope: scope || null })
}

/** 获取非元素节点上的直接 runtime/scope（不走 instanceOf 向上查找） */
export function getNodeScope(node) {
  return nodeScopeMap.get(node) || null
}

// ===================================================================
// 树操作
// ===================================================================

export function createInstance(host, parent = null, kind = 'component') {
  const instance = new ComponentInstance(host, kind)
  return attachChildInstance(parent, instance)
}

export function attachChildInstance(parent, child) {
  if (!child) return child
  if (child.parent && child.parent !== parent) {
    child.parent.children.delete(child)
  }
  child.parent = parent || null
  if (parent) parent.children.add(child)
  return child
}

export function detachInstance(instance) {
  if (!instance) return
  if (instance.parent) {
    instance.parent.children.delete(instance)
    instance.parent = null
  }
  instance.children.forEach(child => { child.parent = null })
  instance.children.clear()
}

// ===================================================================
// 清理
// ===================================================================

function purgeNodeState(node) {
  if (!node) return
  const instance = nodeInst.get(node)
  if (instance) {
    detachInstance(instance)
    nodeInst.delete(node)
  }
  nodeMeta.delete(node)
}

function disposeInstanceSubtree(instance) {
  if (!instance) return
  for (const child of Array.from(instance.children)) {
    disposeInstanceSubtree(child)
  }
  const host = instance.host
  if (host) {
    instance.scope?.dispose(host)
    purgeNodeState(host)
  }
}

export function disposeRuntimeSubtree(node) {
  if (!node || node.nodeType !== 1) return
  const instance = nodeInst.get(node)
  if (instance) {
    disposeInstanceSubtree(instance)
    return
  }
  const inst = nodeInst.get(node)
  inst?.scope?.dispose(node)
  purgeNodeState(node)
  node.childNodes?.forEach(child => {
    if (child.nodeType === 1) disposeRuntimeSubtree(child)
  })
}


// ===================================================================
// 辅助
// ===================================================================

function watch(scope, target, callback, options) {
  const id = Watch(target, callback, options)
  scope?.addWatcher(() => Cancel(id))
  return id
}

// ===================================================================
// 插槽系统 (原 slots.js)
// ===================================================================

function cloneNodes(nodes) {
  return (nodes || []).map(node => node.cloneNode(true))
}

function normalizeSlotName(name) {
  return name === undefined || name === null ? '' : String(name)
}

function resolveSlotOwner(dom) {
  const slotOf = dom.getAttribute('vrefof')
  let refDom = dom.closest(`*[vref='${slotOf}']`)
  if (!refDom) return null
  while (true) {
    const parentRef = refDom?.parentNode?.closest?.('*[vref]')
    if (!parentRef) break
    if (parentRef.getAttribute('vref') === slotOf) {
      refDom = parentRef
      continue
    }
    break
  }
  return refDom
}

function createSlotBindingData(dom, outletData, sourceData) {
  const bindValue = dom.getAttribute('vbind')
  if (!bindValue) return { data: sourceData, cleanup: null }
  const slotData = Wrap({})
  SetDataRoot(slotData, sourceData)
  const bindAttrs = bindValue.split(',').map(item => item.trim()).filter(Boolean)
  const scope = instanceOf(dom)?.scope
  const watcherIds = []
  bindAttrs.forEach(attr => {
    const watcherId = watch(scope, () => outletData[attr], (value) => {
      slotData[attr] = value
    }, { deep: true })
    watcherIds.push(watcherId)
    slotData[attr] = outletData[attr]
  })
  return { data: slotData, cleanup: () => watcherIds.forEach(id => Cancel(id)) }
}

function createOutletState(dom) {
  const state = metaOf(dom).slotOutletState
  if (state) return state
  const nextState = {
    fallbackTemplates: cloneNodes(Array.from(dom.childNodes)),
    currentKey: '',
    currentMode: '',
    cleanup: null,
  }
  dom.innerHTML = ''
  metaOf(dom).slotOutletState = nextState
  return nextState
}

function renderSlotNodes(dom, templates, data, runtime, ctx) {
  dom.innerHTML = ''
  dom.append(...cloneNodes(templates))
  const projectedScope = instanceOf(dom)?.scope
  const children = ctx.compileVif(Array.from(dom.childNodes), data, runtime, ctx)
  children.forEach(node => {
    if (node.nodeType === 1) {
      ctx.ensureBoundary?.(node, data, runtime)
    } else {
      setNodeScope(node, runtime, projectedScope)
    }
    ctx.compileNode(node, data, runtime, ctx, projectedScope)
  })
}

function resetOutletState(state) {
  state.cleanup?.()
  state.cleanup = null
}

function evaluateSlotName(dom, data, runtime) {
  if (dom.hasAttribute(':name')) {
    return normalizeSlotName(Run(dom.getAttribute(':name'), data, runtime))
  }
  return normalizeSlotName(dom.getAttribute('name'))
}

export function createSlotContents(sourceNodes, data, runtime) {
  const slots = Object.create(null)
  sourceNodes.forEach(node => {
    // 跳过纯空白文本节点，避免换行/缩进被当作默认 slot 内容
    if (node.nodeType === 3 && !node.textContent.trim()) return
    const template = node.cloneNode(true)
    const slotName = normalizeSlotName(template.getAttribute?.('vslot'))
    template.removeAttribute?.('vslot')
    if (!slots[slotName]) {
      slots[slotName] = {
        id: GenUniqueID(),
        name: slotName,
        templates: [],
        data,
        runtime,
      }
    }
    slots[slotName].templates.push(template)
  })
  return slots
}

export function parseSlots(dom, data, runtime, ctx) {
  if (dom.hasAttribute?.('data-vrouter-managed')) {
    ctx.compileAttrs(dom, data, runtime, ctx)
    return dom
  }
  const owner = resolveSlotOwner(dom)
  if (!owner) {
    ctx.onMountedRun?.(dom, (node) => {
      parseSlots(node, data, runtime, ctx)
    })
    return dom
  }
  const state = createOutletState(dom)
  const scope = instanceOf(dom)?.scope
  watch(scope, () => {
    const slotName = evaluateSlotName(dom, data, runtime)
    const ownerInstance = instanceOf(owner)
    const slotContents = ownerInstance?.slotContents || {}
    const selected = slotContents[slotName] || null
    return { slotName, selected }
  }, ({ slotName, selected }) => {
    if (selected) {
      const renderKey = `projected:${slotName}:${selected.id}`
      if (state.currentKey === renderKey && state.currentMode === 'projected') return
      resetOutletState(state)
      const slotBinding = createSlotBindingData(dom, data, selected.data)
      renderSlotNodes(dom, selected.templates, slotBinding.data, selected.runtime, ctx)
      state.currentKey = renderKey
      state.currentMode = 'projected'
      state.cleanup = slotBinding.cleanup
      return
    }
    const renderKey = `fallback:${slotName}`
    if (state.currentKey === renderKey && state.currentMode === 'fallback') return
    resetOutletState(state)
    renderSlotNodes(dom, state.fallbackTemplates, data, runtime, ctx)
    state.currentKey = renderKey
    state.currentMode = 'fallback'
  })
  ctx.compileAttrs(dom, data, runtime, ctx)
  return dom
}

// ===================================================================
// 组件解析/挂载 (原 component.js)
// ===================================================================

function createLocalRouter(rootRouter, scoped) {
  if (!scoped || !rootRouter) return rootRouter

  const isExternal = (p) => /^https?:\/\//.test(p)

  const resolve = (to) => {
    if (typeof to === 'string' && !isExternal(to) && !to.startsWith(scoped)) {
      return scoped + (to.startsWith('/') ? to : '/' + to)
    }
    if (to?.path && !isExternal(to.path) && !to.path.startsWith(scoped)) {
      return { ...to, path: scoped + (to.path.startsWith('/') ? to.path : '/' + to.path) }
    }
    return to
  }

  return {
    push(to) { return rootRouter.push(resolve(to)) },
    replace(to) { return rootRouter.replace(resolve(to)) },
    go(n) { return rootRouter.go(n) },
    back() { return rootRouter.back() },
    forward() { return rootRouter.forward() },
    onChange(listener) { return rootRouter.onChange(listener) },
    get current() { return rootRouter.current },
    get params() { return rootRouter.params },
    get query() { return rootRouter.query },
    get history() { return rootRouter.history },
  }
}

export async function parseRaw(dom, data, runtime, code, ctx) {
  const tmpId = `_${Math.random().toString(36).slice(2)}`
  const target = await templateLoader.parseUI(code, runtime || {}, tmpId)
  ctx.parseRef(tmpId, dom, data || {}, { ...runtime }, target)
}

export async function parseRef(vsrc, dom, data, runtime, target, optsOrCtx, ctx) {
  ctx = (optsOrCtx && typeof optsOrCtx === 'object' && optsOrCtx.compileNode) ? optsOrCtx : (ctx)
  const options = (optsOrCtx && typeof optsOrCtx === 'object' && !optsOrCtx.compileNode) ? optsOrCtx : {}
  const singleMode = options.single || (typeof optsOrCtx === 'boolean' ? optsOrCtx : false)

  const previousInstance = nodeInst.get(dom)
  const parentInstance = instanceOf(dom.parentNode)
  if (previousInstance) {
    previousInstance.scope?.dispose(dom)
    detachInstance(previousInstance)
    nodeInst.delete(dom)
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
    target = await templateLoader.fetchUI(vsrc, runtime, dom.hasAttribute('scoped'), isUnsafe)
    if (!nodeInst.get(dom)) return
  }

  const mod = target?.mod || runtime?.$mod || null
  const rootRouter = runtime?.$sys?.$router || null
  const url_prefix = mod?.url_prefix ?? resolveScope(mod)
  const runtimeRouter = createLocalRouter(rootRouter, url_prefix)
  const componentRuntime = createRuntimeContext(runtime || null, mod, { $router: runtimeRouter })
  if (isUnsafe) componentRuntime.__unsafe = true
  componentRuntime.$sys.$emit = (evt, ...args) => {
    evt = evt.toLowerCase()
    const events = instanceOf(dom, false)?.events
    if (!events) return
    const callback = events[evt]
    if (typeof callback === 'function') callback(...args)
  }
  instance.runtime = componentRuntime
  instance.vsrc = vsrc

  const originData = await setupRef(dom, data, parentRuntime, target, instance, singleMode, ctx)
  if (!nodeInst.get(dom)) return
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
  instance.scope?.activate(dom)
}

export async function setupRef(dom, data, parentRuntime, target, instance, singleMode = false, ctx) {
  const originData = Wrap({ $refs: Wrap({}) })
  let inst = instance || nodeInst.get(dom)
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
    inst = nodeInst.get(dom)
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
  const instance = nodeInst.get(dom)
  if (!instance?.scope) {
    if (instance) instance.scope = new ComponentScope(dom)
  }
  const sandboxOptions = instance?.unsafe ? { unsafe: true } : {}
  for (const script of target.scripts) {
    registerScriptLifecycle(script, dom, instance, componentData, runtime, sandboxOptions)
  }
}
