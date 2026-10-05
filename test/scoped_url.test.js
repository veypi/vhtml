/* Resources and module fetch share URL resolution, including data/blob protocols. */

import { test } from 'node:test'
import assert from 'node:assert'
import { setupDom } from './harness.js'

setupDom()

const { resourceKey } = await import('../src/resource.js')
const { createModuleContext } = await import('../src/module.js')

const DATA = 'data:image/jpeg;base64,/9j/4AAQSkZJRg'
const SCOPE = '/skills/local/demo'

test('resourceKey：data: 透传不前缀化', () => {
  const url = resourceKey(DATA, SCOPE)
  assert.equal(url, DATA)
})

test('模块 mod.fetch：data: 透传不前缀化', async () => {
  let captured = null
  const orig = globalThis.fetch
  globalThis.fetch = (u) => { captured = u; return Promise.resolve({ ok: true }) }
  try {
    const mod = createModuleContext(SCOPE, null)
    await mod.fetch(DATA)
    assert.equal(captured, DATA)
  } finally {
    globalThis.fetch = orig
  }
})

test('模块 mod.fetch：http(s)/blob: 透传与相对路径 scoped 不受影响', async () => {
  let captured = null
  const orig = globalThis.fetch
  globalThis.fetch = (u) => { captured = u; return Promise.resolve({ ok: true }) }
  try {
    const mod = createModuleContext(SCOPE, null)
    await mod.fetch('blob:http://localhost/abc')
    assert.equal(captured, 'blob:http://localhost/abc')
    await mod.fetch('https://cdn.example.com/x.js')
    assert.equal(captured, 'https://cdn.example.com/x.js')
    await mod.fetch('/x')
    assert.equal(captured, 'http://localhost' + SCOPE + '/x')
  } finally {
    globalThis.fetch = orig
  }
})

test('data:text/html 在 fetch 层与 blob: 同语义透传（安全拦截在模板属性层 sanitizeUrl，不在 loader）', () => {
  // loader/mod.fetch 是运行时显式 fetch 调用（非注入面），lexical 层面与 blob: 同级；
  // 模板静态属性（img src 等）经 compiler-attrs resolveResourceUrl → sanitizeUrl 拦截
  // data:text/html（DANGEROUS_DATA_URL_RE）→ about:blank，本修复未触及该层。
  const u = resourceKey(
    'data:text/html,<script>alert(1)</script>', SCOPE)
  assert.equal(u, 'data:text/html,<script>alert(1)</script>')
})
