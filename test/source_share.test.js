/*
 * source_share.test.js — 结构模板源全局共享回归
 *
 * 锁定 2026-08-19 修复：v-for sourceNodes / v-if sourceBranches
 * 从「每个实例化点各驻留一份模板克隆」改为「按内容全局共享一份只读模板」。
 * 修复前，长列表（如聊天消息）每条 item 的每个 v-if 分支都驻留整棵
 * 分支模板克隆，驻留规模 = item 数 × 分支数 × 模板大小（C++ 节点计数
 * 可达活 DOM 的数倍）。
 *
 * 行为断言：
 *   1. 相同内容的结构源只入缓存一次（两处相同 v-for 不新增缓存项）
 *   2. 共享源不影响渲染与分支切换（克隆后编译，实例互不影响）
 *   3. 两个相同列表的数据独立（改 list1 不影响 list2）
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
globalThis.alert = () => {}
globalThis.prompt = () => ''
globalThis.confirm = () => false

const { default: VHTML } = await import('../src/index.js')
const { getSharedSourceCacheSize } = await import('../src/compiler.js')

const flush = () => new Promise((resolve) => setTimeout(resolve, 60))

async function mount(template, data) {
  const host = document.createElement('div')
  host.innerHTML = template
  document.body.appendChild(host)
  const app = new VHTML({ target: host, data })
  await app.ready
  await flush()
  return { host, app }
}

// 注意：item 模板字面量在列表间必须逐字节一致（共享 key 为 outerHTML）
const ITEM = '<div class="row"><span v-if="item.ok" class="yes">Y</span><span v-else class="no">N</span><b>{{item.name}}</b></div>'

test('相同内容的 v-for/v-if 结构源全局共享，且实例行为独立', async () => {
  const before = getSharedSourceCacheSize()

  const tpl = `<ul><li v-for="item in list">${ITEM}</li></ul>`
  const a = await mount(tpl, {
    list: [{ ok: true, name: 'a1' }, { ok: false, name: 'a2' }],
  })
  const b = await mount(tpl, {
    list: [{ ok: false, name: 'b1' }],
  })

  // 1) 第二处完全相同的模板不应新增结构源缓存项
  assert.equal(getSharedSourceCacheSize(), before + 1 + 2,
    'v-for 源 + v-if 两分支各入缓存一次，第二处相同模板全部命中共享')

  // 2) 渲染正确
  assert.equal(a.host.querySelectorAll('.row').length, 2)
  assert.equal(b.host.querySelectorAll('.row').length, 1)
  assert.equal(a.host.querySelectorAll('.yes').length, 1)
  assert.equal(a.host.querySelectorAll('.no').length, 1)
  assert.equal(b.host.querySelectorAll('.no').length, 1)

  // 3) 数据独立：改 a 不影响 b
  a.app._data.list[0].ok = false
  await flush()
  assert.equal(a.host.querySelectorAll('.yes').length, 0)
  assert.equal(a.host.querySelectorAll('.no').length, 2)
  assert.equal(b.host.querySelectorAll('.no').length, 1)
  assert.equal(b.host.querySelector('.row b').textContent, 'b1')

  // 4) 共享源仍可反复克隆新增条目
  a.app._data.list.push({ ok: true, name: 'a3' })
  await flush()
  assert.equal(a.host.querySelectorAll('.row').length, 3)
  assert.equal(a.host.querySelectorAll('.yes').length, 1)
  assert.equal(a.host.querySelectorAll('.row b')[2].textContent, 'a3')
})
