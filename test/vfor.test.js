/*
 * vfor.test.js — v-for 条目身份与 reconcile 通知链路回归
 *
 * 锁定 2026-08-11 compileVfor 修复（collect/reconcile 拆分）：
 * reconcile 在 watch callback 期执行（listen_tags 已弹出），
 * 缓存命中条目的就地数据写入必须正常通知下游绑定。
 * 修复前：标量列表等长换值 / unshift 全位置换值时 DOM 静默不更新。
 *
 * happy-dom 提供 DOM 全局；src 模块加载期即触碰 window，
 * 必须先装全局再动态 import。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Window } from 'happy-dom'

const win = new Window({ url: 'http://localhost/' })

for (const key of [
  'Node', 'Element', 'HTMLElement', 'SVGElement',
  'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLSelectElement',
  'Text', 'Comment', 'DocumentFragment',
  'Event', 'CustomEvent', 'MutationObserver',
  'NodeFilter', 'localStorage', 'getComputedStyle', 'history',
]) {
  if (win[key] !== undefined) globalThis[key] = win[key]
}
globalThis.window = win
globalThis.document = win.document
globalThis.requestAnimationFrame = win.requestAnimationFrame.bind(win)
globalThis.cancelAnimationFrame = win.cancelAnimationFrame.bind(win)
// happy-dom 不实现 dialog 方法；sandbox.js 加载期即引用，装桩即可（测试不调用）
globalThis.alert = () => {}
globalThis.prompt = () => ''
globalThis.confirm = () => false

const { default: VHTML } = await import('../src/index.js')
const { Wrap } = await import('../src/reactive.js')

// 响应式冲刷走 rAF 批量；reconcile 内的写入会再排一帧
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

test('scalar list: same-length value replacement patches DOM in place', async () => {
  const { app, host } = await mount(
    `<ul><li v-for="item in items">{{ item }}</li></ul>`,
    { items: ['a', 'b'] },
  )
  assert.deepEqual(texts(host, 'li'), ['a', 'b'])
  const before = [...host.querySelectorAll('li')]

  app._data.items = ['x', 'y']
  await flush()

  const after = [...host.querySelectorAll('li')]
  assert.deepEqual(after.map((n) => n.textContent), ['x', 'y'])
  assert.equal(before[0], after[0], 'DOM node should be reused')
  assert.equal(before[1], after[1], 'DOM node should be reused')
  app.destroy()
})

test('scalar list: unshift updates every position plus the new tail', async () => {
  const { app, host } = await mount(
    `<ul><li v-for="item in items">{{ item }}</li></ul>`,
    { items: ['x', 'y'] },
  )
  app._data.items.unshift('HEAD')
  await flush()
  assert.deepEqual(texts(host, 'li'), ['HEAD', 'x', 'y'])
  app.destroy()
})

test('scalar list with index var: swap updates both i and item', async () => {
  const { app, host } = await mount(
    `<ul><li v-for="(it, i) in items">{{ i }}:{{ it }}</li></ul>`,
    { items: ['p', 'q'] },
  )
  app._data.items = ['q', 'p']
  await flush()
  assert.deepEqual(texts(host, 'li'), ['0:q', '1:p'])
  app.destroy()
})

test('object list: wholesale replacement with new objects rebuilds entries', async () => {
  const { app, host } = await mount(
    `<ul><li v-for="o in list">{{ o.name }}</li></ul>`,
    { list: [{ id: 1, name: 'n1' }, { id: 2, name: 'n2' }] },
  )
  assert.deepEqual(texts(host, 'li'), ['n1', 'n2'])
  const before = [...host.querySelectorAll('li')]

  app._data.list = [{ id: 9, name: 'z9' }, { id: 10, name: 'z10' }]
  await flush()

  const after = [...host.querySelectorAll('li')]
  assert.deepEqual(after.map((n) => n.textContent), ['z9', 'z10'])
  assert.notEqual(before[0], after[0], 'new identities must rebuild DOM')
  app.destroy()
})

test('object list: index assignment merges into the existing proxy (copyBind)', async () => {
  const { app, host } = await mount(
    `<ul><li v-for="o in list">{{ o.name }}</li></ul>`,
    { list: [{ id: 1, name: 'n1' }, { id: 2, name: 'n2' }] },
  )
  const before = [...host.querySelectorAll('li')]

  app._data.list[0] = { id: 100, name: 'merged' }
  await flush()

  const after = [...host.querySelectorAll('li')]
  assert.deepEqual(after.map((n) => n.textContent), ['merged', 'n2'])
  assert.equal(before[0], after[0], 'identity kept — DOM reused')
  assert.equal(app._data.list[0].id, 100, 'fields merged in place')
  app.destroy()
})

test('object list: field mutation through the proxy patches in place', async () => {
  const { app, host } = await mount(
    `<ul><li v-for="o in list">{{ o.name }}</li></ul>`,
    { list: [{ id: 1, name: 'n1' }, { id: 2, name: 'n2' }] },
  )
  const before = [...host.querySelectorAll('li')]

  app._data.list[1].name = 'n2-edit'
  await flush()

  assert.deepEqual(texts(host, 'li'), ['n1', 'n2-edit'])
  assert.equal(before[1], [...host.querySelectorAll('li')][1])
  app.destroy()
})

test('object list: reorder via slice-assign moves existing DOM nodes', async () => {
  const { app, host } = await mount(
    `<ul><li v-for="o in list">{{ o.name }}</li></ul>`,
    { list: [{ id: 1, name: 'n1' }, { id: 2, name: 'n2' }] },
  )
  const before = [...host.querySelectorAll('li')]

  app._data.list = [app._data.list[1], app._data.list[0]]
  await flush()

  const after = [...host.querySelectorAll('li')]
  assert.deepEqual(after.map((n) => n.textContent), ['n2', 'n1'])
  assert.equal(after[0], before[1], 'identity kept — node physically moved')
  assert.equal(after[1], before[0])
  app.destroy()
})

test('object list: removal destroys only the removed entry', async () => {
  const { app, host } = await mount(
    `<ul><li v-for="o in list">{{ o.name }}</li></ul>`,
    { list: [{ id: 1, name: 'n1' }, { id: 2, name: 'n2' }, { id: 3, name: 'n3' }] },
  )
  const before = [...host.querySelectorAll('li')]

  app._data.list = app._data.list.filter((o) => o.id !== 2)
  await flush()

  const after = [...host.querySelectorAll('li')]
  assert.deepEqual(after.map((n) => n.textContent), ['n1', 'n3'])
  assert.equal(after[0], before[0])
  assert.equal(after[1], before[2])
  app.destroy()
})

/*
 * 锁定 2026-08-11 compileVif 防御 + compileVfor 形状重建（vedio_studio 崩溃）：
 * 函数源列表每次返回全新无 DataID 行对象 → 位置键（unkeyed:N）复用缓存条目。
 * 行形状突变时（如元素行 → 音乐轨行）必须销毁重建而非 copyBind 合并——
 * 合并会先删旧键再通知，旧分支内绑定（tr.el.type 等）对错位数据瞬时求值，
 * 报错误差外还会把求值失败一路传进 showBranch（已由 compileVif 防御二度兜底）。
 */
test('vif guard: shape change under position-keyed reuse rebuilds without errors', async () => {
  // 自 Wrap 让函数体经代理读取（依赖注册）；rows() 每次返回全新行对象（无 DataID）
  const data = Wrap({
    doc: { kind: 'el', id: 'e1', el: { type: 'media' } },
  })
  data.rows = () => {
    const d = data.doc
    return d.kind === 'el'
      ? [{ kind: 'el', id: d.id, el: d.el }]
      : [{ kind: 'track', label: d.label }]
  }
  const { app, host } = await mount(
    `<div>
       <div v-for="tr in rows()" class="row">
         <template v-if="tr.kind === 'el'">
           <span class="id">{{ tr.id }}</span>
           <span class="sub" v-if="tr.el.type === 'media'">M</span>
         </template>
         <template v-else>
           <span class="id">{{ tr.label }}</span>
         </template>
       </div>
     </div>`,
    data,
  )
  assert.deepEqual(texts(host, '.id'), ['e1'])
  assert.deepEqual(texts(host, '.sub'), ['M'])
  const before = host.querySelector('.row')

  // 形状突变：重建条目，全程不得出现瞬时求值错误
  const runErrors = []
  const origError = console.error
  console.error = (...args) => { runErrors.push(args) }
  try {
    data.doc = { kind: 'track', label: 'T1' }
    await flush()
    await flush()
  } finally {
    console.error = origError
  }

  assert.deepEqual(texts(host, '.id'), ['T1'])
  assert.deepEqual(texts(host, '.sub'), [])
  assert.notEqual(host.querySelector('.row'), before, 'shape change must rebuild the entry')
  assert.equal(runErrors.filter(a => String(a[0]).includes('Run error')).length, 0,
    'rebuild must not evaluate stale branch bindings')
  app.destroy()
})

test('vif guard companion: same-shape position reuse still patches in place', async () => {
  const data = Wrap({
    doc: { kind: 'el', id: 'e1', el: { type: 'media' } },
  })
  data.rows = () => {
    const d = data.doc
    return [{ kind: 'el', id: d.id, el: d.el }]
  }
  const { app, host } = await mount(
    `<div>
       <div v-for="tr in rows()" class="row">
         <span class="id">{{ tr.id }}</span>
         <span class="sub" v-if="tr.el.type === 'media'">M</span>
       </div>
     </div>`,
    data,
  )
  assert.deepEqual(texts(host, '.id'), ['e1'])
  assert.deepEqual(texts(host, '.sub'), ['M'])
  const before = host.querySelector('.row')

  // 同形状换值：原地合并，DOM 复用，v-if 正常重估
  data.doc = { kind: 'el', id: 'e2', el: { type: 'text' } }
  await flush()
  await flush()

  assert.deepEqual(texts(host, '.id'), ['e2'])
  assert.deepEqual(texts(host, '.sub'), [])
  assert.equal(host.querySelector('.row'), before, 'same shape must keep DOM identity')
  app.destroy()
})
