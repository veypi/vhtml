import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadSrc, flush, mount } from './harness.js'

await loadSrc()
const { Wrap, Watch, Cancel } = await import('../src/reactive.js')
const { ComponentScope } = await import('../src/component-scope.js')
const { watch } = await import('../src/runtime-watch.js')
const { instanceOf } = await import('../src/component-instance.js')
const stats = () => window.__vhtml_dev.stats

test('watch target and callback retain their unbound receiver semantics', () => {
  const h = Watch(function () { assert.equal(this, undefined); return 1 }, function () { assert.equal(this, undefined) })
  Cancel(h)
})

test('conditional effects detach stale dependencies after reevaluation', async () => {
  const baseline = stats().dependencyEdges
  const p = Wrap({ flag: true, a: 1, b: 2 })
  let runs = 0
  const h = Watch(() => { runs++; return p.flag ? p.a : p.b })
  assert.equal(stats().dependencyEdges - baseline, 2)
  p.flag = false
  await flush()
  p.a++
  await flush()
  assert.equal(runs, 2)
  p.b++
  await flush()
  assert.equal(runs, 3)
  Cancel(h)
  Cancel(h)
  assert.equal(stats().dependencyEdges, baseline)
  assert.equal(h.fn, null)
  assert.equal(h.lastValue, null)
})

test('cancel removes dirty work immediately, including another effect in the same flush', async () => {
  const p = Wrap({ n: 0 })
  let second, calls = 0
  const first = Watch(() => p.n, n => { if (n) Cancel(second) })
  second = Watch(() => p.n, () => calls++)
  p.n++
  await flush()
  assert.equal(calls, 1)
  p.n++
  Cancel(first)
  assert.equal(stats().dirty, 0)
  await flush()
})

test('self cancellation during evaluation or callback cannot restore dependencies or values', async () => {
  const baseline = stats().dependencyEdges
  const p = Wrap({ n: 0, later: 1 })
  let targetHandle, callbackHandle
  targetHandle = Watch(() => {
    if (p.n) Cancel(targetHandle)
    return { value: p.later }
  })
  callbackHandle = Watch(() => p.n, n => { if (n) Cancel(callbackHandle) })
  p.n++
  await flush()
  assert.equal(stats().dependencyEdges, baseline)
  for (const h of [targetHandle, callbackHandle]) {
    assert.equal(h.dead, true)
    assert.equal(h.lastValue, null)
    assert.equal(h.deps.size, 0)
  }
})

test('nested effects collect separately; callbacks never subscribe the outer effect', async () => {
  const p = Wrap({ a: 0, b: 0, incidental: 0 })
  let outerRuns = 0, innerRuns = 0, inner
  const outer = Watch(() => {
    outerRuns++
    if (!inner) inner = Watch(() => { innerRuns++; return p.b }, () => p.incidental)
    return p.a
  })
  p.incidental++
  await flush()
  assert.equal(outerRuns, 1)
  assert.equal(innerRuns, 1)
  p.b++
  await flush()
  assert.equal(outerRuns, 1)
  assert.equal(innerRuns, 2)
  Cancel(outer); Cancel(inner)
})

test('throwing evaluation still prunes old dependencies; failed registration is cleaned up', async () => {
  const baseline = stats().dependencyEdges
  const p = Wrap({ broken: false, a: 1 })
  let runs = 0
  const h = Watch(() => { runs++; if (p.broken) throw Error('expected'); return p.a })
  const warn = console.warn
  try { console.warn = () => {}; p.broken = true; await flush() } finally { console.warn = warn }
  p.a++
  await flush()
  assert.equal(runs, 2)
  Cancel(h)
  assert.throws(() => Watch(() => p.a, () => { throw Error('callback failed') }), /callback failed/)
  assert.equal(stats().dependencyEdges, baseline)
})

test('disposed scope drops callbacks, queued registration and host; disposal is reentrant', () => {
  const scope = new ComponentScope(document.createElement('div'))
  const calls = []
  scope.active = true
  scope.onDeactive(() => { calls.push('deactive'); scope.dispose() })
  scope.onDispose(() => calls.push('dispose'))
  scope.addCleanup(() => calls.push('cleanup'))
  scope.beginWatchQueue()
  scope.queueWatch(() => assert.fail('must not register'))
  scope.dispose()
  scope.flushWatchQueue()
  assert.deepEqual(calls, ['deactive', 'dispose', 'cleanup'])
  assert.equal(scope.host, null)
  assert.equal(scope.watchQueue, null)
  assert.ok(Object.values(scope.lifecycle).every(list => list.length === 0))
  assert.equal(watch(scope, () => assert.fail('disposed scope cannot evaluate')), null)
  assert.equal(scope.setInterval(() => {}, 10), null)
})

test('twenty mount/destroy cycles return live handles and dependency edges to baseline', async () => {
  const baseline = stats()
  for (let i = 0; i < 20; i++) {
    const { app, host } = await mount('<ul><li v-for="item in items"><b v-if="item.show">{{item.name}}</b></li></ul>', {
      items: [{ show: true, name: 'a' }, { show: false, name: 'b' }],
    })
    app.destroy()
    host.remove()
    assert.equal(stats().liveHandles, baseline.liveHandles)
    assert.equal(stats().dependencyEdges, baseline.dependencyEdges)
  }
})

test('branch teardown removes its cleanup closures while the parent scope stays alive', async () => {
  const { app, host } = await mount('<template v-if="show"><template v-for="n in items">{{n}}</template></template>', {
    show: false, items: [1, 2],
  })
  const scope = instanceOf(host, false).scope
  const cleanups = scope.cleanups.size
  const baseline = stats()
  for (let i = 0; i < 20; i++) {
    app._data.show = true; await flush(20)
    app._data.show = false; await flush(20)
    assert.equal(scope.cleanups.size, cleanups)
    assert.equal(stats().liveHandles, baseline.liveHandles)
    assert.equal(stats().dependencyEdges, baseline.dependencyEdges)
  }
  app.destroy(); host.remove()
})
