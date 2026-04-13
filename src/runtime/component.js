import vproxy from '../vproxy.js'
import vget from '../vget.js'
import utils from '../utils.js'
import { createInstance, detachInstance } from './instance.js'
import ComponentScope from './scope.js'
import { createRuntimeEnv } from './env.js'
import { parseImports } from './imports.js'
import { registerScriptLifecycle } from './lifecycle.js'
import { createSlotContents } from './slots.js'
import { findNearestInstance, findNearestRouter, getEvents, getInstance, getRuntime, getScope, getSourceNodes, setData, setInstance, setRouter, setRuntime, setScope, setSlotContents, setSourceNodes, setVsrc } from './dom.js'

function resolveRuntime(renderer, dom, fallbackRuntime = null) {
  return renderer.runtimeOf ? renderer.runtimeOf(dom, fallbackRuntime) : {
    instance: getInstance(dom),
    scope: getScope(dom),
    runtime: getRuntime(dom) || fallbackRuntime,
  }
}

export async function parseRaw(renderer, dom, data, runtime, code) {
  const tmpId = `_${Math.random().toString(36).slice(2)}`
  const target = await vget.ParseUI(code, runtime || {}, tmpId)
  renderer.parseRef(tmpId, dom, data || {}, { ...runtime }, target)
}

export async function parseRef(renderer, vsrc, dom, data, runtime, target, singleMode = false) {
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
  const parentRuntime = runtime
  const refOf = dom.getAttribute('vrefof')
  const parentRef = dom.closest(`*[vref='${refOf}']`)
  if (parentRef) {
    runtime = getRuntime(parentRef)
  }
  if (!target && vsrc) {
    if (!vsrc.endsWith('.html')) {
      vsrc = `${vsrc}.html`
    }
    target = await vget.FetchUI(vsrc, runtime, dom.hasAttribute('scoped'))
  }
  const mod = target?.mod || runtime?.$mod || null
  const runtimeRouter = findNearestRouter(dom, runtime?.$sys?.$router || null)
  const componentRuntime = createRuntimeEnv(runtime || null, mod, { $router: runtimeRouter })
  componentRuntime.$sys.$emit = (evt, ...args) => {
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
  setRuntime(dom, componentRuntime)
  setRouter(dom, runtimeRouter)
  setVsrc(dom, vsrc)
  const originData = await setupRef(renderer, dom, data, parentRuntime, target, singleMode)
  if (singleMode) {
    renderer.parseAttrs(dom, originData, componentRuntime, target?.customAttrs)
  } else {
    renderer.parseAttrs(dom, data, parentRuntime, target?.customAttrs)
  }
  const children = renderer.parseVif(Array.from(dom.childNodes), originData, componentRuntime)
  for (const child of children) {
    renderer.parseDom(child, originData, componentRuntime)
  }
  dom.removeAttribute('vparsing')
  mountRef(renderer, dom, originData, componentRuntime, target)
  resolveRuntime(renderer, dom, componentRuntime).scope?.activate(dom)
}

export async function setupRef(renderer, dom, data, parentRuntime, target, singleMode = false) {
  const originData = vproxy.Wrap({
    $refs: vproxy.Wrap({}),
  })
  const componentRuntime = resolveRuntime(renderer, dom, parentRuntime)
  if (target.setup) {
    let script = target.setup.innerHTML
    script = await parseImports(script, originData, componentRuntime.runtime, target.url)
    await vproxy.AsyncRun(script, originData, componentRuntime.runtime, {
      $node: dom,
      $watch: (target, callback, options) => {
        const scope = resolveRuntime(renderer, dom, componentRuntime.runtime).scope
        const register = () => {
          renderer.watch(resolveRuntime(renderer, dom, componentRuntime.runtime).scope, target, callback, options)
        }
        if (scope) {
          scope.setTimeout(register, 50)
        } else {
          setTimeout(register, 50)
        }
      },
    })
  }
  if (!originData.$refs || typeof originData.$refs !== 'object') {
    originData.$refs = vproxy.Wrap({})
  }
  setData(dom, originData)
  if (singleMode) {
    return originData
  }
  if (!getSourceNodes(dom)) {
    setSourceNodes(dom, Array.from(dom.childNodes).map((node) => node.cloneNode(true)))
  }
  const slotContents = createSlotContents(getSourceNodes(dom) || [], data, parentRuntime)
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
        renderer.watch(resolveRuntime(renderer, dom, parentRuntime).scope, () => vproxy.Run(expr, data, parentRuntime), () => {
          originData[key] = vproxy.Run(expr, data, parentRuntime)
        }, { deep: true })
      } else {
        renderer.watch(resolveRuntime(renderer, dom, parentRuntime).scope, () => data[key], () => {
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
      renderer.watch(resolveRuntime(renderer, dom, parentRuntime).scope, () => args.data[args.key], () => {
        originData[key] = args.data[args.key]
      })
      renderer.watch(resolveRuntime(renderer, dom, parentRuntime).scope, () => originData[key], () => {
        args.data[args.key] = originData[key]
      })
    }
  })

  let attrs = Array.from(bodyClone.attributes)
  attrs = attrs.filter((attr) => {
    if (renderer.parseAttr(dom, attr.name, attr.value, originData, resolveRuntime(renderer, dom, parentRuntime).runtime)) {
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

export function mountRef(renderer, dom, componentData, runtime, target) {
  if (!resolveRuntime(renderer, dom, runtime).scope) {
    setScope(dom, new ComponentScope(dom))
  }
  for (const script of target.scripts) {
    registerScriptLifecycle(script, dom, componentData, runtime)
  }
}
