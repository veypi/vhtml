import vproxy from '../vproxy.js'
import { findNearestRouter, getEnv, getInstance, getRef, getScope } from './dom.js'

function createScriptContext(dom, data, env) {
  const instance = getInstance(dom)
  return {
    $node: dom,
    $watch: (target, callback, options) => {
      const scope = instance?.scope || getScope(dom)
      const id = vproxy.Watch(target, callback, options)
      scope?.addWatcher(() => vproxy.Cancel(id))
      return id
    },
    $scope: instance?.scope || getScope(dom),
    $router: findNearestRouter(dom, env?.$router || null),
  }
}

export function runScript(code, dom, data, env) {
  const instance = getInstance(dom)
  const runtimeData = instance?.data || getRef(dom) || data || {}
  const runtimeEnv = instance?.env || getEnv(dom) || env || {}
  runtimeEnv.$router = findNearestRouter(dom, runtimeEnv.$router || null)
  return vproxy.AsyncRun(code, runtimeData, runtimeEnv, createScriptContext(dom, runtimeData, runtimeEnv))
    .catch((error) => {
      console.error('Lifecycle script error', {
        vsrc: dom?.getAttribute?.('vsrc') || '',
        vref: dom?.getAttribute?.('vref') || '',
        scoped: runtimeEnv?.scoped || '',
        dataKeys: Object.keys(runtimeData || {}),
        code: code.trim().slice(0, 400),
        message: error?.message || String(error),
        stack: error?.stack || '',
      })
      throw error
    })
}

export function registerScriptLifecycle(scriptNode, dom, data, env) {
  const code = scriptNode.innerHTML
  const instance = getInstance(dom)
  const scope = instance?.scope || getScope(dom)
  if (scriptNode.hasAttribute('active')) {
    scope?.onActive(() => {
      runScript(code, dom, data, getEnv(dom) || env)
    })
    return
  }
  if (scriptNode.hasAttribute('deactive')) {
    scope?.onDeactive(() => {
      runScript(code, dom, data, getEnv(dom) || env)
    })
    return
  }
  if (scriptNode.hasAttribute('dispose')) {
    scope?.onDispose(() => {
      runScript(code, dom, data, getEnv(dom) || env)
    })
    return
  }
  runScript(code, dom, data, getEnv(dom) || env || {})
}

export function runMountedHandler(dom, data, env, expression) {
  let callback = vproxy.Run(expression, data, env)
  if (typeof callback === 'function') {
    callback(dom)
  }
}
