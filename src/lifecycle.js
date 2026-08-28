/*
 * lifecycle.js — 生命周期脚本执行与代际令牌
 */
import { Watch, Cancel } from './reactive.js'
import { AsyncRun, Run } from './sandbox.js'

// ====================================================================
// generation token — 异步挂载统一竞态契约（v0.10.1 阶段 5）
//
// 每个组件 scope 持有一个 token；每次跨越 await 的异步段开始时 issue()
// 领票，异步返回后 alive(ticket) 校验。scope.dispose（唯一销毁口）kill()
// 作废全部在途票，后续 await 返回即走确定性清理路径。
// 与 v0.10.2 导航状态机是同一机制：本模块导出，路由层直接复用，不得另造一版。
// ====================================================================

export function createGenToken() {
  let generation = 0
  let killed = false
  return {
    /** 开启新的异步段：递增代际，旧票全部作废；返回本段票据 */
    issue() {
      generation += 1
      return generation
    },
    /** 校验票据是否仍在当前代际且未整体作废 */
    alive(ticket) {
      return !killed && ticket === generation
    },
    /** 永久作废（scope.dispose 调用；幂等） */
    kill() {
      killed = true
    },
    get killed() {
      return killed
    },
  }
}

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
