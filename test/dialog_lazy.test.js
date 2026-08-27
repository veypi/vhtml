/*
 * dialog_lazy.test.js — v-dialog 懒创建回归
 *
 * 锁定 2026-08-19 vhtml-ui dialog.html 重构：
 * 对话框 overlay 从「挂载即创建并 teleport 到 body（v-show 隐藏）」
 * 改为「v-if 懒创建，首次 visible=true 才编译+teleport」。
 *
 * 行为锁定：
 *   1. 挂载后（未打开）document.body 中不存在 .v-dialog-overlay（零 DOM 驻留）
 *   2. visible=true 后 overlay 被编译并 teleport 到 body 且可见
 *   3. 关闭后 overlay 保留在 body（keep-alive）但 v-show 隐藏；重开无重建
 *   4. 宿主销毁时 overlay 从 body 移除
 *
 * dialog.html 从 vhtml-ui 本地检出读盘（fetch 打桩）；文件不存在则跳过。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { Window } from 'happy-dom'

const DIALOG_PATH = '/Users/veypi/ivec/vhtml-ui/ui/dialog.html'
if (!fs.existsSync(DIALOG_PATH)) {
  console.log('skip: vhtml-ui checkout not found')
  process.exit(0)
}
const dialogHtml = fs.readFileSync(DIALOG_PATH, 'utf8')

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

// fetch 打桩：仅供给 /v/dialog.html，其余 404
const fakeHeaders = { get: () => null, entries: () => [][Symbol.iterator]() }
globalThis.fetch = async (url) => {
  const u = String(url)
  if (u.includes('/v/dialog.html')) {
    return { ok: true, status: 200, headers: fakeHeaders, text: async () => dialogHtml }
  }
  return { ok: false, status: 404, headers: fakeHeaders, text: async () => '' }
}
win.fetch = globalThis.fetch

const { default: VHTML } = await import('../src/index.js')

const flush = (ms = 120) => new Promise((resolve) => setTimeout(resolve, ms))

test('v-dialog 懒创建：未打开零 DOM，打开后 teleport，关闭保留，销毁清理', async () => {
  const host = document.createElement('div')
  host.innerHTML = `<v-dialog v:visible="show" title="T1"><p class="dlg-content">hello</p></v-dialog>`
  document.body.appendChild(host)
  const app = new VHTML({ target: host, data: { show: false } })
  await app.ready
  await flush()

  // 1) 未打开：body 中无 overlay
  assert.equal(document.body.querySelector('.v-dialog-overlay'), null, 'closed dialog must not mount overlay')

  // 2) 打开：overlay 编译并 teleport 到 body
  app._data.show = true
  await flush()
  await flush()
  const overlay = document.body.querySelector('.v-dialog-overlay')
  assert.ok(overlay, 'opened dialog overlay should be teleported to body')
  assert.notEqual(overlay.style.display, 'none', 'opened overlay should be visible')
  assert.ok(overlay.querySelector('.dlg-content'), 'projected slot content rendered')

  // 3) 关闭：overlay 保留在 body 但隐藏（keep-alive，重开无重建）
  app._data.show = false
  await flush()
  const overlayAfterClose = document.body.querySelector('.v-dialog-overlay')
  assert.ok(overlayAfterClose, 'closed overlay stays in body (keep-alive)')
  assert.equal(overlayAfterClose.style.display, 'none', 'closed overlay hidden via v-show')
  assert.equal(overlayAfterClose, overlay, 'same overlay element reused')

  // 4) 重开：同一元素重新显示
  app._data.show = true
  await flush()
  assert.notEqual(overlay.style.display, 'none', 'reopened overlay visible')

  // 5) 销毁宿主：overlay 从 body 移除
  app._data.show = false
  await flush()
  app.destroy?.()
  await flush()
  assert.equal(document.body.querySelector('.v-dialog-overlay'), null, 'disposed dialog removes overlay from body')

  host.remove()
})
