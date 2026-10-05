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

if (typeof window !== 'undefined' && !window.__vhtml_dev) {
  window.__vhtml_dev = {
    get stats() { return core.stats },
    compileStats,
    perfStats,
    cascadeErrors: core.cascadeErrors,
    get errors() { return errorLog },
  }
}
