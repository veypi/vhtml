// 独立进程运行：node --expose-gc scripts/check-reactive-gc.mjs
import assert from 'node:assert/strict'
import { setupDom } from '../test/harness.js'
setupDom()
const { Wrap, Watch, Cancel, SetDataRoot } = await import('../src/reactive.js')
const { ComponentScope } = await import('../src/component-scope.js')
const { perfStats } = await import('../src/perf-stats.js')

assert.equal(typeof global.gc, 'function', 'run with --expose-gc')
const shared = Wrap({ n: 0 })
const handles = [] // 故意保留取消后的 handle，模拟外部持有取消令牌。
const refs = []
const retainedRaw = [], retainedCallbacks = [], retainedScopes = []
globalThis.window = {
  setTimeout: fn => retainedCallbacks.push(fn), clearTimeout() {},
  setInterval: fn => retainedCallbacks.push(fn), clearInterval() {},
  requestAnimationFrame: fn => retainedCallbacks.push(fn), cancelAnimationFrame() {},
}
function identityGarbage() {
  const raw = { value: 1 }; raw.self = raw
  const proxy = Wrap(raw)
  const h = Watch(() => proxy.self.value, () => {})
  Cancel(h); handles.push(h)
  refs.push(new WeakRef(raw), new WeakRef(proxy))
  for (const legacy of [false, true]) {
    const local = {}, root = Wrap({ payload: new Uint8Array(1024 * 1024) })
    retainedRaw.push(local)
    const scopeData = legacy ? Wrap(local) : Wrap(local, root)
    if (legacy) SetDataRoot(scopeData, root)
    // 数据仍存活，不应经 canonical 缓存留下已经释放的 root 包装。
    Wrap(local)
    refs.push(new WeakRef(scopeData), new WeakRef(root))
  }
  const payload = { bytes: new Uint8Array(1024 * 1024) }
  const scope = new ComponentScope()
  scope.setTimeout(() => payload.bytes.byteLength, 10000)
  scope.setInterval(() => payload.bytes.byteLength, 10000)
  scope.requestAnimationFrame(() => payload.bytes.byteLength)
  scope.dispose(); retainedScopes.push(scope)
  refs.push(new WeakRef(payload))
}
for (let i = 0; i < 20; i++) identityGarbage()
for (let i = 0; i < 20; i++) {
  const payload = { bytes: new Uint8Array(1024 * 1024) }
  refs.push(new WeakRef(payload))
  const h = Watch(() => { shared.n; return payload }, () => payload.bytes.byteLength)
  Cancel(h)
  handles.push(h)
}
for (let i = 0; i < 10; i++) {
  await new Promise(resolve => setTimeout(resolve, 10))
  global.gc()
}
assert.equal(refs.filter(ref => ref.deref()).length, 0, 'canceled effects must release payload without notifying dependencies')
assert.equal(shared.n, 0)
assert.equal(handles.length, 40)
assert.equal(retainedRaw.length, 40)
assert.equal(retainedScopes.length, 20)
retainedCallbacks.forEach(callback => callback())
assert.deepEqual([perfStats.pendingFrames, perfStats.pendingTimeouts, perfStats.pendingIntervals], [0, 0, 0])
console.log(`PASS: ${refs.length} weak targets collected; canceled handles, raw locals, disposed scopes and host callbacks retained`)
