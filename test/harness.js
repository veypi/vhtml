/*
 * harness.js — 挂载级共享测试床（v0.10.0 第一交付物）
 *
 * node --test 每个测试文件独立进程；同文件内多次引用幂等。
 * src 模块加载期即触碰 window/document（index.js 末尾 window.VHTML、
 * reactive.js 调度绑定），必须先装全局再动态 import src —— 所有 src
 * 导入统一走 loadSrc()，禁止在本文件顶层 import src。
 *
 * 场景覆盖（响应式重写的行为基线）：挂载、v-for、props 链、
 * copyBind 语义快照；路由级场景在后续版本 harness 扩展。
 */
import { Window } from 'happy-dom'

const GLOBAL_KEYS = [
  'Node', 'Element', 'HTMLElement', 'SVGElement',
  'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLSelectElement',
  'Text', 'Comment', 'DocumentFragment',
  'Event', 'CustomEvent', 'MutationObserver',
  'NodeFilter', 'localStorage', 'getComputedStyle', 'history', 'DOMParser',
]

let domReady = false
let srcModules = null

export function setupDom() {
  if (domReady) return
  domReady = true
  const win = new Window({ url: 'http://localhost/' })
  for (const key of GLOBAL_KEYS) {
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
}

/** src/index.js 默认导出（每测试进程一份；必须在 setupDom 之后首次调用） */
export async function loadSrc() {
  setupDom()
  if (!srcModules) srcModules = (await import('../src/index.js')).default
  return srcModules
}

/** 响应式冲刷走 rAF 批量；reconcile 内写入会再排一帧 */
export const flush = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms))

/** 挂载一段模板并等待首轮编译 + 冲刷完成 */
export async function mount(template, data) {
  const VHTML = await loadSrc()
  const host = document.createElement('div')
  host.innerHTML = template
  document.body.appendChild(host)
  const app = new VHTML({ target: host, data: data || {} })
  await app.ready
  await flush()
  return { app, host }
}

export const texts = (root, sel) => [...root.querySelectorAll(sel)].map((n) => n.textContent)
