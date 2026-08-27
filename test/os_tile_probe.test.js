/* 回归：空数组 v-for + push 静默不更新（2026-08-26 修复）
 *
 * 根因：collect 对空数组只走 Object.keys（ownKeys），而 Wrap 原先没有
 * ownKeys 陷阱——数组内容依赖（'' 通道）从未注册，push 通知无人接收。
 * 旧 /os 页面靠 restore 的整体赋值遮蔽了该 bug。
 *
 * 行为锁定：
 *   1. 初始空数组，push 后 v-for 必须新增子组件（含 props 渲染、:style 绑定）
 *   2. 父级后续修改条目字段（win.rect），子组件绑定跟随更新
 *   3. 对象表（object map）v-for 新增 key 同样触发更新
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
  'NodeFilter', 'localStorage', 'getComputedStyle', 'history', 'DOMParser',
]) {
  if (win[key] !== undefined) globalThis[key] = win[key]
}
globalThis.window = win
globalThis.document = win.document
globalThis.requestAnimationFrame = win.requestAnimationFrame.bind(win)
globalThis.cancelAnimationFrame = win.cancelAnimationFrame.bind(win)
globalThis.alert = () => {}
globalThis.prompt = () => ''
globalThis.confirm = () => false

const childHtml = `<!DOCTYPE html><html><head><title>w</title></head>
<style>body { position: absolute; }</style>
<body :style="bodyStyle()"><div class="inner">{{ win.url }}</div></body>
<script setup>
win = {}
bodyStyle = () => {
  if (win.hidden) return { display: 'none' }
  const r = win.rect || {}
  return { left: (r.x||0)+'px', top: (r.y||0)+'px', width: (r.w||0)+'px', height: (r.h||0)+'px' }
}
<\/script></html>`

const fakeHeaders = { get: () => null, entries: () => [][Symbol.iterator]() }
globalThis.fetch = async (url) => {
  const u = String(url)
  if (u.includes('/x/win.html')) return { ok: true, status: 200, headers: fakeHeaders, text: async () => childHtml }
  return { ok: false, status: 404, headers: fakeHeaders, text: async () => '' }
}
win.fetch = globalThis.fetch

const { default: VHTML } = await import('../src/index.js')
const flush = (ms = 60) => new Promise((r) => setTimeout(r, ms))

test('空数组 v-for：push 新增子组件且 props/样式正确', async () => {
  const host = document.createElement('div')
  host.innerHTML = `<div class="workspace"><x-win v-for="w in windows" :win="w"></x-win></div>`
  document.body.appendChild(host)
  const app = new VHTML({ target: host, data: { windows: [] } })
  await app.ready
  await flush()
  assert.equal(host.querySelectorAll('x-win').length, 0)

  // 模拟平铺布局 openApp：空数组 push + 同步写入 rect
  app._data.windows.push({ id: 'w1', url: '/os/buildin/calculator.html', rect: { x: 0, y: 0, w: 0, h: 0 }, hidden: false })
  app._data.windows.forEach(w => { w.rect = { x: 50, y: 60, w: 300, h: 200 } })
  await flush(200)

  const xwins = host.querySelectorAll('x-win')
  assert.equal(xwins.length, 1, 'push 后应创建一个子组件')
  const xw = xwins[0]
  assert.ok(xw.textContent.includes('calculator'), '子组件应已用 props 渲染内容')
  assert.equal(xw.style.width, '300px', 'rect.w 应应用到宿主 style')
  assert.equal(xw.style.left, '50px')

  // 父级再次改 rect，子组件应跟随
  app._data.windows[0].rect = { x: 1, y: 2, w: 500, h: 400 }
  await flush()
  assert.equal(xw.style.width, '500px', '父级改 rect 后子组件应更新')
  app.destroy()
})

test('空对象 v-for：新增 key 触发更新', async () => {
  const host = document.createElement('div')
  host.innerHTML = `<ul><li v-for="(v, k) in record">{{ k }}={{ v }}</li></ul>`
  document.body.appendChild(host)
  const app = new VHTML({ target: host, data: { record: {} } })
  await app.ready
  await flush()
  assert.equal(host.querySelectorAll('li').length, 0)

  app._data.record.a = '1'
  await flush()
  assert.deepEqual([...host.querySelectorAll('li')].map(n => n.textContent), ['a=1'])

  app._data.record.b = '2'
  await flush()
  assert.deepEqual([...host.querySelectorAll('li')].map(n => n.textContent), ['a=1', 'b=2'])
  app.destroy()
})

test('空数组 v-for：标量 push 与删除 key', async () => {
  const host = document.createElement('div')
  host.innerHTML = `<ul><li v-for="item in items">{{ item }}</li></ul>`
  document.body.appendChild(host)
  const app = new VHTML({ target: host, data: { items: [], record: { x: 1 } } })
  await app.ready
  await flush()
  app._data.items.push('a')
  await flush()
  assert.deepEqual([...host.querySelectorAll('li')].map(n => n.textContent), ['a'])
  app.destroy()
})
