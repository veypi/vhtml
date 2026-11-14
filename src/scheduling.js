/*
 * scheduling.js — 长任务分片（INP）
 *
 * 组件挂载/编译是同步大块工作；parseRef 本身 async，子组件挂载不逐 await，
 * 于是在编译前检查共享 deadline：距上次让出已超过 50ms（长任务边界）就
 * yield 一次，让浏览器处理输入与绘制，再继续下一批组件。
 * 不改变单组件内部编译的同步语义，也不影响 flushSync 契约。
 */

const LONG_TASK_BUDGET = 50
let deadline = 0

export async function yieldIfNeeded(now = performance.now()) {
  if (now < deadline) return false
  if (
    typeof scheduler !== 'undefined' &&
    typeof scheduler.yield === 'function'
  ) {
    await scheduler.yield()
  } else {
    // Safari 等无 Scheduler API 的回退
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  deadline = performance.now() + LONG_TASK_BUDGET
  return true
}

/** 测试用：重置共享 deadline。 */
export function resetScheduleDeadline() {
  deadline = 0
}
