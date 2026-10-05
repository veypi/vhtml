import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ModuleResources, readModuleMeta } from '../src/resource.js'

const meta = { scoped: '/modules/demo', origin: 'https://app.test', unsafe: true }
const resources = () => new ModuleResources(meta, { fetch: async () => new Response('ok') })

test('module network APIs share module-root resolution and websocket origin', () => {
  const r = resources()
  for (const url of ['/api/list', 'api/list']) assert.equal(r.resolve(url).href, 'https://app.test/modules/demo/api/list')
  assert.equal(r.resolve('/api/ws', { socket: true }).href, 'wss://app.test/modules/demo/api/ws')
  assert.equal(r.resolve('./helper.js', { from: 'https://app.test/modules/demo/page/main.js' }).href, 'https://app.test/modules/demo/page/helper.js')
  assert.equal(r.resolve('../lib.js', { from: 'https://app.test/modules/demo/page/main.js' }).href, 'https://app.test/modules/demo/lib.js')
})

test('every accepted URL input is checked after normalization', () => {
  const r = resources()
  for (const url of ['@/api/root', ' @/api/root', '../private', '/../../private', '/%2e%2e/private', '/%252e%252e/private', '/a%2fb', '//other.test/x', '/\\other.test/x', 'https://other.test/x', 'https://app.test/modules/demo2/x', 'https://u:p@app.test/modules/demo/x', 'data:text/plain,x', 'blob:https://app.test/id', new URL('https://other.test/x'), new Request('https://other.test/x')]) {
    assert.throws(() => r.resolve(url), /forbidden|outside|ambiguous/, String(url))
  }
  assert.equal(r.resolve(new Request('https://app.test/modules/demo/x')).href, 'https://app.test/modules/demo/x')
  assert.throws(() => r.resolve('ws://app.test/modules/demo/ws', { socket: true }), /outside/)
})

test('resolved records prevent double-prefixing and cross-module reuse', () => {
  const r = resources()
  const resolved = r.resolve('/api/list')
  assert.equal(r.resolve(resolved), resolved)
  assert.throws(() => resources().resolve(resolved), /foreign resource/)
})

test('header presence is read at discovery, before module initialization', () => {
  const url = 'https://app.test/modules/demo/index.html'
  for (const value of ['', '1', 'false']) {
    const metadata = readModuleMeta(new Response('', { headers: { 'vhtml-scoped': '/modules/demo', 'vhtml-unsafe': value } }), url)
    assert.equal(metadata.unsafe, true)
    assert.equal(Object.isFrozen(metadata), true)
  }
  assert.throws(() => readModuleMeta(new Response('', { headers: { 'vhtml-unsafe': '1' } }), url), /requires/)
})

test('unsafe transport forces redirect:error and owns request cancellation', async () => {
  let seen
  const r = new ModuleResources(meta, { fetch: async (url, init) => { seen = { url, init }; return new Response('ok') } })
  const lease = await r.open('/api/x', { redirect: 'follow' })
  assert.equal(seen.init.redirect, 'error')
  assert.equal(r.pending, 1)
  r.dispose()
  assert.equal(seen.init.signal.aborted, true)
  assert.equal(r.pending, 0)
  lease.release()
  await assert.rejects(r.open('/api/x'), /disposed/)
})

test('completed and failed body reads release transport ownership', async () => {
  const r = resources()
  assert.equal(await r.text('/api/x'), 'ok')
  assert.equal(r.pending, 0)
  const broken = new ModuleResources(meta, { fetch: async () => new Response(new ReadableStream({start(controller) {controller.error(new Error('broken body'))}})) })
  await assert.rejects(broken.text('/api/x'), /broken body/)
  assert.equal(broken.pending, 0)
})
