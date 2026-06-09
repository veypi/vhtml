/*
 * compiler.js — DOM 编译器
 * Copyright (C) 2024 veypi <i@veypi.com>
 *
 * 结构指令和根节点分发。属性/事件编译在 compiler-attrs.js。
 */

import { Wrap, DataID, EnsureWrap } from './reactive.js'
import { Run } from './sandbox.js'
import { compileAttrs, resolveComponentUrl } from './compiler-attrs.js'
import { ComponentScope } from './component-scope.js'
import { watch } from './runtime-watch.js'
import {
  instanceOf, setInstance, metaOf,
  createInstance,
  disposeRuntimeSubtree,
  getNodeScope,
} from './component-instance.js'

export { compileAttr, compileAttrs } from './compiler-attrs.js'

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
    data = EnsureWrap(data)
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

// ---- 根编译入口 ----

export function compileNode(dom, scopedData = {}, runtime, ctx, scope) {
  if (runtime instanceof HTMLElement) {
    throw new Error('runtime error')
  }
  scopedData = EnsureWrap(scopedData)
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
    let url = resolveComponentUrl(nodeName, activeRuntime)
    let singleMode = dom.hasAttribute('single')
    ctx?.parseRef?.(url, dom, scopedData, activeRuntime, null, singleMode)
    metaOf(dom).parsed = true
    return
  }

  if (dom.getAttribute(':vsrc')) {
    if (activeRuntime?.__unsafe) {
      console.warn('unsafe mode: :vsrc is blocked')
      dom.removeAttribute(':vsrc')
    } else {
      let code = dom.getAttribute(':vsrc')
      dom.removeAttribute(':vsrc')
      let attrs = Array.from(dom.attributes).map(a => ({ name: a.name, value: a.value }))
      let oldChilds = Array.from(dom.childNodes)
      let currentVsrc = null
      watch(runtimeScope, () => {
        metaOf(dom).parsed = false
        dom.setAttribute('vparsing', '')
        let vsrc = Run(code, scopedData, activeRuntime)
        if (!vsrc) {
          dom.removeAttribute('vparsing')
          return
        }
        if (vsrc === currentVsrc) {
          metaOf(dom).parsed = true
          dom.removeAttribute('vparsing')
          return
        }
        currentVsrc = vsrc
        Array.from(dom.attributes).forEach(a => dom.removeAttribute(a.name))
        Array.from(dom.children).forEach(child => disposeRuntimeSubtree(child))
        dom.innerHTML = ''
        attrs.forEach(a => dom.setAttribute(a.name, a.value))
        oldChilds.forEach(c => dom.appendChild(c.cloneNode(true)))
        ctx?.parseRef?.(vsrc, dom, scopedData, activeRuntime, null, false)
        metaOf(dom).parsed = true
      })
    }
    return
  }

  if (dom.getAttribute('vsrc')) {
    if (activeRuntime?.__unsafe) {
      console.warn('unsafe mode: vsrc is blocked')
      dom.removeAttribute('vsrc')
    } else {
      let singleMode = dom.hasAttribute('single')
      ctx?.parseRef?.(dom.getAttribute('vsrc'), dom, scopedData, activeRuntime, null, singleMode)
      metaOf(dom).parsed = true
    }
    return
  }

  if (nodeName === 'div' && dom.getAttribute('v-html')) {
    let vhtmlCode = dom.getAttribute('v-html')
    dom.removeAttribute('v-html')
    dom.innerHTML = ''
    compileAttrs(dom, scopedData, activeRuntime, ctx)
    metaOf(dom).parsed = true
    let oldHTML = null
    watch(runtimeScope, () => {
      let innerHTML = Run(vhtmlCode, scopedData, activeRuntime)
      if (innerHTML === oldHTML) return
      oldHTML = innerHTML
      Array.from(dom.children).forEach(child => disposeRuntimeSubtree(child))
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
