import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadSrc, mount, flush } from './harness.js'

await loadSrc()
const { ensureStructuralBoundary } = await import('../src/compiler.js')
const { disposeNode, instanceOf } = await import('../src/component-instance.js')
const perf = window.__vhtml_dev.perfStats

test('ten thousand removals use one scheduled drain, not one frame callback per node', async () => {
  const { app, host } = await mount('', {})
  const request = globalThis.requestAnimationFrame
  const callbacks = []
  globalThis.requestAnimationFrame = cb => { callbacks.push(cb); return 0 }
  try {
    const before = { ...perf }
    const frag = document.createDocumentFragment()
    for (let i = 0; i < 10000; i++) frag.appendChild(document.createElement('i'))
    host.append(frag)
    host.replaceChildren()
    await flush(20)
    assert.equal(callbacks.length, 1)
    assert.equal(perf.disposalSchedules - before.disposalSchedules, 1)
    assert.equal(perf.disposalPending - before.disposalPending, 10000)
    callbacks[0]()
    callbacks[0]() // 模拟已取消的竞争通道仍投递，代次守卫必须挡住。
    assert.equal(perf.disposalFlushes - before.disposalFlushes, 1)
    assert.equal(perf.disposalPending, before.disposalPending)
  } finally {
    globalThis.requestAnimationFrame = request
    app.destroy(); host.remove()
  }
})

test('ancestor/descendant candidates deduplicate and uncompiled wrappers still dispose children', async () => {
  const { app, host } = await mount('', {})
  const wrapper = document.createElement('section')
  const child = document.createElement('p')
  wrapper.append(child); host.append(wrapper)
  const inst = ensureStructuralBoundary(child, {}, app._runtime)
  let disposed = 0
  inst.scope.onDispose(() => disposed++)
  wrapper.remove()
  const roots = perf.disposalRoots
  app._scheduleDisposeNodeScope(wrapper)
  app._scheduleDisposeNodeScope(child)
  await flush()
  assert.equal(disposed, 1)
  assert.equal(perf.disposalRoots - roots, 1)
  assert.equal(instanceOf(child, false), null)
  app.destroy(); host.remove()
})

test('same-frame reinsertion and keepOnDetach descendants remain live', async () => {
  const { app, host } = await mount('<div><p>{{n}}</p></div>', { n: 1 })
  const wrapper = host.firstElementChild
  const inst = ensureStructuralBoundary(wrapper.firstElementChild, app._data, app._runtime)
  wrapper.remove(); host.append(wrapper)
  await flush()
  assert.notEqual(inst.scope.phase, 'disposed')
  inst.keepOnDetach = true
  wrapper.remove()
  await flush()
  assert.notEqual(inst.scope.phase, 'disposed')
  assert.equal(instanceOf(inst.host, false), inst)
  disposeNode(inst.host) // 显式销毁不受软断开标记影响。
  assert.equal(inst.scope.phase, 'disposed')
  app.destroy(); host.remove()
})

test('timer fallback drains when frame delivery stops; destroy cancels pending references', async () => {
  const { app, host } = await mount('', {})
  const request = globalThis.requestAnimationFrame
  globalThis.requestAnimationFrame = () => 0
  try {
    const child = document.createElement('p')
    host.append(child)
    const scope = ensureStructuralBoundary(child, {}, app._runtime).scope
    child.remove()
    await flush(150)
    assert.equal(scope.phase, 'disposed')
    const another = document.createElement('p')
    host.append(another)
    const nextScope = ensureStructuralBoundary(another, {}, app._runtime).scope
    another.remove()
    app.destroy() // takeRecords 必须接住尚未交付的 MO 移除。
    assert.equal(nextScope.phase, 'disposed')
    assert.equal(app._moPendingRemoved.size, 0)
    assert.equal(app._disposeTask, null)
  } finally {
    globalThis.requestAnimationFrame = request
    app.destroy(); host.remove()
  }
})
