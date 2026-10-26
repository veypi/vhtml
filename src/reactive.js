/* Browser scheduling and diagnostics for the shared reactive kernel. */
import { createReactiveCore } from './reactive-core.js'
import { errorLog } from './errors.js'
import { compileStats } from './compile-stats.js'
import { perfStats } from './perf-stats.js'
import { foreignValue } from './execution/foreign.js'

const core = createReactiveCore({
  foreign: foreignValue,
  perfStats,
  now: () => typeof performance !== 'undefined' ? performance.now() : Date.now(),
  schedule(callback) {
    let pending = true
    const run = () => { if (pending) { pending = false; callback() } }
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run)
    else setTimeout(run, 16)
    if (typeof document !== 'undefined' && document.hidden) setTimeout(run, 16)
  },
})

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && core.stats.dirty) core.flush()
  })
}

export const { batch, Watch, Cancel, GenUniqueID, DataID, IsWrapped, EnsureWrap, SetDataRoot, Wrap, mergeIntoProxy, defineProperty } = core
export const trackExternal = core.external

// 同步冲刷本实例的待更新（含模板 v-for / 绑定的 DOM patch）：给「同一任务内就要读到
// 新 DOM」的调用方（如虚拟列表：改行集 → 立刻测量）。默认 rAF 批量调度不变。
// 重入安全：watcher 内调用直接返回（见 reactive-core.js 的 flushing 保护）。
export const flushSync = core.flush

if (typeof window !== 'undefined' && !window.__vhtml_dev) {
  window.__vhtml_dev = {
    get stats() { return core.stats },
    compileStats,
    perfStats,
    cascadeErrors: core.cascadeErrors,
    get errors() { return errorLog },
  }
}
