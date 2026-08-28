/*
 * copybind.test.js — copyBind 行为快照（v0.10.0 第一交付物：黄金用例）
 *
 * copyBind 现有语义是 aic 全部页面的行为基线（2026-08-26 ProxySpreadPitfall
 * 在前）。本文件在重写前锁定四类黄金行为，重写（set 纯替换 + mergeIntoProxy
 * 迁入 v-for reconcile）后按标注更新语义变化用例：
 *
 *   1. 同 DataID 合并：同实体字段 mutate → 通知 + 身份保持（重写后不变）
 *   2. 新实体重建：新对象 = 新身份 = DOM 重建（重写后不变）；
 *      raw 对象直接赋给 proxy key 的「原位 merge 身份保持」（重写后语义
 *      变化：纯替换，新 proxy 新 DataID —— v-for data: 键路径随之重建，
 *      渲染等价）
 *   3. 嵌套数组：数组整体赋值 → 内容替换 + '' 通知；元素 proxy 重排身份
 *      保持（v-for reorder DOM 物理移动，重写后不变）
 *   4. 别名：变异搬移后相邻元素不同引用、重复读稳定、同 raw 跨 key 数据
 *      同步（重写后不变）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadSrc, mount, flush, texts } from './harness.js'

await loadSrc()  // 先装 DOM 全局，src 模块加载期即触碰 window
const { Wrap, Watch, Cancel } = await import('../src/reactive.js')
// 响应式通知走 rAF 批量，同步断言前必须冲刷
const settle = () => flush(40)

// ====================================================================
// 响应式级快照
// ====================================================================

test('golden-1: same-reference assignment never notifies', async () => {
  const p = Wrap({ n: 1 })
  let calls = 0
  const h = Watch(() => p.n, () => calls++)
  assert.equal(calls, 1, 'first round fires immediately')
  p.n = 1
  p.n = p.n
  await settle()
  assert.equal(calls, 1, 'identical assignment must not notify')
  Cancel(h)
})

test('golden-1: same entity field mutation keeps identity and notifies', async () => {
  const p = Wrap({ x: { a: 1 } })
  const oldRef = p.x
  let calls = 0
  const h = Watch(() => p.x.a, (v) => calls++)
  p.x.a = 2
  await settle()
  assert.equal(p.x, oldRef, 'field mutation keeps the proxy identity')
  assert.equal(p.x.a, 2)
  assert.equal(calls, 2, 'field channel notifies the watcher')
  Cancel(h)
})

test('golden-2 [REWRITTEN]: raw object assigned to proxied key is a pure replacement', async () => {
  const p = Wrap({ x: { a: 1, extra: true } })
  const oldRef = p.x
  let calls = 0
  const h = Watch(() => p.x.a, () => calls++)
  const before = calls
  p.x = { a: 2 }  // raw object wholesale replacement
  await settle()
  assert.equal(p.x.a, 2, 'field value readable through the fresh wrap')
  // v0.10.0：set 纯替换 —— 新 proxy 新 DataID（旧行为见 git 历史：copyBind 原位 merge）
  assert.notEqual(p.x, oldRef, 'pure replacement installs a fresh proxy')
  assert.equal(oldRef.extra, true, 'old entity is untouched (no merge side effects)')
  assert.ok(calls > before, 'watcher re-registered through the new proxy chain')
  Cancel(h)
})

test('golden-2: fresh object = fresh identity (wholesale replacement rebuilds)', async () => {
  const { app, host } = await mount(
    `<ul><li v-for="o in list">{{ o.name }}</li></ul>`,
    { list: [{ id: 1, name: 'n1' }] },
  )
  const before = host.querySelector('li')
  app._data.list = [{ id: 9, name: 'z9' }]
  await flush()
  assert.deepEqual(texts(host, 'li'), ['z9'])
  assert.notEqual(host.querySelector('li'), before, 'new identities must rebuild DOM')
  app.destroy()
})

test('golden-3 [REWRITTEN]: raw array reassigned to proxied key is a pure replacement', async () => {
  const p = Wrap({ list: [1, 2] })
  const oldRef = p.list
  let calls = 0
  const h = Watch(() => p.list.length, () => calls++)
  const before = calls
  p.list = [3, 2, 1]
  await settle()
  assert.deepEqual([...p.list], [3, 2, 1], 'content replaced')
  // v0.10.0：纯替换 —— 新数组 proxy（旧行为见 git 历史：length=0+push 原位重建）
  assert.notEqual(p.list, oldRef, 'pure replacement installs a fresh array proxy')
  assert.ok(calls > before, "array '' channel notifies the watcher")
  Cancel(h)
})

test('golden-3: v-for reorder moves existing DOM nodes (element proxy identity)', async () => {
  const { app, host } = await mount(
    `<ul><li v-for="o in list">{{ o.name }}</li></ul>`,
    { list: [{ id: 1, name: 'n1' }, { id: 2, name: 'n2' }] },
  )
  const before = [...host.querySelectorAll('li')]
  app._data.list = [app._data.list[1], app._data.list[0]]
  await flush()
  const after = [...host.querySelectorAll('li')]
  assert.deepEqual(texts(host, 'li'), ['n2', 'n1'])
  assert.equal(after[0], before[1], 'identity kept — node physically moved')
  assert.equal(after[1], before[0])
  app.destroy()
})

test('golden-4 [REWRITTEN, old bug fixed]: unshift moves object entries without aliasing', () => {
  // 旧实现缺陷（重写动机之一）：copyBind 在 set 陷阱内合并移动中的实体 proxy，
  // unshift 后 [0]/[1] 均缩为同一 proxy，移入条目被新值 merge 污染
  // （期望 [{v:0},{v:1},{v:2}]，旧实际 [{v:0},{v:0},{v:2}]）。
  // v0.10.0 纯替换后：三元素互异、数据正确。
  const q = Wrap({ list: [{ v: 1 }, { v: 2 }] })
  q.list.unshift({ v: 0 })
  const a = q.list[0], b = q.list[1], c = q.list[2]
  assert.notEqual(a, b, 'adjacent entries are distinct proxies (alias bug fixed)')
  assert.notEqual(b, c)
  assert.equal(a.v, 0)
  assert.equal(b.v, 1, 'moved entry keeps its own data (no merge pollution)')
  assert.equal(c.v, 2)
  assert.equal(q.list[1], q.list[1], 'repeated reads are stable (wrap-once)')
  // 标量移动同样正确
  const p = Wrap({ list: ['a', 'b'] })
  p.list.unshift('HEAD')
  assert.deepEqual([...p.list], ['HEAD', 'a', 'b'])
})

test('golden-4: two keys sharing one raw object stay data-synced', () => {
  const shared = { n: 1 }
  const p = Wrap({ a: shared, b: shared })
  // 现状：a/b 各自 wrap 出独立 proxy（后写覆盖 raw 上的 DataID），
  // 但两者包裹同一 raw target —— 数据天然同步，通知通道分离
  p.a.n = 5
  assert.equal(p.b.n, 5, 'same raw target keeps data in sync across aliases')
})

// ====================================================================
// v-for 消费路径快照（merge 语义的行为载体）
// ====================================================================

test('vfor [REWRITTEN]: index assignment rebuilds the entry (pure replacement)', async () => {
  const { app, host } = await mount(
    `<ul><li v-for="o in list">{{ o.name }}</li></ul>`,
    { list: [{ id: 1, name: 'n1' }, { id: 2, name: 'n2' }] },
  )
  const before = [...host.querySelectorAll('li')]
  app._data.list[0] = { id: 100, name: 'merged' }
  await flush()
  const after = [...host.querySelectorAll('li')]
  assert.deepEqual(texts(host, 'li'), ['merged', 'n2'], 'rendering stays correct')
  assert.equal(app._data.list[0].id, 100)
  // v0.10.0：新对象 = 新 DataID = 条目重建（旧 copyBind merge 保 DOM 的行为已删）
  assert.notEqual(before[0], after[0], 'fresh identity rebuilds the DOM entry')
  app.destroy()
})

test('vfor: function-source rows keep row identity via position-key merge (vedio_studio shape)', async () => {
  const data = Wrap({ doc: { name: 'a' } })
  data.rows = () => [{ name: data.doc.name }]
  const { app, host } = await mount(
    `<ul><li v-for="r in rows()">{{ r.name }}</li></ul>`,
    data,
  )
  const before = host.querySelector('li')
  data.doc = { name: 'b' }
  await flush()
  await flush()
  assert.deepEqual(texts(host, 'li'), ['b'])
  // 位置键复用 + merge 保持行身份 —— 重写后由 mergeIntoProxy 保证，不变
  assert.equal(host.querySelector('li'), before, 'same shape must keep row DOM identity')
  app.destroy()
})
