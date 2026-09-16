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
