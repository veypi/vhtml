/*
 * runtime-watch.js — scope 绑定的响应式监听
 */

import { Watch, Cancel } from './reactive.js'

export function watch(scope, target, callback, options) {
  if (scope?.phase === 'disposed') return null
  const id = Watch(target, callback, options)
  if (scope && !id.dead) {
    const cleanup = () => Cancel(id)
    // 分支单独拆除时同时移除 scope 中的取消入口，常驻父组件不积累空 handle。
    id.onCancel = () => scope.removeCleanup(cleanup)
    scope.addWatcher(cleanup)
  }
  return id
}

/**
 * 公开 $watch 包装：返回幂等的取消订阅函数（契约：unsubscribe）。
 *
 * 内部 watch() 必须继续返回 watcher handle——编译器 teardown 依赖 handle 走
 * Cancel(handle)。只有暴露给组件脚本的 $watch 才对外承诺取消函数。
 * setup 期间走 scope 队列：先取消则注册阶段直接跳过，不会留下孤儿 watcher。
 */
export function publicWatch(scope, target, callback, options) {
  let handle = null
  let cancelled = false
  const register = () => {
    if (cancelled) return null
    if (scope?.phase === 'disposed') return null
    handle = watch(scope, target, callback, options)
    return handle
  }
  if (scope) scope.queueWatch(register)
  else register()
  return () => {
    cancelled = true
    if (handle) {
      Cancel(handle)
      handle = null
    }
  }
}
