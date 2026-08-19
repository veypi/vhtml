/*
 * meta_stash.test.js — 编译器不留存元素子树快照（内存泄漏回归）
 *
 * 2026-08-19 修复：compileNode 曾给每个元素在 meta.sourceNodes 上驻留
 * 整棵子树的深克隆（写入后无任何读取方，历史 v-if 恢复机制的残留），
 * 驻留规模为 O(节点数 × 深度)（happy-dom 探针实测：5.8 万节点的页面
 * 驻留 39.5 万游离克隆节点），性能监视器节点数远超文档实际节点数。
 * 组件实例的 slot 源快照（ComponentInstance.sourceNodes）同属死驻留，
 * 已一并移除——插槽源由 createSlotContents 内部克隆持有。
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
const { metaOf, instanceOf } = await import('../src/component-instance.js')

const flush = () => new Promise((resolve) => setTimeout(resolve, 60))

test('compiled elements do not retain subtree clones in meta', async () => {
  const host = document.createElement('div')
  host.innerHTML = `<div class="outer"><ul><li v-for="i in items">{{ i }}</li></ul><p>{{ msg }}</p></div>`
  document.body.appendChild(host)
  const app = new VHTML({ target: host, data: { items: [1, 2, 3], msg: 'hi' } })
  await app.ready
  await flush()

  // 渲染结果正确
  assert.deepEqual([...host.querySelectorAll('li')].map((n) => n.textContent), ['1', '2', '3'])
  assert.equal(host.querySelector('p').textContent, 'hi')

  // 全树元素 meta 无 sourceNodes 驻留
  let bad = 0
  const walk = (el) => {
    if (metaOf(el).sourceNodes) bad++
    for (const ch of el.children) walk(ch)
  }
  walk(document.body)
  assert.equal(bad, 0, 'no element may retain meta.sourceNodes')

  // 组件实例无 sourceNodes 字段驻留
  const inst = instanceOf(host)
  assert.equal(inst?.sourceNodes, undefined, 'instance must not hold sourceNodes')

  app.destroy()
})
