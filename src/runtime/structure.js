import vproxy from '../vproxy.js'
import { createInstance, detachInstance } from './instance.js'
import ComponentScope from './scope.js'
import { clearNodeState, findNearestInstance, findNearestRouter, getEnv, getInstance, getScope, getScoped, getVforData, isParsed, setEnv, setInstance, setRef, setRouter, setScope, setScoped, setVforData } from './dom.js'

const varRegex = /{{|}}/g
const vforRegex = /^(\s*(\w+)\s+in\s+|\((\w+),\s*(\w+)\)\s+in\s+)([\w\?\$\.\[\]\(\)'"]+)$/

function resolveContext(renderer, dom, fallbackEnv = null) {
  return renderer.contextOf ? renderer.contextOf(dom, fallbackEnv) : {
    instance: getInstance(dom) || findNearestInstance(dom, null),
    scope: renderer.scopeOf(dom) || getScope(dom),
    env: getEnv(dom) || fallbackEnv,
  }
}

function ensureStructuralBoundary(dom, data, env) {
  let instance = getInstance(dom)
  if (!instance) {
    instance = createInstance(dom, findNearestInstance(dom.parentNode || null, null), 'boundary')
    setInstance(dom, instance)
  }
  if (!instance.scope) {
    setScope(dom, new ComponentScope(dom))
  }
  if (data !== undefined) {
    setRef(dom, data)
  }
  const runtimeEnv = env || getEnv(dom) || null
  if (runtimeEnv) {
    setEnv(dom, runtimeEnv)
    setScoped(dom, runtimeEnv.$scoped || getScoped(dom) || null)
    setRouter(dom, findNearestRouter(dom, runtimeEnv.$router || null))
  }
  return instance
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

export function parseTextNode(renderer, dom, data, env, scope = renderer.scopeOf(dom)) {
  const runtimeScope = scope || resolveContext(renderer, dom, env).scope
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
        let value = vproxy.Run(expr, data, env)
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

export function parseVfor(renderer, vfortxt, dom, data, env) {
  dom.removeAttribute('v-for')
  const matches = vforRegex.exec(vfortxt)
  if (matches?.length !== 6) {
    console.error('vfor error:', vfortxt)
    return
  }
  const anchor = document.createElement('div')
  anchor.style.display = 'none'
  const cacheId = vproxy.GenUniqueID()
  const cache = Object.create(null)
  const parentScope = resolveContext(renderer, dom.parentNode, env).scope
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
  renderer.watch(parentScope || resolveContext(renderer, anchor.parentNode || dom.parentNode, env).scope, () => {
    const valueName = matches[3] || matches[2]
    const keyName = matches[4]
    let iterations = vproxy.Run(matches[5], data, env)
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
        if (keyName) {
          getVforData(currentDom)[keyName] = key === '0' ? 0 : (Number(key) || key)
        }
        if (currentDom.isConnected) {
          if (currentDom.nextSibling !== refNode) {
            anchor.parentNode.insertBefore(currentDom, refNode)
          }
          refNode = currentDom
        }
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
      ensureStructuralBoundary(newDom, tmpData, env)

      anchor.parentNode.insertBefore(newDom, refNode)
      const vif = dom.getAttribute('v-if')
      if (!vif) {
        renderer.parseDom(newDom, tmpData, env, resolveContext(renderer, newDom, env).scope)
        refNode = newDom
        continue
      }

      newDom.removeAttribute('v-if')
      let watchId = -1
      watchId = renderer.watch(resolveContext(renderer, newDom, env).scope, () => {
        const cachedDom = cache[cacheKey]
        if (!cachedDom) {
          vproxy.Cancel(watchId)
          return
        }
        const res = vproxy.Run(vif, tmpData, env)
        if (res) {
          if (!isParsed(cachedDom)) {
            ensureStructuralBoundary(cachedDom, tmpData, env)
            renderer.parseDom(cachedDom, tmpData, env, resolveContext(renderer, cachedDom, env).scope)
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

export function parseVif(renderer, nodes, data, env) {
  let ifCache = { now: document.createElement('div'), conds: [], doms: [] }
  const handleIf = (cache) => {
    const ifData = { now: cache.now, conds: cache.conds, doms: cache.doms }
    const ifList = ifData.conds.map((cond) => cond === '' ? 'true' : `Boolean(${cond})`)
    const ifExpr = `let res = [${ifList.join(',')}]\n return res.indexOf(true)`
    renderer.watch(resolveContext(renderer, ifData.now, env).scope, () => {
      let targetDom = ifData.doms[vproxy.Run(ifExpr, data, env)]
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
      if (!isParsed(targetDom)) {
        ensureStructuralBoundary(targetDom, data, env)
        renderer.parseDom(targetDom, data, env, resolveContext(renderer, targetDom, env).scope)
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
