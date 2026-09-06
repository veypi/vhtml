/*
 * scoped_url.test.js — scoped URL 透传协议（data: 补全）
 *
 * 覆盖：data: 协议在 scoped URL 解析三处（loader resolveUrl→normalizeFetchUrl→
 * resolveScopedUrl / 模块 mod.fetch / restrictedFetch）一律透传——data: 是内联
 * 资源协议（img src、fetch(dataURL)），前缀化会把它变成包内相对路径请求。
 * 安全语义不变：sanitizeUrl 仍拦截 data:text/html（防 html 注入）。
 */

import { test } from 'node:test'
import assert from 'node:assert'
import { setupDom } from './harness.js'

setupDom()

const { templateLoader } = await import('../src/loader.js')
const { createModuleContext } = await import('../src/module.js')

const DATA = 'data:image/jpeg;base64,/9j/4AAQSkZJRg'
const SCOPE = '/skills/local/demo'

test('loader resolveUrl：data: 透传不前缀化', () => {
  const url = templateLoader.resourceLoader.resolveUrl(DATA, SCOPE)
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

test('模块 restrictedFetch：data: 透传不 scope 不拦截', async () => {
  let captured = null
  const orig = globalThis.fetch
  globalThis.fetch = (u) => { captured = u; return Promise.resolve({ ok: true }) }
  try {
    const mod = createModuleContext(SCOPE, null)
    await mod.restrictedFetch(DATA)
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
    assert.equal(captured, SCOPE + '/x')
  } finally {
    globalThis.fetch = orig
  }
})

test('data:text/html 在 fetch 层与 blob: 同语义透传（安全拦截在模板属性层 sanitizeUrl，不在 loader）', () => {
  // loader/mod.fetch 是运行时显式 fetch 调用（非注入面），lexical 层面与 blob: 同级；
  // 模板静态属性（img src 等）经 compiler-attrs resolveScopedUrl → sanitizeUrl 拦截
  // data:text/html（DANGEROUS_DATA_URL_RE）→ about:blank，本修复未触及该层。
  const u = templateLoader.resourceLoader.resolveUrl(
    'data:text/html,<script>alert(1)</script>', SCOPE)
  assert.equal(u, 'data:text/html,<script>alert(1)</script>')
})
