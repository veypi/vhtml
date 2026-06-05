/*
 * runtime-watch.js — scope 绑定的响应式监听
 */

import { Watch, Cancel } from './reactive.js'

export function watch(scope, target, callback, options) {
  const id = Watch(target, callback, options)
  scope?.addWatcher(() => Cancel(id))
  return id
}
