/*
 * lifecycle.js — 生命周期脚本执行
 */
import { Watch, Cancel } from './reactive.js'
import { AsyncRun, Run } from './sandbox.js'

function createScriptContext(dom, inst, reason) {
  return {
    $node: dom,
    // 生命周期触发原因：'mount' | 'route' | 'visibility' | 'dispose'，
    // 仅 active/deactive 脚本有意义，其余脚本为 undefined
    $reason: reason,
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

export function runScript(code, dom, inst, data, runtime, sandboxOptions = {}, reason) {
  const runtimeData = inst?.data || data || {}
  const activeRuntime = inst?.runtime || runtime || {}
  if (activeRuntime.$sys) {
    activeRuntime.$sys.$router = inst?.runtime?.$sys?.$router || null
  }
  const options = inst?.unsafe ? { unsafe: true } : sandboxOptions
  return AsyncRun(code, runtimeData, activeRuntime, createScriptContext(dom, inst, reason), options)
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
  // scriptNode 为解析期扁平化的纯数据记录：{ code, setup, active, deactive, dispose }
  const code = scriptNode.code
  const scope = inst?.scope
  const run = (host, reason) => runScript(code, dom, inst, data, inst?.runtime || runtime, sandboxOptions, reason)
  if (scriptNode.active) {
    scope?.onActive(run)
    return
  }
  if (scriptNode.deactive) {
    scope?.onDeactive(run)
    return
  }
  if (scriptNode.dispose) {
    scope?.onDispose(run)
    return
  }
  run()
}

export function runMountedHandler(dom, data, runtime, expression) {
  let callback = Run(expression, data, runtime)
  if (typeof callback === 'function') callback(dom)
}
