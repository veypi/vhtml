/*
 * compiler.js — DOM 编译器
 * Copyright (C) 2024 veypi <i@veypi.com>
 *
 * 合并原 attributes.js + structure.js。
 * 所有属性从 ComponentInstance 直接访问，不设 wrapper 函数。
 */

import { Wrap, Watch, Cancel, GenUniqueID, DataID } from './reactive.js'
import { Run } from './sandbox.js'
import utils from './utils.js'
import { runMountedHandler } from './lifecycle.js'
import { isRelativeHref } from './url.js'
import {
  instanceOf, setInstance, metaOf,
  createInstance, detachInstance,
  disposeRuntimeSubtree, clearNodeState,
  ComponentScope, getNodeScope,
} from './component.js'

// ---- 辅助 ----

function watch(scope, target, callback, options) {
  const id = Watch(target, callback, options)
  scope?.addWatcher(() => Cancel(id))
  return id
}

function ensureRefPool(data) {
  if (!data || typeof data !== 'object') return null
  if (!data.$refs || typeof data.$refs !== 'object') {
    data.$refs = Wrap({})
  }
  return data.$refs
}

function resolveScopedUrl(rawUrl, runtime) {
  if (!rawUrl || rawUrl.startsWith('#')) return rawUrl
  if (rawUrl.startsWith('@')) return rawUrl.slice(1)
  if (runtime?.$mod?.scoped && isRelativeHref(rawUrl)) {
    return runtime.$mod.scoped + rawUrl
  }
  return rawUrl
}

// ---- 结构型编译 ----

const varRegex = /{{|}}/g
const vforRegex = /^\s*(?:\((\w+)\s*,\s*(\w+)\)|(\w+))\s+in\s+(.+?)\s*$/

export function ensureStructuralBoundary(dom, data, runtime) {
  let instance = instanceOf(dom, false)
  if (!instance) {
    instance = createInstance(dom, instanceOf(dom.parentNode), 'boundary')
    setInstance(dom, instance)
  }
  if (!instance.scope) {
    instance.scope = new ComponentScope(dom)
  }
  if (data !== undefined) {
    instance.data = data
  }
  if (!instance.runtime) {
    instance.runtime = runtime || null
  }
  return instance
}

function disposeBoundaryNode(node) {
  const inst = instanceOf(node, false)
  inst?.scope?.dispose(node)
  if (inst) detachInstance(inst)
  clearNodeState(node)
}

export function compileTextNode(dom, data, runtime, scope) {
  const runtimeScope = scope || instanceOf(dom)?.scope
  const txt = dom.nodeValue.trim()
  if (!txt) return
  let match, nextStart = 0, start = -1
  const parts = []
  while ((match = varRegex.exec(txt)) !== null) {
    if (match[0] === '{{') {
      start = match.index
    } else if (match[0] === '}}' && start >= 0) {
      if (nextStart !== start) parts.push(txt.slice(nextStart, start))
      parts.push('')
      const expr = txt.slice(start + 2, match.index)
      const partIndex = parts.length - 1
      start = -1
      nextStart = match.index + 2
      watch(runtimeScope, () => {
        let value = Run(expr, data, runtime)
        if (typeof value === 'function') value = value()
        else if (typeof value === 'object' && value) value = JSON.stringify(value)
        parts[partIndex] = value
        dom.nodeValue = parts.join('').trim()
      })
    }
  }
  parts.push(txt.slice(nextStart))
  dom.nodeValue = parts.join('')
}

export function compileVfor(vfortxt, dom, data, runtime, ctx) {
  dom.removeAttribute('v-for')
  const matches = vforRegex.exec(vfortxt)
  if (matches?.length !== 5) {
    console.error('vfor error:', vfortxt)
    return
  }
  const valueName = matches[1] || matches[3]
  const keyName = matches[2]
  const listExpr = matches[4]
  const anchor = document.createElement('div')
  anchor.style.display = 'none'
  const cacheId = GenUniqueID()
  const cache = Object.create(null)

  const createVforDom = (itemData, beforeNode, stripVif = false) => {
    const newDom = dom.cloneNode(true)
    if (stripVif) newDom.removeAttribute('v-if')
    ensureStructuralBoundary(newDom, itemData, runtime)
    anchor.parentNode.insertBefore(newDom, beforeNode)
    compileNode(newDom, itemData, runtime, ctx, instanceOf(newDom)?.scope)
    return newDom
  }

  const findInsertBefore = (currentKey) => {
    let found = false
    for (const key of Object.keys(cache)) {
      if (key === currentKey) { found = true; continue }
      if (!found) continue
      const nextDom = cache[key]?.dom
      if (nextDom?.isConnected) return nextDom
    }
    return anchor
  }

  const parentScope = instanceOf(dom.parentNode)?.scope
  parentScope?.addCleanup(() => {
    Object.keys(cache).forEach(key => {
      const cached = cache[key]
      if (cached?.watchId >= 0) Cancel(cached.watchId)
      disposeBoundaryNode(cached?.dom)
      cached?.dom?.remove?.()
      delete cache[key]
    })
  })

  dom.parentNode.replaceChild(anchor, dom)
  watch(parentScope || instanceOf(anchor.parentNode || dom.parentNode)?.scope, () => {
    let iterations = Run(listExpr, data, runtime)
    const rendered = new Set()
    if (typeof iterations === 'function') iterations = iterations()
    if (typeof iterations === 'number') iterations = Array.from({ length: iterations }, (_, i) => i)
    if (iterations === undefined || iterations === null) iterations = []

    const items = []
    Object.keys(iterations).forEach(key => {
      let cacheKey = ''
      if (iterations[key] && iterations[key][DataID]) {
        cacheKey = iterations[key][DataID]
      } else {
        cacheKey = `${key}.${iterations[key]}`
      }
      cacheKey = `${cacheId}.${cacheKey}`
      rendered.add(cacheKey)
      items.push({ key, cacheKey, value: iterations[key] })
    })

    Object.keys(cache).forEach(key => {
      if (!rendered.has(key)) {
        const cached = cache[key]
        if (cached?.watchId >= 0) Cancel(cached.watchId)
        disposeBoundaryNode(cached?.dom)
        cached?.dom?.remove?.()
        delete cache[key]
      }
    })

    let refNode = anchor
    for (let index = items.length - 1; index >= 0; index--) {
      const { key, cacheKey, value } = items[index]
      const currentRecord = cache[cacheKey]
      if (currentRecord) {
        const currentData = currentRecord.data || metaOf(currentRecord.dom).vforData
        if (currentData) {
          currentData[valueName] = value
          if (keyName) currentData[keyName] = key === '0' ? 0 : (Number(key) || key)
        }
        const currentDom = currentRecord.dom
        if (currentDom && (currentDom.nextSibling !== refNode || !currentDom.isConnected)) {
          anchor.parentNode.insertBefore(currentDom, refNode)
        }
        if (currentDom?.isConnected) refNode = currentDom
        continue
      }
      let tmpData = { [valueName]: value }
      if (keyName) tmpData[keyName] = key === '0' ? 0 : (Number(key) || key)
      tmpData = Wrap(tmpData, data)
      const record = { data: tmpData, dom: null, watchId: -1 }
      cache[cacheKey] = record

      const vif = dom.getAttribute('v-if')
      if (!vif) {
        const newDom = createVforDom(tmpData, refNode)
        metaOf(newDom).vforData = tmpData
        record.dom = newDom
        refNode = newDom
        continue
      }

      record.watchId = watch(parentScope || instanceOf(anchor.parentNode || dom.parentNode)?.scope, () => {
        const cached = cache[cacheKey]
        if (!cached) { Cancel(record.watchId); return }
        return Run(vif, cached.data, runtime)
      }, (res) => {
        const cached = cache[cacheKey]
        if (!cached) { Cancel(record.watchId); return }
        if (res) {
          if (!cached.dom) {
            const newDom = createVforDom(cached.data, findInsertBefore(cacheKey), true)
            metaOf(newDom).vforData = cached.data
            cached.dom = newDom
          }
          if (!cached.dom.isConnected) {
            anchor.parentNode.insertBefore(cached.dom, findInsertBefore(cacheKey))
          }
        } else if (cached.dom) {
          disposeBoundaryNode(cached.dom)
          cached.dom.remove()
          cached.dom = null
        }
      })
    }
  })
}

export function compileVif(nodes, data, runtime, ctx) {
  let ifCache = { now: document.createElement('div'), conds: [], doms: [] }
  const handleIf = (cache) => {
    const ifData = { now: cache.now, conds: cache.conds, doms: cache.doms }
    const ifList = ifData.conds.map(cond => cond === '' ? 'true' : `Boolean(${cond})`)
    const ifExpr = `let res = [${ifList.join(',')}]\n return res.indexOf(true)`
    watch(instanceOf(ifData.now)?.scope, () => {
      const targetIndex = Run(ifExpr, data, runtime)
      let targetDom = ifData.doms[targetIndex]
      if (!targetDom) {
        targetDom = document.createElement('div')
        targetDom.style.display = 'none'
      }
      return targetDom
    }, (targetDom) => {
      if (!targetDom) return
      ctx?.onMountedRun?.(ifData.now, (node) => {
        node.replaceWith(targetDom)
        ifData.now = targetDom
      })
      const targetInst = instanceOf(targetDom, false)
      const targetScope = targetInst?.scope
      const needReparse = !metaOf(targetDom).parsed || targetScope?.state === 'disposed'
      if (needReparse) {
        if (targetScope?.state === 'disposed') {
          disposeRuntimeSubtree(targetDom)
        }
        const sourceNodes = metaOf(targetDom).sourceNodes
        if (sourceNodes?.length) {
          targetDom.innerHTML = ''
          sourceNodes.forEach(child => targetDom.appendChild(child.cloneNode(true)))
        }
        ensureStructuralBoundary(targetDom, data, runtime)
        compileNode(targetDom, data, runtime, ctx, instanceOf(targetDom)?.scope)
      }
    })
  }

  const children = nodes.filter(node => {
    if (!node.getAttribute || node.getAttribute('v-for')) return true
    if (node.getAttribute('v-if') !== null) {
      if (ifCache.conds.length > 0) {
        handleIf(ifCache)
        ifCache = { now: document.createElement('div'), conds: [], doms: [] }
      }
      node.replaceWith(ifCache.now)
      ifCache.conds.push(node.getAttribute('v-if'))
      node.removeAttribute('v-if')
      ifCache.doms.push(node)
      return false
    }
    if (node.getAttribute('v-else-if') !== null) {
      ifCache.conds.push(node.getAttribute('v-else-if'))
      node.removeAttribute('v-else-if')
      ifCache.doms.push(node)
      node.remove()
      return false
    }
    if (node.getAttribute('v-else') !== null) {
      ifCache.conds.push('')
      node.removeAttribute('v-else')
      ifCache.doms.push(node)
      node.remove()
      return false
    }
    return true
  })
  if (ifCache.conds.length > 0) handleIf(ifCache)
  return children
}

// ---- 属性编译 ----

export function compileAHref(dom, data, runtime, ctx) {
  const scope = instanceOf(dom)?.scope
  if (!dom.hasAttribute('href') && !dom.hasAttribute(':href')) return

  const setResolvedHref = (rawHref) => {
    const href = resolveScopedUrl(rawHref, runtime)
    if (href !== undefined) dom.setAttribute('href', href)
  }

  if (dom.hasAttribute(':href')) {
    const code = dom.getAttribute(':href')
    dom.removeAttribute(':href')
    watch(scope, () => {
      const href = Run(code, data, runtime)
      setResolvedHref(href)
    })
  } else {
    setResolvedHref(dom.getAttribute('href'))
  }

  const syncActive = (to) => {
    const url = to?.fullPath
    if (dom.getAttribute('href') === url) dom.setAttribute('active', '')
    else dom.removeAttribute('active')
  }
  const router = instanceOf(dom)?.runtime?.$sys?.$router
  if (!router) return
  syncActive(router?.current)
  const off = router?.onChange?.(syncActive)
  scope?.addCleanup(off)
}

export function compileImgSrc(dom, data, runtime, ctx) {
  const scope = instanceOf(dom)?.scope
  if (!dom.hasAttribute('src') && !dom.hasAttribute(':src')) return

  const setResolvedSrc = (rawSrc) => {
    const src = resolveScopedUrl(rawSrc, runtime)
    if (src !== undefined) dom.setAttribute('src', src)
  }

  if (dom.hasAttribute(':src')) {
    const code = dom.getAttribute(':src')
    dom.removeAttribute(':src')
    watch(scope, () => {
      const src = Run(code, data, runtime)
      setResolvedSrc(src)
    })
  } else {
    setResolvedSrc(dom.getAttribute('src'))
  }
}

export function compileAttr(dom, name, value, data, runtime, ctx) {
  const scope = instanceOf(dom)?.scope
  if (name.startsWith(':')) {
    const attrName = name.slice(1)
    if (attrName === 'class' || attrName === 'style') {
      handleStyle(dom, attrName, value, data, runtime)
    } else {
      watch(scope, () => {
        const res = value ? Run(value, data, runtime) : data[attrName]
        utils.SetAttr(dom, attrName, res)
      })
    }
    return true
  }
  if (name.startsWith('@')) {
    handleEvent(dom, name, value, data, runtime, ctx)
    return true
  }
  if (name.indexOf('!') > -1) {
    console.warn('! prefix is deprecated, use : instead:', name, value, dom)
  } else if (name.startsWith('v:')) {
    const args = ctx?.findLastAccess?.(value, data)
    if (args && args.data && args.key) {
      return utils.BindInputDomValue(
        dom, args.data, args.key,
        (target, callback) => watch(scope, target, callback),
        scope,
      )
    }
    console.warn('not found variables in:' + value)
  } else if (name === 'ref') {
    const refName = value?.trim?.() || ''
    const refPool = ensureRefPool(data)
    if (refName && refPool) {
      refPool[refName] = dom
      scope?.addCleanup(() => {
        if (refPool[refName] === dom) refPool[refName] = null
      })
    }
    return true
  }
  return false
}

export function handleStyle(dom, attrName, value, data, runtime) {
  const scope = instanceOf(dom)?.scope
  let oldValue = ''
  watch(scope, () => {
    let res = Run(value, data, runtime)
    if (typeof res === 'function') res = res()
    if (attrName === 'class') {
      if (oldValue) { dom.classList.remove(...oldValue.split(/\s+/)); oldValue = '' }
      if (res instanceof Array) {
        oldValue = ''
        res.forEach(item => {
          if (typeof item === 'string' && item.length) oldValue += ` ${item}`
          else if (typeof item === 'object' && item) {
            for (const key in item) { if (item[key]) oldValue += ` ${key}` }
          }
        })
      } else if (typeof res === 'string' && res.length) {
        oldValue = res.trim()
      } else if (typeof res === 'object' && res) {
        oldValue = ''
        for (const key in res) { if (res[key]) oldValue += ` ${key}` }
      } else if (res) {
        console.warn('class value error:', res)
      }
      oldValue = oldValue.trim()
      if (oldValue) dom.classList.add(...oldValue.split(/\s+/))
      return
    }
    if (oldValue) {
      if (typeof oldValue === 'object') {
        for (const key in oldValue) {
          if (key.startsWith('--')) dom.style.removeProperty(key)
          else dom.style[key] = ''
        }
      } else if (typeof oldValue === 'string') {
        oldValue.split(';').forEach(segment => {
          const parts = segment.split(':')
          if (parts.length !== 2) return
          const styleKey = parts[0].trim()
          if (styleKey.startsWith('--')) dom.style.removeProperty(styleKey)
          else dom.style[styleKey] = ''
        })
      }
    }
    if (typeof res === 'object' && res) {
      for (const key in res) {
        if (key.startsWith('--')) dom.style.setProperty(key, res[key])
        else dom.style[key] = res[key]
      }
    } else if (typeof res === 'string') {
      res.split(';').forEach(segment => {
        const parts = segment.split(':')
        if (parts.length !== 2) return
        const styleKey = parts[0].trim()
        const styleValue = parts[1].trim()
        if (styleKey.startsWith('--')) dom.style.setProperty(styleKey, styleValue)
        else dom.style[styleKey] = styleValue
      })
    }
    oldValue = res
  })
}

export function handleEvent(dom, name, value, data, runtime, ctx) {
  const scope = instanceOf(dom)?.scope
  const actionName = name.slice(1).split('.')
  const evtMap = { self: false, prevent: false, stop: false }
  const evt = actionName[0]

  if (evt === 'mounted') {
    ctx?.onMountedRun?.(dom, (node) => {
      runMountedHandler(node, data, runtime, value)
    }, false)
    return
  }
  if (evt === 'outerclick') {
    const func = (event) => {
      const cb = Run(value, data, runtime, { $event: event })
      if (typeof cb === 'function') cb(event)
    }
    const cleanup = utils.AddClicker(dom, 'outer', func)
    scope?.addCleanup(cleanup)
    return
  }
  if (utils.EventsList.indexOf(evt) === -1) {
    const inst = instanceOf(dom, false)
    if (inst) {
      if (!inst.events) inst.events = {}
      inst.events[evt] = (...args) => {
        const cb = Run(value, data, runtime, {})
        if (typeof cb === 'function') cb(...args)
      }
    }
    return
  }
  if ((evt === 'keydown' || evt === 'keyup' || evt === 'keypress') && dom.tagName !== 'INPUT' && dom.tagName !== 'TEXTAREA') {
    dom.setAttribute('tabindex', '0')
  }
  let func = (event) => {
    const cb = Run(value, data, runtime, { $event: event })
    if (typeof cb === 'function') cb(event)
  }
  let delayedTimer = null
  actionName.slice(1).forEach(modifier => {
    if (modifier.startsWith('delay')) {
      let delay = modifier.slice(5)
      if (!delay) delay = 1000
      else if (delay.endsWith('ms')) delay = Number(delay.slice(0, -2))
      else if (delay.endsWith('s')) delay = Number(delay.slice(0, -1)) * 1000
      else delay = Number(delay)
      if (isNaN(delay)) delay = 1000
      func = (event) => {
        if (typeof delayedTimer === 'number') {
          scope?.clearTimeout(delayedTimer) || clearTimeout(delayedTimer)
        }
        delayedTimer = scope?.setTimeout(() => {
          const cb = Run(value, data, runtime, { $event: event })
          if (typeof cb === 'function') cb(event)
        }, delay) || setTimeout(() => {
          const cb = Run(value, data, runtime, { $event: event })
          if (typeof cb === 'function') cb(event)
        }, delay)
      }
    }
    evtMap[modifier] = true
  })
  const listener = (event) => {
    if (actionName.length > 1 && (evt === 'keydown' || evt === 'keyup' || evt === 'keypress')) {
      const keyName = actionName[1]
      if (keyName !== event.key?.toLowerCase()) return
    }
    if (evtMap.self && event.currentTarget !== event.target) return
    if (evtMap.prevent) event.preventDefault()
    if (evtMap.stop) event.stopPropagation()
    func(event)
  }
  if (scope?.addEventListener) {
    scope.addEventListener(dom, evt, listener)
  } else {
    dom.addEventListener(evt, listener)
  }
}

export function compileAttrs(dom, data, runtime, ctx, customAttrs) {
  if (dom.nodeName === 'A') compileAHref(dom, data, runtime, ctx)
  else if (dom.nodeName === 'IMG') compileImgSrc(dom, data, runtime, ctx)

  Array.from(dom.attributes).forEach(attr => {
    if (compileAttr(dom, attr.name, attr.value, data, runtime, ctx)) {
      dom.removeAttribute(attr.name)
    }
  })

  if (customAttrs) {
    const inst = instanceOf(dom, false)
    const d = inst?.data
    Object.keys(customAttrs).forEach(key => {
      compileAttr(dom, key, customAttrs[key], d, runtime, ctx)
    })
  }

  if (dom.hasAttribute('v-show')) {
    const code = dom.getAttribute('v-show')
    const oldDisplay = dom.style.display
    const scope = instanceOf(dom)?.scope
    watch(scope, () => {
      const res = Run(code, data, runtime)
      dom.style.display = res ? oldDisplay : 'none'
    })
  }
}

// ---- 根编译入口 ----

export function compileNode(dom, scopedData = {}, runtime, ctx, scope) {
  if (runtime instanceof HTMLElement) {
    throw new Error('runtime error')
  }
  const inst = instanceOf(dom)
  const nodeScopeData = getNodeScope(dom)
  const runtimeScope = scope || inst?.scope || nodeScopeData?.scope
  const activeRuntime = nodeScopeData?.runtime || inst?.runtime || runtime

  const nodeName = dom.nodeName.toLowerCase()

  if (dom.nodeType === 3) {
    compileTextNode(dom, scopedData, activeRuntime, runtimeScope)
    return
  } else if (dom.nodeType === 8) {
    dom.remove()
    return
  } else if (dom.nodeType !== 1) {
    console.log('Other Node Type:', dom.nodeType, dom)
    return
  }

  if (dom.hasAttribute('no-vhtml') || metaOf(dom).parsed) return

  if (!metaOf(dom).sourceNodes) {
    metaOf(dom).sourceNodes = Array.from(dom.childNodes).map(node => node.cloneNode(true))
  }

  let vfortxt = dom.getAttribute('v-for')
  if (vfortxt !== null) {
    compileVfor(vfortxt, dom, scopedData, activeRuntime, ctx)
    return
  }

  if (nodeName.indexOf('-') !== -1) {
    let url = '/' + nodeName.split('-').join('/')
    let singleMode = dom.hasAttribute('single')
    ctx?.parseRef?.(url, dom, scopedData, activeRuntime, null, singleMode)
    metaOf(dom).parsed = true
    return
  }

  if (dom.getAttribute(':vsrc')) {
    let code = dom.getAttribute(':vsrc')
    dom.removeAttribute(':vsrc')
    let attrs = Array.from(dom.attributes).map(a => ({ name: a.name, value: a.value }))
    let oldChilds = Array.from(dom.childNodes)
    watch(runtimeScope, () => {
      metaOf(dom).parsed = false
      dom.setAttribute('vparsing', '')
      let vsrc = Run(code, scopedData, activeRuntime)
      if (!vsrc) return
      Array.from(dom.attributes).forEach(a => dom.removeAttribute(a.name))
      dom.innerHTML = ''
      attrs.forEach(a => dom.setAttribute(a.name, a.value))
      oldChilds.forEach(c => dom.appendChild(c.cloneNode(true)))
      ctx?.parseRef?.(vsrc, dom, scopedData, activeRuntime, null, false)
      metaOf(dom).parsed = true
    })
    return
  }

  if (dom.getAttribute('vsrc')) {
    let singleMode = dom.hasAttribute('single')
    ctx?.parseRef?.(dom.getAttribute('vsrc'), dom, scopedData, activeRuntime, null, singleMode)
    metaOf(dom).parsed = true
    return
  }

  if (nodeName === 'div' && dom.getAttribute('v-html')) {
    let vhtmlCode = dom.getAttribute('v-html')
    dom.removeAttribute('v-html')
    dom.innerHTML = ''
    compileAttrs(dom, scopedData, activeRuntime, ctx)
    metaOf(dom).parsed = true
    watch(runtimeScope, () => {
      let innerHTML = Run(vhtmlCode, scopedData, activeRuntime)
      dom.innerHTML = innerHTML
      let childs = compileVif(Array.from(dom.childNodes), scopedData, activeRuntime, ctx)
      for (let n of childs) {
        compileNode(n, scopedData, activeRuntime, ctx, runtimeScope)
      }
    })
    return
  }

  if (nodeName === 'vslot') {
    ctx?.parseSlots?.(dom, scopedData, activeRuntime)
    metaOf(dom).parsed = true
    return
  }

  if (nodeName === 'vrouter') {
    compileAttrs(dom, scopedData, activeRuntime, ctx)
    ctx?.mountRouter?.(dom, activeRuntime)
    return
  }

  compileAttrs(dom, scopedData, activeRuntime, ctx)
  let childs = compileVif(Array.from(dom.childNodes), scopedData, activeRuntime, ctx)
  for (let n of childs) {
    compileNode(n, scopedData, activeRuntime, ctx, runtimeScope)
  }
  metaOf(dom).parsed = true
}
