/*
 * compiler-attrs.js — 属性、事件和 URL 绑定编译
 */

import { Wrap } from './reactive.js'
import { Run } from './sandbox.js'
import moduleContextManager, { resolveScope } from './module.js'
import utils from './utils.js'
import { runMountedHandler } from './lifecycle.js'
import { isRelativeHref } from './url.js'
import { instanceOf } from './component-instance.js'
import { watch } from './runtime-watch.js'

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
  if (runtime?.$mod?.url_prefix === '') return ''
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
  if (name.startsWith('v:')) {
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

export function resolveComponentUrl(nodeName, runtime) {
  const mod = runtime?.$mod
  const parts = nodeName.split('-')
  const firstSegment = parts[0]
  const aliases = mod?.scoped ? moduleContextManager.getAliases(mod.scoped) : null
  if (aliases?.[firstSegment]) {
    const aliasBase = aliases[firstSegment]
    const rest = parts.slice(1).join('/')
    const path = rest ? `${aliasBase}/${rest}` : aliasBase
    return '@' + path
  }
  return '/' + parts.join('/')
}
