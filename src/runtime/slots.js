import vproxy from '../vproxy.js'
import { findNearestInstance, getInstance, getScope, getSlotContents, getSlotOutletState, setSlotOutletState } from './dom.js'

function resolveContext(renderer, dom) {
  return renderer.contextOf ? renderer.contextOf(dom) : {
    instance: getInstance(dom) || findNearestInstance(dom, null),
    scope: renderer.scopeOf(dom) || getScope(dom),
  }
}

function cloneNodes(nodes) {
  return (nodes || []).map((node) => node.cloneNode(true))
}

function normalizeSlotName(name) {
  return name === undefined || name === null ? '' : String(name)
}

function resolveSlotOwner(dom) {
  const slotOf = dom.getAttribute('vrefof')
  let refDom = dom.closest(`*[vref='${slotOf}']`)
  if (!refDom) {
    return null
  }
  while (true) {
    const parentRef = refDom?.parentNode?.closest?.('*[vref]')
    if (!parentRef) {
      break
    }
    if (parentRef.getAttribute('vref') === slotOf) {
      refDom = parentRef
      continue
    }
    break
  }
  return refDom
}

function createSlotBindingData(renderer, outletDom, outletData, sourceData) {
  const bindValue = outletDom.getAttribute('vbind')
  if (!bindValue) {
    return { data: sourceData, cleanup: null }
  }
  const slotData = vproxy.Wrap({})
  vproxy.SetDataRoot(slotData, sourceData)
  const bindAttrs = bindValue.split(',').map((item) => item.trim()).filter(Boolean)
  const scope = resolveContext(renderer, outletDom).scope
  const watcherIds = []
  bindAttrs.forEach((attr) => {
    const watcherId = renderer.watch(scope, () => outletData[attr], (value) => {
      slotData[attr] = value
    }, { deep: true })
    watcherIds.push(watcherId)
    slotData[attr] = outletData[attr]
  })
  return {
    data: slotData,
    cleanup: () => watcherIds.forEach((id) => vproxy.Cancel(id)),
  }
}

function createOutletState(dom) {
  const state = getSlotOutletState(dom)
  if (state) {
    return state
  }
  const nextState = {
    fallbackTemplates: cloneNodes(Array.from(dom.childNodes)),
    currentKey: '',
    currentMode: '',
    cleanup: null,
  }
  dom.innerHTML = ''
  setSlotOutletState(dom, nextState)
  return nextState
}

function renderSlotNodes(renderer, dom, templates, data, env) {
  dom.innerHTML = ''
  dom.append(...cloneNodes(templates))
  const children = renderer.parseVif(Array.from(dom.childNodes), data, env)
  children.forEach((node) => renderer.parseDom(node, data, env, resolveContext(renderer, node).scope))
}

function resetOutletState(state) {
  state.cleanup?.()
  state.cleanup = null
}

function evaluateSlotName(dom, data, env) {
  if (dom.hasAttribute(':name')) {
    return normalizeSlotName(vproxy.Run(dom.getAttribute(':name'), data, env))
  }
  return normalizeSlotName(dom.getAttribute('name'))
}

export function createSlotContents(sourceNodes, data, env) {
  const slots = Object.create(null)
  sourceNodes.forEach((node) => {
    const template = node.cloneNode(true)
    const slotName = normalizeSlotName(template.getAttribute?.('vslot'))
    template.removeAttribute?.('vslot')
    if (!slots[slotName]) {
      slots[slotName] = {
        id: vproxy.GenUniqueID(),
        name: slotName,
        templates: [],
        data,
        env,
      }
    }
    slots[slotName].templates.push(template)
  })
  return slots
}

export function parseSlots(renderer, dom, data, env) {
  if (dom.hasAttribute?.('data-vrouter-managed')) {
    renderer.parseAttrs(dom, data, env)
    return dom
  }
  const owner = resolveSlotOwner(dom)
  if (!owner) {
    renderer.onMountedRun(dom, (node) => {
      parseSlots(renderer, node, data, env)
    })
    return dom
  }
  const state = createOutletState(dom)
  const context = resolveContext(renderer, dom)
  renderer.watch(context.scope, () => {
    const slotName = evaluateSlotName(dom, data, env)
    const ownerInstance = findNearestInstance(owner, null)
    const slotContents = ownerInstance?.slots || getSlotContents(owner) || {}
    const selected = slotContents[slotName] || null
    return { slotName, selected }
  }, ({ slotName, selected }) => {
    if (selected) {
      const renderKey = `projected:${slotName}:${selected.id}`
      if (state.currentKey === renderKey && state.currentMode === 'projected') {
        return
      }
      resetOutletState(state)
      const slotBinding = createSlotBindingData(renderer, dom, data, selected.data)
      renderSlotNodes(renderer, dom, selected.templates, slotBinding.data, selected.env)
      state.currentKey = renderKey
      state.currentMode = 'projected'
      state.cleanup = slotBinding.cleanup
      return
    }
    const renderKey = `fallback:${slotName}`
    if (state.currentKey === renderKey && state.currentMode === 'fallback') {
      return
    }
    resetOutletState(state)
    renderSlotNodes(renderer, dom, state.fallbackTemplates, data, env)
    state.currentKey = renderKey
    state.currentMode = 'fallback'
  })
  renderer.parseAttrs(dom, data, env)
  return dom
}
