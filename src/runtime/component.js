import vproxy from '../vproxy.js'
import vget from '../vget.js'
import utils from '../utils.js'
import { createInstance, detachInstance } from './instance.js'
import ComponentScope from './scope.js'
import { createRuntimeEnv } from './env.js'
import { parseImports } from './imports.js'
import { registerScriptLifecycle } from './lifecycle.js'
import { createSlotContents } from './slots.js'
import { findNearestInstance, findNearestRouter, getEnv, getEvents, getInstance, getScope, getSourceNodes, getVsrc, setEnv, setInstance, setRef, setRouter, setScope, setScoped, setSlotContents, setSourceNodes, setVsrc } from './dom.js'

function resolveContext(renderer, dom, fallbackEnv = null) {
  return renderer.contextOf ? renderer.contextOf(dom, fallbackEnv) : {
    instance: getInstance(dom),
    scope: getScope(dom),
    env: getEnv(dom) || fallbackEnv,
  }
}

export async function parseRaw(renderer, dom, data, env, code) {
  const tmpId = `_${Math.random().toString(36).slice(2)}`
  const target = await vget.ParseUI(code, env || {}, tmpId)
  renderer.parseRef(tmpId, dom, data || {}, { ...env }, target)
}

export async function parseRef(renderer, vsrc, dom, data, env, target, singleMode = false) {
  const previousInstance = getInstance(dom)
  const parentInstance = findNearestInstance(dom.parentNode || null, null)
  const currentScope = getScope(dom)
  if (currentScope) {
    currentScope.dispose(dom)
  }
  if (previousInstance) {
    detachInstance(previousInstance)
  }
  const instance = createInstance(dom, parentInstance, 'component')
  setInstance(dom, instance)
  setScope(dom, new ComponentScope(dom))
  dom.setAttribute('vparsing', '')
  const parentEnv = env
  const refOf = dom.getAttribute('vrefof')
  const parentRef = dom.closest(`*[vref='${refOf}']`)
  if (parentRef) {
    env = getEnv(parentRef)
  }
  if (!target && vsrc) {
    if (!vsrc.endsWith('.html')) {
      vsrc = `${vsrc}.html`
    }
    target = await vget.FetchUI(vsrc, env, dom.hasAttribute('scoped'))
  }
  const scopedContext = target?.env || env?.$scoped || null
  const runtimeRouter = findNearestRouter(dom, env?.$router || null)
  const runtimeEnv = createRuntimeEnv(env || null, scopedContext, { $router: runtimeRouter })
  runtimeEnv.$emit = (evt, ...args) => {
    evt = evt.toLowerCase()
    const events = getEvents(dom)
    if (!events) {
      return
    }
    const callback = events[evt]
    if (typeof callback === 'function') {
      callback(...args)
    }
  }
  setEnv(dom, runtimeEnv)
  setScoped(dom, scopedContext)
  setRouter(dom, runtimeRouter)
  setVsrc(dom, vsrc)
  const originData = await setupRef(renderer, dom, data, parentEnv, target, singleMode)
  if (singleMode) {
    renderer.parseAttrs(dom, originData, runtimeEnv, target?.customAttrs)
  } else {
    renderer.parseAttrs(dom, data, parentEnv, target?.customAttrs)
  }
  const children = renderer.parseVif(Array.from(dom.childNodes), originData, runtimeEnv)
  for (const child of children) {
    renderer.parseDom(child, originData, runtimeEnv)
  }
  dom.removeAttribute('vparsing')
  mountRef(renderer, dom, originData, runtimeEnv, target)
  resolveContext(renderer, dom, runtimeEnv).scope?.activate(dom)
}

export async function setupRef(renderer, dom, data, parentEnv, target, singleMode = false) {
  const originData = vproxy.Wrap({})
  const componentContext = resolveContext(renderer, dom, parentEnv)
  if (target.setup) {
    let script = target.setup.innerHTML
    script = await parseImports(script, originData, componentContext.env, getVsrc(dom))
    await vproxy.AsyncRun(script, originData, componentContext.env, {
      $node: dom,
      $watch: (target, callback, options) => {
        const scope = resolveContext(renderer, dom, componentContext.env).scope
        const register = () => {
          renderer.watch(resolveContext(renderer, dom, componentContext.env).scope, target, callback, options)
        }
        if (scope) {
          scope.setTimeout(register, 50)
        } else {
          setTimeout(register, 50)
        }
      },
    })
  }
  setRef(dom, originData)
  if (singleMode) {
    return originData
  }
  if (!getSourceNodes(dom)) {
    setSourceNodes(dom, Array.from(dom.childNodes).map((node) => node.cloneNode(true)))
  }
  const slotContents = createSlotContents(getSourceNodes(dom) || [], data, parentEnv)
  setSlotContents(dom, slotContents)
  dom.innerHTML = ''
  const bodyClone = target.body.cloneNode(true)
  dom.append(...bodyClone.childNodes)

  Object.keys(originData).forEach((key) => {
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
        renderer.watch(resolveContext(renderer, dom, parentEnv).scope, () => vproxy.Run(expr, data, parentEnv), () => {
          originData[key] = vproxy.Run(expr, data, parentEnv)
        }, { deep: true })
      } else {
        renderer.watch(resolveContext(renderer, dom, parentEnv).scope, () => data[key], () => {
          originData[key] = data[key]
        }, { deep: true })
      }
    }

    if (dom.hasAttribute(`v:${key}`) || dom.hasAttribute(`v:${localKey}`)) {
      let expr = dom.getAttribute(`v:${key}`) || dom.getAttribute(`v:${localKey}`)
      dom.removeAttribute(`v:${key}`)
      dom.removeAttribute(`v:${localKey}`)
      if (!expr) {
        expr = key
      }
      const args = renderer.findLastAccess(expr, data)
      if (!args || !args.key || args.data === undefined) {
        console.warn(`not find bind variables: ${expr}`)
        return
      }
      if (args.data[args.key] !== undefined && args.data[args.key] !== null) {
        delete originData[key]
      }
      renderer.watch(resolveContext(renderer, dom, parentEnv).scope, () => args.data[args.key], () => {
        originData[key] = args.data[args.key]
      })
      renderer.watch(resolveContext(renderer, dom, parentEnv).scope, () => originData[key], () => {
        args.data[args.key] = originData[key]
      })
    }
  })

  let attrs = Array.from(bodyClone.attributes)
  attrs = attrs.filter((attr) => {
    if (renderer.parseAttr(dom, attr.name, attr.value, originData, resolveContext(renderer, dom, parentEnv).env)) {
      bodyClone.removeAttribute(attr.name)
      return false
    }
    return true
  })
  attrs.forEach((attr) => {
    if (attr.name === 'class') {
      dom.classList.add(...attr.value.trim().split(/\s+/))
    } else if (attr.name === 'style') {
      attr.value.split(';').forEach((stylePart) => {
        const segments = stylePart.split(':')
        if (segments.length !== 2 || dom.style[segments[0]]) {
          return
        }
        const styleKey = segments[0].trim()
        const styleValue = segments[1].trim()
        if (styleKey.startsWith('--')) {
          dom.style.setProperty(styleKey, styleValue)
        } else {
          dom.style[styleKey] = styleValue
        }
      })
    } else if (!dom.getAttribute(attr.name)) {
      dom.setAttribute(attr.name, attr.value)
    }
  })
  return originData
}

export function mountRef(renderer, dom, scopedData, env, target) {
  if (!resolveContext(renderer, dom, env).scope) {
    setScope(dom, new ComponentScope(dom))
  }
  for (const script of target.scripts) {
    registerScriptLifecycle(script, dom, scopedData, env)
  }
}
