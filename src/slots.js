/*
 * slots.js — vslot 内容投影
 */

import { Wrap, Cancel, SetDataRoot, GenUniqueID } from './reactive.js'
import { Run } from './sandbox.js'
import { instanceOf, metaOf, setNodeScope } from './component-instance.js'
import { watch } from './runtime-watch.js'
import { getSharedTemplateNodes } from './source-cache.js'

function cloneNodes(nodes) {
  return (nodes || []).map(node => node.cloneNode(true))
}

// 插槽/后备模板源全局共享（只读，渲染时克隆）：
// 同一投影点内容在所有组件实例间只驻留一份
function sharedSlotTemplate(node, removeVslot) {
  const key = node.nodeType === 3
    ? `st:${node.textContent}`
    : `se${removeVslot ? '1' : '0'}:${node.outerHTML}`
  return getSharedTemplateNodes(key, () => {
    const c = node.cloneNode(true)
    if (removeVslot) c.removeAttribute?.('vslot')
    return c
  })
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
  const bindAttrs = bindValue.split(',').map(item => item.trim()).filter(Boolean)
  // vbind 属性必须先落为本地 key（Wrap 的 set 会穿透 root 链，
  // 否则 watcher 同步 outlet 值时会误写入投影方的 sourceData）
  const local = {}
  bindAttrs.forEach(attr => { local[attr] = outletData[attr] })
  const slotData = Wrap(local)
  SetDataRoot(slotData, sourceData)
  const scope = instanceOf(dom)?.scope
  const watcherIds = []
  bindAttrs.forEach(attr => {
    const watcherId = watch(scope, () => outletData[attr], (value) => {
      slotData[attr] = value
    }, { deep: true })
    watcherIds.push(watcherId)
  })
  return { data: slotData, cleanup: () => watcherIds.forEach(id => Cancel(id)) }
}

function createOutletState(dom) {
  const state = metaOf(dom).slotOutletState
  if (state) return state
  const nextState = {
    fallbackTemplates: Array.from(dom.childNodes).map(n => sharedSlotTemplate(n, false)),
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
    if (node.nodeType === 3 && !node.textContent.trim()) return
    const slotName = normalizeSlotName(node.getAttribute?.('vslot'))
    const template = sharedSlotTemplate(node, true)
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
