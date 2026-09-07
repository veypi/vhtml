/*
 * lifecycle.js — 生命周期脚本执行与代际令牌
 */
import { Watch, Cancel } from './reactive.js'
import { AsyncRun, setCompileContext } from './sandbox.js'

// ====================================================================
// generation token — 异步挂载统一竞态契约（v0.10.1 阶段 5）
//
// 每个组件 scope 持有一个 token；每次跨越 await 的异步段开始时 issue()
// 领票，异步返回后 alive(ticket) 校验。scope.dispose（唯一销毁口）kill()
// 作废全部在途票，后续 await 返回即走确定性清理路径。
// 嵌套组合契约：异步段的子段（如 parseRef → setupRef）必须复用父段票据，
// 不得另行 issue——子段 issue 会作废父段在途票据，父段 await 返回后的
// 校验波误判中止（同一票据下子 await 期间的 kill 同样使父段失败，不降级）。
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
      // 与 setup $watch 同一队列机制（v0.10.3）：队列模式入队、
      // 非队列模式立即执行并返回 watch 句柄（生命周期脚本运行时队列已排空）
      const scope = inst?.scope
      const register = () => {
        const id = Watch(target, callback, options)
        scope?.addWatcher(() => Cancel(id))
        return id
      }
      return scope ? scope.queueWatch(register) : register()
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
  // 编译上下文仅覆盖本脚本的编译阶段（compileCode 在 AsyncRun 入口同步完成）
  const restoreCompileCtx = setCompileContext({
    tag: dom?.tagName?.toLowerCase() || '',
    vref: dom?.getAttribute?.('vref') || '',
    vsrc: dom?.getAttribute?.('vsrc') || '',
  })
  const pending = AsyncRun(code, runtimeData, activeRuntime, createScriptContext(dom, inst, reason), options)
  restoreCompileCtx()
  return pending
    .catch((error) => {
      // 运行期错误已由 sandbox executeAsyncFn 登记 + 报错；此处只接住编译错误（唯一 reject 来源）
      const message = error?.message || String(error)
      if (inst) inst._error = { kind: 'compile', message, code: code.trim().slice(0, 200) }
      console.error('Lifecycle script error', {
        vsrc: dom?.getAttribute?.('vsrc') || '',
        vref: dom?.getAttribute?.('vref') || '',
        scoped: activeRuntime?.$mod?.scoped || '',
        message,
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
  // plain script = mounted 迁移钩子（v0.11）：入挂载队列，tryMount 资格满足时
  // 执行（宿主已接入文档）；无 scope 的退化路径立即执行
  if (scope) scope.onMount(run)
  else run()
}
