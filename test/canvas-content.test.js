/*
 * 宿主提供的 .content 属性不能带偏模板标记。
 *
 * Chromium 157 给 HTMLCanvasElement 加了 content getter（返回字符串 "fallback"），
 * <meta> 的 content 是属性字符串，<iframe> 的 content 是 Document —— 模板标记曾用
 * `(node.content || node)` 取子树，真值判断会让这些元素走错分支：childNodes 变成
 * undefined → "is not iterable" → 组件挂载直接抛错（见 ai/chat/camera）。
 *
 * 契约：只有 DocumentFragment（nodeType 11，即 <template> 的 content）才取 content，
 * 其余元素一律用自己的 childNodes。
 */
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { setupDom } from './harness.js'
setupDom()
const { TemplateLoader } = await import('../src/loader.js')
const { ModuleContextManager } = await import('../src/module.js')

// 复刻 Chromium 157：canvas.content → "fallback"（真值字符串）
const canvasProto = Object.getPrototypeOf(document.createElement('canvas'))
Object.defineProperty(canvasProto, 'content', {
  configurable: true,
  get() { return 'fallback' },
})

const PAGE = `<body>
  <div class="wrap">
    <canvas id="c"></canvas>
    <meta name="description" content="AI Camera" />
    <i class="btn"></i>
  </div>
  <template><b>nested</b></template>
</body>`

let loader
const originalFetch = globalThis.fetch

beforeEach(() => {
  loader = new TemplateLoader(new ModuleContextManager())
  globalThis.fetch = async (input) => {
    const url = new URL(String(input))
    if (url.pathname.endsWith('/env.js')) return new Response('', { status: 404 })
    return new Response(PAGE, { headers: { 'vhtml-scoped': '/pkg' } })
  }
})
afterEach(() => {
  loader.clear()
  globalThis.fetch = originalFetch
})

test('host-provided content getters do not break template marking', async () => {
  const descriptor = await loader.fetchUI('/pkg/page.html')
  const ref = '/pkg/page'
  assert.equal(descriptor.body.querySelector('canvas').getAttribute('vrefof'), ref)
  assert.equal(descriptor.body.querySelector('meta').getAttribute('vrefof'), ref)
  assert.equal(descriptor.body.querySelector('i').getAttribute('vrefof'), ref)
  // <template> 的子树仍走 content（DocumentFragment）
  assert.equal(
    descriptor.body.querySelector('template').content.firstElementChild.getAttribute('vrefof'),
    ref
  )
})
