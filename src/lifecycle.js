/*
 * lifecycle.js — 生命周期脚本执行
 */
import { Watch, Cancel } from './reactive.js'
import { AsyncRun, Run } from './sandbox.js'

function createScriptContext(dom, inst) {
  return {
    $node: dom,
    $watch: (target, callback, options) => {
      const scope = inst?.scope
      const id = Watch(target, callback, options)
      scope?.addWatcher(() => Cancel(id))
      return id
    },
    $scope: inst?.scope,
    $router: inst?.runtime?.$sys?.$router || null,
  }
}

export function runScript(code, dom, inst, data, runtime, sandboxOptions = {}) {
  const runtimeData = inst?.data || data || {}
  const activeRuntime = inst?.runtime || runtime || {}
  if (activeRuntime.$sys) {
    activeRuntime.$sys.$router = inst?.runtime?.$sys?.$router || null
  }
  const options = inst?.unsafe ? { unsafe: true } : sandboxOptions
  return AsyncRun(code, runtimeData, activeRuntime, createScriptContext(dom, inst), options)
    .catch((error) => {
      if (inst) inst._scriptError = { code: code.trim().slice(0, 200), message: error?.message || String(error) }
      console.error('Lifecycle script error', {
        vsrc: dom?.getAttribute?.('vsrc') || '',
        vref: dom?.getAttribute?.('vref') || '',
        scoped: activeRuntime?.$mod?.scoped || '',
        dataKeys: Object.keys(runtimeData || {}),
        code: code.trim().slice(0, 400),
        message: error?.message || String(error),
        stack: error?.stack || '',
      })
    })
}

export function registerScriptLifecycle(scriptNode, dom, inst, data, runtime, sandboxOptions = {}) {
  const code = scriptNode.innerHTML
  const scope = inst?.scope
  const run = () => runScript(code, dom, inst, data, inst?.runtime || runtime, sandboxOptions)
  if (scriptNode.hasAttribute('active')) {
    scope?.onActive(run)
    return
  }
  if (scriptNode.hasAttribute('deactive')) {
    scope?.onDeactive(run)
    return
  }
  if (scriptNode.hasAttribute('dispose')) {
    scope?.onDispose(run)
    return
  }
  run()
}

export function runMountedHandler(dom, data, runtime, expression) {
  let callback = Run(expression, data, runtime)
  if (typeof callback === 'function') callback(dom)
}
