import vproxy from '../vproxy.js'
import { findNearestRouter, getData, getInstance, getRuntime, getScope } from './dom.js'

function createScriptContext(dom, data, runtime) {
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
    $router: findNearestRouter(dom, runtime?.$sys?.$router || null),
  }
}

export function runScript(code, dom, data, runtime) {
  const instance = getInstance(dom)
  const runtimeData = instance?.data || getData(dom) || data || {}
  const activeRuntime = instance?.runtime || getRuntime(dom) || runtime || {}
  if (activeRuntime.$sys) {
    activeRuntime.$sys.$router = findNearestRouter(dom, activeRuntime.$sys.$router || null)
  }
  return vproxy.AsyncRun(code, runtimeData, activeRuntime, createScriptContext(dom, runtimeData, activeRuntime))
    .catch((error) => {
      console.error('Lifecycle script error', {
        vsrc: dom?.getAttribute?.('vsrc') || '',
        vref: dom?.getAttribute?.('vref') || '',
        scoped: activeRuntime?.$mod?.scoped || '',
        dataKeys: Object.keys(runtimeData || {}),
        code: code.trim().slice(0, 400),
        message: error?.message || String(error),
        stack: error?.stack || '',
      })
      throw error
    })
}

export function registerScriptLifecycle(scriptNode, dom, data, runtime) {
  const code = scriptNode.innerHTML
  const instance = getInstance(dom)
  const scope = instance?.scope || getScope(dom)
  if (scriptNode.hasAttribute('active')) {
    scope?.onActive(() => {
      runScript(code, dom, data, getRuntime(dom) || runtime)
    })
    return
  }
  if (scriptNode.hasAttribute('deactive')) {
    scope?.onDeactive(() => {
      runScript(code, dom, data, getRuntime(dom) || runtime)
    })
    return
  }
  if (scriptNode.hasAttribute('dispose')) {
    scope?.onDispose(() => {
      runScript(code, dom, data, getRuntime(dom) || runtime)
    })
    return
  }
  runScript(code, dom, data, getRuntime(dom) || runtime || {})
}

export function runMountedHandler(dom, data, runtime, expression) {
  let callback = vproxy.Run(expression, data, runtime)
  if (typeof callback === 'function') {
    callback(dom)
  }
}
