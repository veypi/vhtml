import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadSrc, mount, flush } from './harness.js'

await loadSrc()
const { ComponentScope } = await import('../src/component-scope.js')
const { perfStats } = await import('../src/perf-stats.js')
const pending = () => [perfStats.pendingFrames, perfStats.pendingTimeouts, perfStats.pendingIntervals]

function clock() {
  const names = ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame']
  const originals = new Map(names.map(name => [name, window[name]])), callbacks = new Map()
  let next = 0
  for (const name of ['setTimeout', 'setInterval', 'requestAnimationFrame']) {
    window[name] = fn => { callbacks.set(++next, fn); return next }
  }
  // 故意保留已取消回调，模拟取消前已经取出的任务。
  for (const name of ['clearTimeout', 'clearInterval', 'cancelAnimationFrame']) window[name] = () => {}
  return { run: (id, timestamp) => callbacks.get(id)(timestamp), restore: () => {
    for (const [name, fn] of originals) window[name] = fn
  } }
}

test('1,000 naturally completed frame/timeout tasks leave no pending resources', () => {
  const before = pending(), c = clock(), scope = new ComponentScope()
  let calls = 0
  try {
    for (let i = 0; i < 1000; i++) {
      c.run(scope.setTimeout(() => { calls++; assert.equal(scope.timers.size, 0) }, 0))
      c.run(scope.requestAnimationFrame(time => { calls++; assert.equal(time, 42); assert.equal(scope.frames.size, 0) }), 42)
    }
    assert.equal(calls, 2000)
    assert.deepEqual(pending(), before)
    const throwing = scope.requestAnimationFrame(() => { throw new Error('task failed') })
    assert.throws(() => c.run(throwing), /task failed/)
    assert.equal(scope.frames.size, 0)
  } finally { scope.dispose(); c.restore() }
})

test('cancel/dispose suppress queued callbacks; reentrant and late registration are safe', () => {
  const before = pending(), c = clock(), scope = new ComponentScope()
  let calls = 0, late = 0
  try {
    const frame = scope.requestAnimationFrame(() => calls++)
    scope.cancelAnimationFrame(frame); scope.cancelAnimationFrame(frame)
    c.run(frame)
    const timeout = scope.setTimeout(() => calls++, 0)
    scope.clearTimeout(timeout); c.run(timeout)
    const interval = scope.setInterval(() => calls++, 0)
    c.run(interval)
    scope.clearInterval(interval); c.run(interval)
    const frames = [scope.requestAnimationFrame(() => { calls++; scope.dispose() }), scope.requestAnimationFrame(() => calls++)]
    const pendingTimer = scope.setTimeout(() => calls++, 0)
    c.run(frames[0]); c.run(frames[1]); c.run(pendingTimer)
    scope.dispose()
    scope.addCleanup(() => late++)
    assert.equal(scope.requestAnimationFrame(() => calls++), null)
    assert.equal(scope.setTimeout(() => calls++, 0), null)
    assert.equal(scope.setInterval(() => calls++, 0), null)
    assert.equal(calls, 2)
    assert.equal(late, 1)
    assert.deepEqual(pending(), before)
  } finally { scope.dispose(); c.restore() }
})

test('deactivation preserves owned resources; dispose releases listeners and external subscriptions', () => {
  const before = pending(), c = clock(), scope = new ComponentScope()
  let events = 0, disconnected = 0, calls = 0
  const target = document.createElement('div')
  try {
    scope.addEventListener(target, 'x', () => events++)
    scope.addCleanup(() => { throw new Error('cleanup failure is isolated') })
    scope.addCleanup(() => disconnected++)
    const frame = scope.requestAnimationFrame(() => calls++)
    scope.markBuilding(); scope.tryMount(); scope.setRouteCurrent(false, 'route')
    assert.equal(scope.phase, 'mounted')
    c.run(frame)
    assert.equal(calls, 1)
    target.dispatchEvent(new globalThis.Event('x'))
    scope.dispose()
    target.dispatchEvent(new globalThis.Event('x'))
    assert.equal(events, 1)
    assert.equal(disconnected, 1)
    assert.deepEqual(pending(), before)
  } finally { scope.dispose(); c.restore() }
})

test('20 actual mount/dispose cycles release script-owned tasks and reactive dependencies', async () => {
  const { instanceOf } = await import('../src/component-instance.js')
  const warm = await mount('<b>{{n}}</b>', { n: 0 }); warm.app.destroy(); await flush()
  const before = pending(), stats = window.__vhtml_dev.stats
  for (let i = 0; i < 20; i++) {
    const { app, host } = await mount('<b>{{n}}</b>', { n: i })
    const scope = instanceOf(host).scope
    scope.requestAnimationFrame(() => assert.fail('disposed frame must not run'))
    scope.setTimeout(() => assert.fail('disposed timeout must not run'), 10000)
    scope.setInterval(() => assert.fail('disposed interval must not run'), 10000)
    app.destroy(); host.remove()
  }
  await flush()
  assert.deepEqual(pending(), before)
  assert.equal(window.__vhtml_dev.stats.liveHandles, stats.liveHandles)
  assert.equal(window.__vhtml_dev.stats.dependencyEdges, stats.dependencyEdges)
})
