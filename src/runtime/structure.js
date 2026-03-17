import vproxy from '../vproxy.js'
import { createInstance, detachInstance } from './instance.js'
import ComponentScope from './scope.js'
import { clearNodeState, findNearestInstance, findNearestRouter, getInstance, getRuntime, getScope, getSourceNodes, getVforData, isParsed, setData, setInstance, setRouter, setRuntime, setScope, setVforData } from './dom.js'

const varRegex = /{{|}}/g
const vforRegex = /^\s*(?:\((\w+)\s*,\s*(\w+)\)|(\w+))\s+in\s+(.+?)\s*$/

function resolveRuntime(renderer, dom, fallbackRuntime = null) {
  return renderer.runtimeOf ? renderer.runtimeOf(dom, fallbackRuntime) : {
    instance: getInstance(dom) || findNearestInstance(dom, null),
    scope: renderer.scopeOf(dom) || getScope(dom),
    runtime: getRuntime(dom) || fallbackRuntime,
  }
}

function ensureStructuralBoundary(dom, data, runtime) {
  let instance = getInstance(dom)
  if (!instance) {
    instance = createInstance(dom, findNearestInstance(dom.parentNode || null, null), 'boundary')
    setInstance(dom, instance)
  }
  if (!instance.scope) {
    setScope(dom, new ComponentScope(dom))
  }
  if (data !== undefined) {
    setData(dom, data)
  }
  const nodeRuntime = runtime || getRuntime(dom) || null
  if (nodeRuntime) {
    setRuntime(dom, nodeRuntime)
    setRouter(dom, findNearestRouter(dom, nodeRuntime.$sys?.$router || null))
  }
  return instance
}

export function ensureRuntimeBoundary(dom, data, runtime) {
  return ensureStructuralBoundary(dom, data, runtime)
}

function disposeBoundaryNode(node) {
  if (!node || node.nodeType !== 1) {
    return
  }
  const scope = getScope(node)
  scope?.dispose(node)
  detachInstance(getInstance(node))
  clearNodeState(node)
}

export function parseTextNode(renderer, dom, data, runtime, scope = renderer.scopeOf(dom)) {
  const runtimeScope = scope || resolveRuntime(renderer, dom, runtime).scope
  const txt = dom.nodeValue.trim()
  if (!txt) {
    return
  }
  let match
  let nextStart = 0
  let start = -1
  const parts = []
  while ((match = varRegex.exec(txt)) !== null) {
    if (match[0] === '{{') {
      start = match.index
    } else if (match[0] === '}}' && start >= 0) {
      if (nextStart !== start) {
        parts.push(txt.slice(nextStart, start))
      }
      parts.push('')
      const expr = txt.slice(start + 2, match.index)
      const partIndex = parts.length - 1
      start = -1
      nextStart = match.index + 2
      renderer.watch(runtimeScope, () => {
        let value = vproxy.Run(expr, data, runtime)
        if (typeof value === 'function') {
          value = value()
        } else if (typeof value === 'object' && value) {
          value = JSON.stringify(value)
        }
        parts[partIndex] = value
        dom.nodeValue = parts.join('').trim()
      })
    }
  }
  parts.push(txt.slice(nextStart))
  dom.nodeValue = parts.join('')
}

export function parseVfor(renderer, vfortxt, dom, data, runtime) {
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
  const cacheId = vproxy.GenUniqueID()
  const cache = Object.create(null)
  const parentScope = resolveRuntime(renderer, dom.parentNode, runtime).scope
  parentScope?.addCleanup(() => {
    Object.keys(cache).forEach((key) => {
      const cached = cache[key]
      if (cached instanceof Array) {
        cached.forEach((node) => node.remove())
      } else {
        cached?.remove?.()
      }
      delete cache[key]
    })
  })
  dom.parentNode.replaceChild(anchor, dom)
  renderer.watch(parentScope || resolveRuntime(renderer, anchor.parentNode || dom.parentNode, runtime).scope, () => {
    let iterations = vproxy.Run(listExpr, data, runtime)
    const rendered = new Set()

    if (typeof iterations === 'function') {
      iterations = iterations()
    }
    if (typeof iterations === 'number') {
      iterations = Array.from({ length: iterations }, (_, i) => i)
    }
    if (iterations === undefined || iterations === null) {
      iterations = []
    }
    let _ = iterations.length
    if (typeof iterations !== 'object') {
      console.error('vfor iter object error:', [matches, iterations, vfortxt, data])
      return _
    }

    const items = []
    Object.keys(iterations).forEach((key) => {
      let cacheKey = ''
      if (iterations[key] && iterations[key][vproxy.DataID]) {
        cacheKey = iterations[key][vproxy.DataID]
      } else {
        cacheKey = `${key}.${iterations[key]}`
      }
      cacheKey = `${cacheId}.${cacheKey}`
      rendered.add(cacheKey)
      items.push({ key, cacheKey, value: iterations[key] })
    })

    Object.keys(cache).forEach((key) => {
      if (!rendered.has(key)) {
        if (cache[key] instanceof Array) {
          cache[key].forEach((node) => {
            disposeBoundaryNode(node)
            node.remove()
          })
        } else {
          disposeBoundaryNode(cache[key])
          cache[key].remove()
        }
        delete cache[key]
      }
    })

    let refNode = anchor
    for (let index = items.length - 1; index >= 0; index--) {
      const { key, cacheKey, value } = items[index]
      const currentDom = cache[cacheKey]
      if (currentDom) {
        const currentData = getVforData(currentDom)
        if (currentData) {
          currentData[valueName] = value
        }
        if (keyName) {
          currentData[keyName] = key === '0' ? 0 : (Number(key) || key)
        }
        if (currentDom.nextSibling !== refNode || !currentDom.isConnected) {
          anchor.parentNode.insertBefore(currentDom, refNode)
        }
        refNode = currentDom
        continue
      }

      const newDom = dom.cloneNode(true)
      cache[cacheKey] = newDom
      let tmpData = { [valueName]: value }
      if (keyName) {
        tmpData[keyName] = key === '0' ? 0 : (Number(key) || key)
      }
      tmpData = vproxy.Wrap(tmpData, data)
      setVforData(newDom, tmpData)
      ensureStructuralBoundary(newDom, tmpData, runtime)

      anchor.parentNode.insertBefore(newDom, refNode)
      const vif = dom.getAttribute('v-if')
      if (!vif) {
        renderer.parseDom(newDom, tmpData, runtime, resolveRuntime(renderer, newDom, runtime).scope)
        refNode = newDom
        continue
      }

      newDom.removeAttribute('v-if')
      let watchId = -1
      watchId = renderer.watch(resolveRuntime(renderer, newDom, runtime).scope, () => {
        const cachedDom = cache[cacheKey]
        if (!cachedDom) {
          vproxy.Cancel(watchId)
          return
        }
        const res = vproxy.Run(vif, tmpData, runtime)
        if (res) {
          if (!isParsed(cachedDom)) {
            ensureStructuralBoundary(cachedDom, tmpData, runtime)
            renderer.parseDom(cachedDom, tmpData, runtime, resolveRuntime(renderer, cachedDom, runtime).scope)
          }
          if (!cachedDom.isConnected) {
            let found = false
            let before = anchor
            for (const tmpKey in cache) {
              if (tmpKey === cacheKey) {
                found = true
                continue
              }
              if (found && cache[tmpKey].isConnected) {
                before = cache[tmpKey]
                break
              }
            }
            anchor.parentNode.insertBefore(cachedDom, before)
          }
        } else if (cachedDom.isConnected) {
          cachedDom.remove()
        } else {
          renderer.onMountedRun(cachedDom, () => {
            cachedDom.remove()
          })
        }
      })

      if (newDom.isConnected) {
        refNode = newDom
      }
    }
    return _
  })
}

export function parseVif(renderer, nodes, data, runtime) {
  let ifCache = { now: document.createElement('div'), conds: [], doms: [] }
  const handleIf = (cache) => {
    const ifData = { now: cache.now, conds: cache.conds, doms: cache.doms }
    const ifList = ifData.conds.map((cond) => cond === '' ? 'true' : `Boolean(${cond})`)
    const ifExpr = `let res = [${ifList.join(',')}]\n return res.indexOf(true)`
    renderer.watch(resolveRuntime(renderer, ifData.now, runtime).scope, () => {
      const targetIndex = vproxy.Run(ifExpr, data, runtime)
      let targetDom = ifData.doms[targetIndex]
      if (!targetDom) {
        targetDom = document.createElement('div')
        targetDom.style.display = 'none'
      }
      return targetDom
    }, (targetDom) => {
      if (!targetDom) {
        return
      }
      renderer.onMountedRun(ifData.now, (node) => {
        node.replaceWith(targetDom)
        ifData.now = targetDom
      })
      const targetScope = getScope(targetDom)
      const needReparse = !isParsed(targetDom) || targetScope?.state === 'disposed'
      if (needReparse) {
        if (targetScope?.state === 'disposed') {
          disposeRuntimeSubtree(targetDom)
        }
        const sourceNodes = getSourceNodes(targetDom)
        if (sourceNodes?.length) {
          targetDom.innerHTML = ''
          sourceNodes.forEach((child) => {
            targetDom.appendChild(child.cloneNode(true))
          })
        }
        ensureStructuralBoundary(targetDom, data, runtime)
        renderer.parseDom(targetDom, data, runtime, resolveRuntime(renderer, targetDom, runtime).scope)
      }
    })
  }

  const children = nodes.filter((node) => {
    if (!node.getAttribute || node.getAttribute('v-for')) {
      return true
    }
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
  if (ifCache.conds.length > 0) {
    handleIf(ifCache)
  }
  return children
}
