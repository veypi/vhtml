/*
 * flush-sync.test.js — 同步冲刷入口与 $sys.$vhtml 实例下发
 *
 * 背景：浏览器端响应式默认 rAF 批量（reactive.js schedule），DOM 更新晚一帧。
 * 虚拟列表这类「改行集 → 同任务内测量」的调用方需要同步入口：
 *   $sys.$vhtml.flushSync()（根 runtime 的 initialSys 沿原型链下发，不新增 window 全局）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setupDom } from './harness.js'
setupDom()

const { default: VHTML } = await import('../src/index.js')
const { Wrap, Watch, Cancel } = await import('../src/reactive.js')
const { createReactiveCore } = await import('../src/reactive-core.js')
const { createRuntimeContext } = await import('../src/module.js')

const flush = () => new Promise((resolve) => setTimeout(resolve, 60))
const texts = (root, sel) => [...root.querySelectorAll(sel)].map((n) => n.textContent)

async function mount(template, data) {
  const host = document.createElement('div')
  host.innerHTML = template
  document.body.appendChild(host)
  const app = new VHTML({ target: host, data })
  await app.ready
  await flush()
  return { app, host }
}

test('flushSync：列表与绑定在同一任务内落地（不等 rAF）', async () => {
  const { app, host } = await mount(
    `<ul><li v-for="item in items">{{ item }}</li></ul><p>{{ msg }}</p>`,
    { items: ['a'], msg: 'x' },
  )
  app._data.items = ['a', 'b', 'c']
  app._data.msg = 'y'
  assert.equal(host.querySelectorAll('li').length, 1, '默认调度仍是异步批量')
  app.flushSync()
  assert.deepEqual(texts(host, 'li'), ['a', 'b', 'c'])
  assert.equal(host.querySelector('p').textContent, 'y')
  app.destroy()
})

test('flushSync 之后不再有额外的帧更新（幂等）', async () => {
  const { app, host } = await mount(`<ul><li v-for="item in items">{{ item }}</li></ul>`, { items: ['a'] })
  app._data.items = ['a', 'b']
  app.flushSync()
  const snapshot = texts(host, 'li')
  await flush()
  assert.deepEqual(texts(host, 'li'), snapshot)
  app.destroy()
})

test('watcher 内重入 flushSync：不抛错、不重复执行，外层冲刷照常完成', async () => {
  const { app, host } = await mount(`<ul><li v-for="item in items">{{ item }}</li></ul>`, { items: ['a'] })
  const state = Wrap({ n: 0 })
  let runs = 0
  const handle = Watch(() => { runs++; state.n; app.flushSync() })
  const base = runs
  app._data.items = ['a', 'b']
  state.n++
  app.flushSync()
  assert.equal(runs, base + 1, '重入不应造成二次执行')
  assert.deepEqual(texts(host, 'li'), ['a', 'b'])
  Cancel(handle)
  app.destroy()
})

test('watcher 内 flushSync 返回点已经能读到新 DOM', async () => {
  const { app, host } = await mount(`<ul><li v-for="item in items">{{ item }}</li></ul>`, { items: ['a'] })
  const state = Wrap({ n: 0 })
  let armed = false
  let insideWatcher = 0
  const handle = Watch(() => state.n, () => {
    if (!armed) return
    app._data.items = ['a', 'b']
    app.flushSync()
    insideWatcher = host.querySelectorAll('li').length
  })
  armed = true
  state.n++
  app.flushSync()
  assert.equal(insideWatcher, 2, 'inner flushSync 返回点就必须完成模板落地')
  assert.deepEqual(texts(host, 'li'), ['a', 'b'])
  Cancel(handle)
  app.destroy()
})

test('watcher 内 flushSync 与外层共享推进位置，不重复执行后续 watcher', async () => {
  const { app, host } = await mount(`<p>{{ msg }}</p>`, { msg: 'x' })
  const state = Wrap({ n: 0 })
  const order = []
  let armed = false
  const first = Watch(() => state.n, () => {
    if (!armed) return
    order.push('first:start')
    app._data.msg = 'y'
    app.flushSync()
    assert.equal(host.querySelector('p').textContent, 'y')
    order.push('first:end')
  })
  const second = Watch(() => state.n, () => {
    if (!armed) return
    order.push('second')
  })
  armed = true
  state.n++
  app.flushSync()
  assert.deepEqual(order, ['first:start', 'second', 'first:end'])
  Cancel(first)
  Cancel(second)
  app.destroy()
})

test('watcher 内 flushSync 不遗留空调度或虚增 flush 统计', () => {
  const scheduled = []
  const core = createReactiveCore({ schedule: callback => scheduled.push(callback) })
  const state = core.Wrap({ trigger: 0, value: 0 })
  let armed = false
  let valueRuns = 0
  const valueHandle = core.Watch(() => { state.value; valueRuns++ })
  const triggerHandle = core.Watch(() => state.trigger, () => {
    if (!armed) return
    state.value++
    core.flush()
    state.value++
  })

  armed = true
  state.trigger++
  assert.equal(scheduled.length, 1)
  core.flush()
  assert.equal(valueRuns, 3, '重入返回后写入也由当前 drain 排空')
  assert.equal(scheduled.length, 1, 'flushing 期间的写入不重复调度')
  const flushes = core.stats.flushes
  while (scheduled.length) scheduled.shift()()
  assert.equal(core.stats.flushes, flushes, '已排空调度的旧回调不记空 flush')

  core.Cancel(triggerHandle)
  core.Cancel(valueHandle)
})

test('watcher 内 flushSync 仍共享 cascade 预算并向外抛错', async () => {
  const { app, host } = await mount(`<p>{{ msg }}</p>`, { msg: 'x' })
  const state = Wrap({ n: 0 })
  let armed = false
  const handle = Watch(() => state.n, () => {
    if (!armed) return
    state.n++
    app.flushSync()
  })
  armed = true
  assert.throws(() => {
    state.n++
    app.flushSync()
  }, /reactive cascade limit exceeded/)
  Cancel(handle)
  app.destroy()
})

test('document.hidden 下同样可同步冲刷', async () => {
  const { app, host } = await mount(`<p>{{ msg }}</p>`, { msg: 'x' })
  Object.defineProperty(document, 'hidden', { configurable: true, value: true })
  try {
    app._data.msg = 'hidden'
    app.flushSync()
    assert.equal(host.querySelector('p').textContent, 'hidden')
  } finally {
    Object.defineProperty(document, 'hidden', { configurable: true, value: false })
  }
  app.destroy()
})

test('$sys.$vhtml：根与派生 runtime 都指向所属 VHTML 实例', async () => {
  const { app } = await mount(`<p>x</p>`, {})
  assert.equal(app._runtime.$sys.$vhtml, app)
  const child = createRuntimeContext(app._runtime, null)
  assert.equal(child.$sys.$vhtml, app, '子 runtime 经原型链继承')
  const grand = createRuntimeContext(child, null)
  assert.equal(grand.$sys.$vhtml, app)
  app.destroy()
})
