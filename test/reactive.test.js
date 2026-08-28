/*
 * reactive.test.js — v0.10.0 响应式重写的新行为锁定
 *
 * 覆盖 todo 清单：变更门控正反例（值不变不触发/变化触发/equality:null
 * 恒触发）、数组六方法 batch 合并单次通知、v-for 原地 splice/shift/sort
 * 正确重排且保留行身份、字段级通知精度（改 a 不惊醒 b 订阅者）、级联防护
 * 触发（调度层 throw 带诊断）、hidden/visible flush、dead handle 惰性清理。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadSrc, mount, flush, texts } from './harness.js'

await loadSrc()
const { Wrap, Watch, Cancel, batch, mergeIntoProxy } = await import('../src/reactive.js')
const settle = () => flush(40)

// ====================================================================
// 变更门控
// ====================================================================

test('gate: unchanged value does not fire the callback, changed does', async () => {
  const p = Wrap({ n: 1, s: 'x' })
  let calls = 0
  const h = Watch(() => p.n + p.s, () => calls++)
  assert.equal(calls, 1, 'first round fires immediately')
  p.s = 'x'            // Object.is 相同 → 门掉
  await settle()
  assert.equal(calls, 1)
  p.n = 2              // 值变化 → 触发
  await settle()
  assert.equal(calls, 2)
  p.n = NaN
  p.n = NaN            // Object.is(NaN, NaN) = true → 不触发
  await settle()
  assert.equal(calls, 3)
  Cancel(h)
})

test('gate: same reference assignment to object key is skipped', async () => {
  const p = Wrap({ o: { a: 1 } })
  let calls = 0
  const h = Watch(() => p.o.a, () => calls++)
  const ref = p.o
  p.o = ref            // 同 proxy 引用 → set 短路，无通知
  await settle()
  assert.equal(calls, 1)
  Cancel(h)
})

test('gate: equality null fires on every notification (always-run subscription)', async () => {
  const p = Wrap({ list: [1, 2] })
  let runs = 0
  // target 必须读数组内容（spread 逐项 get → '' 通道注册），v-for collect 同理
  const h = Watch(() => [...p.list], (list) => { runs++; assert.ok(Array.isArray(list)) }, { equality: null })
  assert.equal(runs, 1)
  p.list.push(3)       // 原地变异，引用不变 —— 恒跑型必须触发
  await settle()
  assert.equal(runs, 2)
  p.list.splice(0, 1)
  await settle()
  assert.equal(runs, 3)
  Cancel(h)
})

test('gate: custom equality comparator is honored', async () => {
  const p = Wrap({ items: [1, 2, 3] })
  let calls = 0
  const sameMembers = (a, b) => Array.isArray(a) && Array.isArray(b)
    && a.length === b.length && a.every((v, i) => v === b[i])
  const h = Watch(() => [...p.items], () => calls++, { equality: sameMembers })
  p.items = [1, 2, 3]  // 成员相同 → 门掉
  await settle()
  assert.equal(calls, 1)
  p.items = [1, 2, 4]  // 成员不同 → 触发
  await settle()
  assert.equal(calls, 2)
  Cancel(h)
})

// ====================================================================
// batch 与数组变异方法
// ====================================================================

test('batch: notifications inside a batch collapse into one flush', async () => {
  const p = Wrap({ a: 1, b: 1 })
  let calls = 0
  const h = Watch(() => p.a + p.b, () => calls++)
  batch(() => {
    p.a = 10
    p.b = 20
    p.a = 30           // 同 key 多次写也合并
  })
  await settle()
  assert.equal(p.a + p.b, 50)
  assert.equal(calls, 2, 'one collapsed notification (initial + one flush)')
  Cancel(h)
})

test('mutators: splice/shift/unshift/sort/reverse are batch-wrapped and identity-stable', async () => {
  const p = Wrap({ list: [3, 1, 2] })
  assert.equal(typeof p.list.splice, 'function')
  assert.equal(p.list.splice, p.list.splice, 'wrapped function identity is stable')

  let flushes = 0
  const h = Watch(() => [...p.list], () => flushes++, { equality: null })
  p.list.sort()                        // [1,2,3]
  p.list.push(0)                       // [1,2,3,0]（与 sort 同帧：dirty 去重合并为一次重估）
  await settle()
  assert.deepEqual([...p.list], [1, 2, 3, 0])
  assert.equal(flushes, 2, 'initial + one merged flush for same-frame sort+push')

  p.list.reverse()                     // [0,3,2,1]
  await settle()
  assert.deepEqual([...p.list], [0, 3, 2, 1])
  p.list.shift()                       // [3,2,1]
  await settle()
  assert.deepEqual([...p.list], [3, 2, 1])
  p.list.unshift(9)                    // [9,3,2,1]
  await settle()
  assert.deepEqual([...p.list], [9, 3, 2, 1])
  p.list.splice(1, 1, 7)               // [9,7,2,1]
  await settle()
  assert.deepEqual([...p.list], [9, 7, 2, 1])
  Cancel(h)
})

test('mutators: sort comparator writing another proxy defers its notification (batch window)', async () => {
  const p = Wrap({ list: [2, 1] })
  const q = Wrap({ tick: 0 })
  let ticks = 0
  const hq = Watch(() => q.tick, () => ticks++)
  assert.equal(ticks, 1, 'first round')
  p.list.sort((a, b) => { q.tick = q.tick + 1; return a - b })  // 比较器内写他物
  await settle()
  assert.deepEqual([...p.list], [1, 2])
  assert.equal(ticks, 2, 'multiple comparator writes collapse to one notification')
  assert.equal(q.tick, 1, 'comparator ran once for two elements')
  Cancel(hq)
})

test('mutators: object entries moved by unshift keep data integrity', () => {
  const p = Wrap({ list: [{ v: 1 }, { v: 2 }] })
  p.list.unshift({ v: 0 })
  const [a, b, c] = [p.list[0], p.list[1], p.list[2]]
  assert.notEqual(a, b)
  assert.notEqual(b, c)
  assert.deepEqual([a.v, b.v, c.v], [0, 1, 2])
})

// ====================================================================
// v-for 原地变异：行身份保持（mergeIntoProxy 迁入 reconcile）
// ====================================================================

test('vfor: in-place splice removal keeps remaining row identities', async () => {
  const { app, host } = await mount(
    `<ul><li v-for="o in list">{{ o.name }}</li></ul>`,
    { list: [{ id: 1, name: 'n1' }, { id: 2, name: 'n2' }, { id: 3, name: 'n3' }] },
  )
  const before = [...host.querySelectorAll('li')]
  app._data.list.splice(1, 1)   // 原地删除中行
  await flush()
  const after = [...host.querySelectorAll('li')]
  assert.deepEqual(texts(host, 'li'), ['n1', 'n3'])
  assert.equal(after[0], before[0], 'surviving rows keep DOM identity')
  assert.equal(after[1], before[2])
  app.destroy()
})

test('vfor: in-place sort reorders rows preserving DOM nodes', async () => {
  const { app, host } = await mount(
    `<ul><li v-for="o in list">{{ o.name }}</li></ul>`,
    { list: [{ id: 3, name: 'c' }, { id: 1, name: 'a' }, { id: 2, name: 'b' }] },
  )
  const before = [...host.querySelectorAll('li')]
  app._data.list.sort((x, y) => x.id - y.id)   // 原地排序
  await flush()
  const after = [...host.querySelectorAll('li')]
  assert.deepEqual(texts(host, 'li'), ['a', 'b', 'c'])
  assert.equal(after[0], before[1], 'sorted rows reuse DOM nodes')
  assert.equal(after[1], before[2])
  assert.equal(after[2], before[0])
  app.destroy()
})

test('vfor: unshift appends a row and patches shifted rows in place', async () => {
  const { app, host } = await mount(
    `<ul><li v-for="o in list">{{ o.id }}:{{ o.name }}</li></ul>`,
    { list: [{ id: 1, name: 'x' }, { id: 2, name: 'y' }] },
  )
  const before = [...host.querySelectorAll('li')]
  app._data.list.unshift({ id: 0, name: 'h' })
  await flush()
  const after = [...host.querySelectorAll('li')]
  assert.deepEqual(texts(host, 'li'), ['0:h', '1:x', '2:y'])
  assert.equal(after[1], before[0], 'shifted rows patch in place (position-key merge)')
  assert.equal(after[2], before[1])
  app.destroy()
})

// ====================================================================
// 字段级通知精度
// ====================================================================

test('precision: writing field a does not wake a field-b subscriber', async () => {
  const p = Wrap({ a: 1, b: 1 })
  let aCalls = 0, bCalls = 0
  const ha = Watch(() => p.a, () => aCalls++)
  const hb = Watch(() => p.b, () => bCalls++)
  p.a = 99
  await settle()
  assert.equal(aCalls, 2)
  assert.equal(bCalls, 1, 'field-b subscriber stays asleep')
  Cancel(ha); Cancel(hb)
})

// ====================================================================
// 级联防护（调度层 throw，不经过单 watcher 隔离层）
// ====================================================================

test('cascade guard: runaway feedback throws at the scheduler with diagnostics', async () => {
  const p = Wrap({ n: 0 })
  // 自反馈：每次回调写自己依赖的 key
  const h = Watch(() => p.n, (v) => { p.n = v + 1 })
  const origError = console.error
  console.error = () => {}
  p.n = 1  // 触发调度；下一帧 flush 在 rAF 里 throw（happy-dom 可能吞错，
  // 但 throw 前已登记 __vhtml_dev.cascadeErrors）
  await flush(300)
  console.error = origError
  const reg = window.__vhtml_dev.cascadeErrors
  assert.ok(reg.length >= 1, 'cascade error registered before the throw')
  const msg = reg[reg.length - 1].message
  assert.ok(msg.includes('cascade limit exceeded'), `diagnostic message present: ${msg.slice(0, 80)}`)
  assert.ok(msg.includes('=>'), 'effect chain diagnostic included')
  Cancel(h)
  await settle()  // flushScheduled 已复位，后续写入可重新调度
  p.n = 10
  await settle()
  assert.equal(window.__vhtml_dev.stats.dirty, 0, 'scheduler recovers after cascade abort')
})

// ====================================================================
// hidden fallback 与 dead handle 惰性清理
// ====================================================================

test('hidden fallback: document.hidden schedules a setTimeout flush channel', async () => {
  const p = Wrap({ n: 1 })
  let calls = 0
  const h = Watch(() => p.n, () => calls++)
  const desc = Object.getOwnPropertyDescriptor(document, 'hidden') || {}
  try {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
    p.n = 2
    await settle()   // rAF 停摆时 setTimeout 兜底必然到达
    assert.equal(calls, 2, 'flush arrives through the fallback channel')
  } finally {
    if (desc.get || desc.set) {
      Object.defineProperty(document, 'hidden', desc)
    } else {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false })
    }
  }
  Cancel(h)
})

test('lazy cleanup: dead handles are dropped on next notify and never fire', async () => {
  const p = Wrap({ n: 1 })
  let calls = 0
  const h = Watch(() => p.n, () => calls++)
  Cancel(h)
  Cancel(h)          // 幂等
  p.n = 5
  await settle()
  assert.equal(calls, 1, 'cancelled handle never fires after first round')
  assert.equal(window.__vhtml_dev.stats.cancels >= 1, true)
  assert.equal(window.__vhtml_dev.stats.dirty, 0)
})

// ====================================================================
// mergeIntoProxy（reconcile 的行身份原语）
// ====================================================================

test('mergeIntoProxy: object merge keeps proxy identity, drops stale keys, notifies per field', async () => {
  const p = Wrap({ row: { a: 1, stale: true, nested: { deep: 1 } } })
  const rowRef = p.row
  let aCalls = 0
  const h = Watch(() => p.row.a, () => aCalls++)
  const merged = mergeIntoProxy(p.row, { a: 2, nested: { deep: 9 } })
  assert.equal(merged, rowRef, 'returns the original proxy')
  assert.equal(p.row.a, 2)
  assert.equal(p.row.stale, undefined, 'stale keys dropped')
  assert.equal(p.row.nested.deep, 9, 'nested objects merge recursively')
  await settle()
  assert.equal(aCalls, 2, 'field-level notification through the merge')
  Cancel(h)
})

test('mergeIntoProxy: non-mergeable inputs pass through untouched', () => {
  assert.equal(mergeIntoProxy('a', 'b'), 'b', 'scalar returns newValue')
  assert.deepEqual(mergeIntoProxy(undefined, { a: 1 }), { a: 1 }, 'non-proxy old value returns newValue')
  const p = Wrap({ x: { a: 1 } })
  const other = Wrap({ b: 2 })
  assert.equal(mergeIntoProxy(p.x, 42), 42, 'shape mismatch returns newValue')
  assert.equal(mergeIntoProxy(p.x, p.x), p.x, 'same DataID entity short-circuits')
  assert.deepEqual([...mergeIntoProxy(other, [1, 2])], [1, 2], 'array ← array rebuilds in place')
})
