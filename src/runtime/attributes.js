import vproxy from '../vproxy.js'
import utils from '../utils.js'
import { runMountedHandler } from './lifecycle.js'
import { ensureEvents, getRef, getRouter, getScope } from './dom.js'

function resolveScope(renderer, dom) {
  return renderer.contextOf ? renderer.contextOf(dom).scope : (renderer.scopeOf(dom) || getScope(dom))
}

function resolveRouter(dom, env) {
  let current = dom
  while (current) {
    const router = getRouter(current)
    if (router) {
      return router
    }
    current = current.parentNode || current.host || null
  }
  return env?.$router || null
}

export function parseAttrs(renderer, dom, data, env, attrs) {
  const scope = resolveScope(renderer, dom)
  if (dom.nodeName === 'A') {
    parseAHref(renderer, dom, data, env)
  }
  Array.from(dom.attributes).forEach((attr) => {
    if (parseAttr(renderer, dom, attr.name, attr.value, data, env)) {
      dom.removeAttribute(attr.name)
    }
  })
  if (attrs) {
    Object.keys(attrs).forEach((key) => {
      parseAttr(renderer, dom, key, attrs[key], getRef(dom), env)
    })
  }
  if (dom.hasAttribute('v-show')) {
    const code = dom.getAttribute('v-show')
    const oldDisplay = dom.style.display
    renderer.watch(scope, () => {
      const res = vproxy.Run(code, data, env)
      dom.style.display = res ? oldDisplay : 'none'
    })
  }
}

export function parseAHref(renderer, dom, data, env) {
  const scope = resolveScope(renderer, dom)
  if (!dom.hasAttribute('href') && !dom.hasAttribute(':href')) {
    return
  }
  if (dom.hasAttribute(':href')) {
    const code = dom.getAttribute(':href')
    dom.removeAttribute(':href')
    renderer.watch(scope, () => {
      let href = vproxy.Run(code, data, env)
      if (!href || href.startsWith('#') || href.startsWith('http')) {
        return
      }
      if (href.startsWith('@')) {
        dom.setAttribute('href', href.slice(1))
        return
      }
      if (env?.scoped) {
        href = env.scoped + href
      }
      dom.setAttribute('href', href)
    })
  } else {
    let href = dom.getAttribute('href')
    if (!href || href.startsWith('#') || href.startsWith('http')) {
      return
    }
    if (href.startsWith('@')) {
      dom.setAttribute('href', href.slice(1))
    } else {
      if (env?.scoped) {
        href = env.scoped + href
      }
      dom.setAttribute('href', href)
    }
  }
  const syncActive = (to) => {
    const url = to?.fullPath
    if (dom.getAttribute('href') === url) {
      dom.setAttribute('active', '')
    } else {
      dom.removeAttribute('active')
    }
  }
  const router = resolveRouter(dom, env)
  if (!router) {
    return
  }
  syncActive(router?.current)
  const off = router?.onChange?.(syncActive)
  scope?.addCleanup(off)
}

export function parseAttr(renderer, dom, name, value, data, env) {
  const scope = resolveScope(renderer, dom)
  if (name.startsWith(':')) {
    const attrName = name.slice(1)
    if (attrName === 'class' || attrName === 'style') {
      handleStyle(renderer, dom, attrName, value, data, env)
    } else {
      renderer.watch(scope, () => {
        const res = value ? vproxy.Run(value, data, env) : data[attrName]
        utils.SetAttr(dom, attrName, res)
      })
    }
    return true
  }
  if (name.startsWith('@')) {
    handleEvent(renderer, dom, name, value, data, env)
    return true
  }
  if (name.indexOf('!') > -1) {
    console.warn('! prefix is deprecated, use : instead:', name, value, dom)
  } else if (name.startsWith('v:')) {
    const args = renderer.findLastAccess(value, data)
    if (args && args.data && args.key) {
      return utils.BindInputDomValue(
        dom,
        args.data,
        args.key,
        (target, callback) => renderer.watch(scope, target, callback),
        scope,
      )
    }
    console.warn('not found variables in:' + value)
  } else if (name === 'ref') {
    const binding = renderer.findLastAccess(value, data)
    if (binding && binding.data && binding.key) {
      binding.data[binding.key] = dom
    } else {
      console.warn('not found variables in:' + value)
    }
    return true
  }
  return false
}

export function handleStyle(renderer, dom, attrName, value, data, env) {
  const scope = resolveScope(renderer, dom)
  let oldValue = ''
  renderer.watch(scope, () => {
    let res = vproxy.Run(value, data, env)
    if (typeof res === 'function') {
      res = res()
    }
    if (attrName === 'class') {
      if (oldValue) {
        dom.classList.remove(...oldValue.split(/\s+/))
        oldValue = ''
      }
      if (res instanceof Array) {
        oldValue = ''
        res.forEach((item) => {
          if (typeof item === 'string' && item.length) {
            oldValue += ` ${item}`
          } else if (typeof item === 'object' && item) {
            for (const key in item) {
              if (item[key]) {
                oldValue += ` ${key}`
              }
            }
          }
        })
      } else if (typeof res === 'string' && res.length) {
        oldValue = res.trim()
      } else if (typeof res === 'object' && res) {
        oldValue = ''
        for (const key in res) {
          if (res[key]) {
            oldValue += ` ${key}`
          }
        }
      } else if (res) {
        console.warn('class value error:', res)
      }
      oldValue = oldValue.trim()
      if (oldValue) {
        dom.classList.add(...oldValue.split(/\s+/))
      }
      return
    }
    if (oldValue) {
      if (typeof oldValue === 'object') {
        for (const key in oldValue) {
          if (key.startsWith('--')) {
            dom.style.removeProperty(key)
          } else {
            dom.style[key] = ''
          }
        }
      } else if (typeof oldValue === 'string') {
        oldValue.split(';').forEach((segment) => {
          const parts = segment.split(':')
          if (parts.length !== 2) {
            return
          }
          const styleKey = parts[0].trim()
          if (styleKey.startsWith('--')) {
            dom.style.removeProperty(styleKey)
          } else {
            dom.style[styleKey] = ''
          }
        })
      }
    }
    if (typeof res === 'object' && res) {
      for (const key in res) {
        if (key.startsWith('--')) {
          dom.style.setProperty(key, res[key])
        } else {
          dom.style[key] = res[key]
        }
      }
    } else if (typeof res === 'string') {
      res.split(';').forEach((segment) => {
        const parts = segment.split(':')
        if (parts.length !== 2) {
          return
        }
        const styleKey = parts[0].trim()
        const styleValue = parts[1].trim()
        if (styleKey.startsWith('--')) {
          dom.style.setProperty(styleKey, styleValue)
        } else {
          dom.style[styleKey] = styleValue
        }
      })
    }
    oldValue = res
  })
}

export function handleEvent(renderer, dom, name, value, data, env) {
  const scope = resolveScope(renderer, dom)
  const actionName = name.slice(1).split('.')
  const evtMap = { self: false, prevent: false, stop: false }
  const evt = actionName[0]
  if (evt === 'mounted') {
    renderer.onMountedRun(dom, (node) => {
      runMountedHandler(node, data, env, value)
    }, false)
    return
  }
  if (evt === 'outerclick') {
    const func = (event) => {
      const cb = vproxy.Run(value, data, env, { $event: event })
      if (typeof cb === 'function') {
        cb(event)
      }
    }
    const cleanup = utils.AddClicker(dom, 'outer', func)
    scope?.addCleanup(cleanup)
    return
  }
  if (utils.EventsList.indexOf(evt) === -1) {
    const events = ensureEvents(dom)
    events[evt] = (...args) => {
      const cb = vproxy.Run(value, data, env, {})
      if (typeof cb === 'function') {
        cb(...args)
      }
    }
    return
  }
  if ((evt === 'keydown' || evt === 'keyup' || evt === 'keypress') && dom.tagName !== 'INPUT' && dom.tagName !== 'TEXTAREA') {
    dom.setAttribute('tabindex', '0')
  }
  let func = (event) => {
    const cb = vproxy.Run(value, data, env, { $event: event })
    if (typeof cb === 'function') {
      cb(event)
    }
  }
  let delayedTimer = null
  actionName.slice(1).forEach((modifier) => {
    if (modifier.startsWith('delay')) {
      let delay = modifier.slice(5)
      if (!delay) {
        delay = 1000
      } else if (delay.endsWith('ms')) {
        delay = Number(delay.slice(0, -2))
      } else if (delay.endsWith('s')) {
        delay = Number(delay.slice(0, -1)) * 1000
      } else {
        delay = Number(delay)
      }
      if (isNaN(delay)) {
        delay = 1000
      }
      func = (event) => {
        if (typeof delayedTimer === 'number') {
          scope?.clearTimeout(delayedTimer) || clearTimeout(delayedTimer)
        }
        delayedTimer = scope?.setTimeout(() => {
          const cb = vproxy.Run(value, data, env, { $event: event })
          if (typeof cb === 'function') {
            cb(event)
          }
        }, delay) || setTimeout(() => {
          const cb = vproxy.Run(value, data, env, { $event: event })
          if (typeof cb === 'function') {
            cb(event)
          }
        }, delay)
      }
    }
    evtMap[modifier] = true
  })
  const listener = (event) => {
    if (actionName.length > 1 && (evt === 'keydown' || evt === 'keyup' || evt === 'keypress')) {
      const keyName = actionName[1]
      if (keyName !== event.key?.toLowerCase()) {
        return
      }
    }
    if (evtMap.self && event.currentTarget !== event.target) {
      return
    }
    if (evtMap.prevent) {
      event.preventDefault()
    }
    if (evtMap.stop) {
      event.stopPropagation()
    }
    func(event)
  }
  if (scope?.addEventListener) {
    scope.addEventListener(dom, evt, listener)
  } else {
    dom.addEventListener(evt, listener)
  }
}
