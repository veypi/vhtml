/*
 * compiler.js — DOM 编译器
 * Copyright (C) 2024 veypi <i@veypi.com>
 *
 * 合并原 attributes.js + structure.js。
 * 所有属性从 ComponentInstance 直接访问，不设 wrapper 函数。
 */

import { Wrap, Watch, Cancel, DataID } from './reactive.js'
import { Run } from './sandbox.js'
import { resolveScope } from './env.js'
import utils from './utils.js'
import { runMountedHandler } from './lifecycle.js'
import { isRelativeHref } from './url.js'
import {
  instanceOf, setInstance, metaOf,
  createInstance,
  disposeRuntimeSubtree,
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

const URL_ATTRS = new Set(['href', 'src', 'srcset', 'poster', 'data', 'action', 'formaction'])

function normalizePath(path, minDepth = 0) {
  const segments = path.split('/').filter(s => s !== '')
  const result = []
  for (const seg of segments) {
    if (seg === '.') continue
    if (seg === '..') {
      if (result.length > minDepth) result.pop()
    } else {
      result.push(seg)
    }
  }
  return '/' + result.join('/')
}

function anchorPrefix(runtime) {
  return runtime?.$mod?.url_prefix || resolveScope(runtime)
}

function resolveScopedUrl(rawUrl, runtime, scoped) {
  if (!rawUrl || rawUrl.startsWith('#')) return rawUrl
  if (rawUrl.startsWith('@')) return rawUrl.slice(1)
  scoped = scoped || runtime?.$mod?.scoped
  if (scoped && isRelativeHref(rawUrl)) {
    const minDepth = scoped.split('/').filter(s => s).length
    return normalizePath(scoped + rawUrl, minDepth)
  }
  return rawUrl
}

function resolveSrcset(srcset, runtime) {
  if (!srcset || typeof srcset !== 'string') return srcset
  return srcset.split(',').map(entry => {
    const trimmed = entry.trim()
    const parts = trimmed.split(/\s+/)
    if (parts.length > 0 && isRelativeHref(parts[0])) {
      parts[0] = resolveScopedUrl(parts[0], runtime)
    }
    return parts.join(' ')
  }).join(', ')
}

// ---- 结构型编译 ----

const varRegex = /{{|}}/g
const vforRegex = /^\s*(?:\((\w+)\s*,\s*(\w+)\)|(\w+))\s+in\s+(.+?)\s*$/

/** 从普通元素或 <template> 中提取内容子节点 */
function getSourceNodes(dom) {
  if (dom.nodeName === 'TEMPLATE') {
    const source = dom.content || dom
    return Array.from(source.childNodes).map(n => n.cloneNode(true))
  }
  return [dom.cloneNode(true)]
}

/** 将一组节点按顺序插入到 refNode 之前（用 fragment 保持顺序） */
function insertBefore(nodes, refNode) {
  const frag = document.createDocumentFragment()
  nodes.forEach(n => frag.appendChild(n))
  refNode.parentNode.insertBefore(frag, refNode)
}

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

function clearVforRange(startMark, endMark) {
  let n = startMark.nextSibling
  while (n && n !== endMark) {
    const next = n.nextSibling
    if (n.nodeType === 1) disposeRuntimeSubtree(n)
    n.remove()
    n = next
  }
}

function removeVforItem(entry) {
  if (!entry) return
  let n = entry.startMark.nextSibling
  while (n && n !== entry.endMark) {
    const next = n.nextSibling
    if (n.nodeType === 1) disposeRuntimeSubtree(n)
    n.remove()
    n = next
  }
  entry.startMark.remove()
  entry.endMark.remove()
}

function moveItemBefore(itemStart, itemEnd, refNode) {
  if (itemEnd.nextSibling === refNode) return
  const nodes = [itemStart]
  let n = itemStart.nextSibling
  while (n && n !== itemEnd) {
    nodes.push(n)
    n = n.nextSibling
  }
  nodes.push(itemEnd)
  insertBefore(nodes, refNode)
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

  const sourceNodes = getSourceNodes(dom)

  const vforStart = document.createComment('~vfor')
  const vforEnd = document.createComment('~/vfor')
  dom.replaceWith(vforStart, vforEnd)

  const cache = Object.create(null)
  const parentScope = instanceOf(vforStart.parentNode)?.scope

  parentScope?.addCleanup(() => {
    Object.keys(cache).forEach(key => {
      removeVforItem(cache[key])
      delete cache[key]
    })
    clearVforRange(vforStart, vforEnd)
  })

  watch(parentScope, () => {
    let items = Run(listExpr, data, runtime)
    if (typeof items === 'function') items = items()
    if (typeof items === 'number') items = Array.from({ length: items }, (_, i) => i)
    if (!items) items = []

    const keep = new Set()
    const order = []

    Object.keys(items).forEach(key => {
      const value = items[key]
      const ck = value?.[DataID] || `${key}.${value}`
      keep.add(ck)
      order.push({ key, value, ck })
    })

    // 移除过期条目
    Object.keys(cache).forEach(key => {
      if (!keep.has(key)) {
        removeVforItem(cache[key])
        delete cache[key]
      }
    })

    // 创建新条目 & 更新已有条目
    order.forEach(({ key, value, ck }) => {
      let entry = cache[ck]
      if (!entry) {
        const itemStart = document.createComment('~vitem')
        const itemEnd = document.createComment('~/vitem')
        insertBefore([itemStart, itemEnd], vforEnd)

        const clones = sourceNodes.map(n => n.cloneNode(true))
        const itemData = Wrap({ [valueName]: value }, data)
        if (keyName) itemData[keyName] = key === '0' ? 0 : (Number(key) || key)

        // 将 clone 插入 item 范围，再处理 v-if/v-else 链
        insertBefore(clones, itemEnd)
        const remaining = compileVif(clones, itemData, runtime, ctx)
        remaining.forEach(n => {
          if (n.nodeType === 1) {
            metaOf(n).vforData = itemData
            ensureStructuralBoundary(n, itemData, runtime)
            compileNode(n, itemData, runtime, ctx)
          } else if (n.nodeType === 3) {
            compileTextNode(n, itemData, runtime, parentScope)
          }
        })

        entry = { startMark: itemStart, endMark: itemEnd, data: itemData }
        cache[ck] = entry
        return
      }

      // 更新已有条目的数据
      if (entry.data) {
        entry.data[valueName] = value
        if (keyName) entry.data[keyName] = key === '0' ? 0 : (Number(key) || key)
      }

      // 将整个 item 范围移到 vforEnd 之前
      moveItemBefore(entry.startMark, entry.endMark, vforEnd)
    })
  })
}

export function compileVif(nodes, data, runtime, ctx) {
  const result = []
  let chain = null // { conds, sourceBranches, startMark, endMark }

  function flushChain() {
    if (!chain || chain.conds.length === 0) return
    const { conds, sourceBranches, startMark, endMark } = chain

    const ifExpr = `[${conds.map(c => c === '' ? 'true' : `Boolean(${c})`).join(',')}].indexOf(true)`
    let activeIndex = -1

    function clearContent() {
      let n = startMark.nextSibling
      while (n && n !== endMark) {
        const next = n.nextSibling
        if (n.nodeType === 1) disposeRuntimeSubtree(n)
        n.remove()
        n = next
      }
    }

    function showBranch(index) {
      if (index < 0 || index >= sourceBranches.length) {
        const empty = document.createElement('div')
        empty.style.display = 'none'
        endMark.before(empty)
        return
      }
      const clones = sourceBranches[index].map(n => n.cloneNode(true))
      insertBefore(clones, endMark)
      const remaining = compileVif(clones, data, runtime, ctx)
      remaining.forEach(n => {
        if (n.nodeType === 1) {
          ensureStructuralBoundary(n, data, runtime)
          compileNode(n, data, runtime, ctx)
        } else if (n.nodeType === 3) {
          compileTextNode(n, data, runtime, instanceOf(startMark.parentNode)?.scope)
        }
      })
    }

    const parentScope = instanceOf(startMark.parentNode)?.scope
    watch(parentScope, () => Run(ifExpr, data, runtime), (targetIndex) => {
      if (targetIndex === activeIndex) return
      clearContent()
      showBranch(targetIndex)
      activeIndex = targetIndex
    })

    chain = null
  }

  for (const node of nodes) {
    // 注释节点放行（包括我们的标记注释 ~vif, ~/vif）
    if (node.nodeType !== 1) { result.push(node); continue }

    // v-for 节点不参与 v-if 链
    if (node.getAttribute('v-for')) { flushChain(); result.push(node); continue }

    const vif = node.getAttribute('v-if')
    if (vif !== null) {
      flushChain()

      const startMark = document.createComment('~vif')
      const endMark = document.createComment('~/vif')
      node.replaceWith(startMark, endMark)

      node.removeAttribute('v-if')
      const source = getSourceNodes(node)

      chain = {
        conds: [vif],
        sourceBranches: [source],
        startMark,
        endMark,
      }
      node.remove()
      continue
    }

    if (chain) {
      const velseif = node.getAttribute('v-else-if')
      if (velseif !== null) {
        chain.conds.push(velseif)
        node.removeAttribute('v-else-if')
        chain.sourceBranches.push(getSourceNodes(node))
        node.remove()
        continue
      }

      if (node.getAttribute('v-else') !== null) {
        chain.conds.push('')
        node.removeAttribute('v-else')
        chain.sourceBranches.push(getSourceNodes(node))
        node.remove()
        continue
      }
    }

    flushChain()
    result.push(node)
  }

  flushChain()
  return result
}

// ---- 属性编译 ----

function syncAnchorActive(dom) {
  const scope = instanceOf(dom)?.scope
  const router = instanceOf(dom)?.runtime?.$sys?.$router
  if (!router) return
  const syncActive = (to) => {
    const url = to?.fullPath
    if (dom.getAttribute('href') === url) dom.setAttribute('active', '')
    else dom.removeAttribute('active')
  }
  syncActive(router.current)
  const off = router.onChange?.(syncActive)
  scope?.addCleanup(off)
}

export function compileAttr(dom, name, value, data, runtime, ctx, dynamicUrlAttrs) {
  const scope = instanceOf(dom)?.scope
  if (name.startsWith(':')) {
    const attrName = name.slice(1)
    if (attrName === 'class' || attrName === 'style') {
      handleStyle(dom, attrName, value, data, runtime)
    } else {
      if (URL_ATTRS.has(attrName)) {
        dynamicUrlAttrs?.add(attrName)
      }
      watch(scope, () => {
        let res = value ? Run(value, data, runtime) : data[attrName]
        if (URL_ATTRS.has(attrName) && res) {
          if (attrName === 'srcset') {
            res = resolveSrcset(res, runtime)
          } else {
            const prefix = attrName === 'href' && dom.nodeName === 'A' ? anchorPrefix(runtime) : undefined
            res = resolveScopedUrl(res, runtime, prefix)
          }
        }
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
  const dynamicUrlAttrs = new Set()

  Array.from(dom.attributes).forEach(attr => {
    if (compileAttr(dom, attr.name, attr.value, data, runtime, ctx, dynamicUrlAttrs)) {
      dom.removeAttribute(attr.name)
    }
  })

  Array.from(dom.attributes).forEach(attr => {
    if (URL_ATTRS.has(attr.name) && !dynamicUrlAttrs.has(attr.name)) {
      let resolved
      if (attr.name === 'srcset') {
        resolved = resolveSrcset(attr.value, runtime)
      } else {
        const prefix = attr.name === 'href' && dom.nodeName === 'A' ? anchorPrefix(runtime) : undefined
        resolved = resolveScopedUrl(attr.value, runtime, prefix)
      }
      dom.setAttribute(attr.name, resolved)
    }
  })

  if (dom.nodeName === 'A') syncAnchorActive(dom)

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

  // <template> 元素：v-for 走多根编译，否则解包暴露子节点
  if (nodeName === 'template') {
    const vfortxt = dom.getAttribute('v-for')
    if (vfortxt !== null) {
      dom.removeAttribute('v-for')
      compileVfor(vfortxt, dom, scopedData, activeRuntime, ctx)
      metaOf(dom).parsed = true
      return
    }
    const src = dom.content || dom
    const childs = compileVif(Array.from(src.childNodes), scopedData, activeRuntime, ctx)
    dom.replaceWith(...childs)
    childs.forEach(c => compileNode(c, scopedData, activeRuntime, ctx, runtimeScope))
    return
  }

  if (!metaOf(dom).sourceNodes) {
    metaOf(dom).sourceNodes = Array.from(dom.childNodes).map(node => node.cloneNode(true))
    metaOf(dom).sourceAttrs = Array.from(dom.attributes)
      .filter(a => !['v-if', 'v-else-if', 'v-else'].includes(a.name))
      .map(a => ({ name: a.name, value: a.value }))
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

  // <select> 需要先编译子元素（option），再编译属性（v:value），
  // 否则 v:value 初始同步时 v-for 生成的 option 尚不存在，无法匹配选中项
  if (nodeName === 'select') {
    const childs = compileVif(Array.from(dom.childNodes), scopedData, activeRuntime, ctx)
    for (const n of childs) {
      compileNode(n, scopedData, activeRuntime, ctx, runtimeScope)
    }
    compileAttrs(dom, scopedData, activeRuntime, ctx)
    metaOf(dom).parsed = true
    return
  }

  compileAttrs(dom, scopedData, activeRuntime, ctx)
  const childs = compileVif(Array.from(dom.childNodes), scopedData, activeRuntime, ctx)
  for (const n of childs) {
    compileNode(n, scopedData, activeRuntime, ctx, runtimeScope)
  }
  metaOf(dom).parsed = true
}
