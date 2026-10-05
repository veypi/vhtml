import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setupDom, flush } from './harness.js'
setupDom()
const { TemplateLoader } = await import('../src/loader.js')
const { ModuleContextManager } = await import('../src/module.js')
const { moduleRecord } = await import('../src/execution/context.js')
const { createRenderContext } = await import('../src/renderer.js')
const { parseRef, instanceOf } = await import('../src/component.js')

const originalFetch = globalThis.fetch

test('header-defined module executes env, setup, bindings and events in one isolated realm', async () => {
  const calls = []
  const files = {
    'http://localhost/modules/demo/env.js': `export default mod => { mod.define('base', 40) }`,
    'http://localhost/modules/demo/page.html': `<script setup>count = base; rows = [{name:'first'},{name:'second'}]; add = () => {count++;rows.unshift({name:'new'})}; leak = ''.constructor.constructor('return typeof document.__hostSecret')();</script><button @click="add">{{count}}</button><p>{{leak}}</p><ul><li v-for="item in rows">{{item.name}}</li></ul>`,
  }
  globalThis.fetch = async (url, options) => {
    url = new URL(url, 'http://localhost').href
    calls.push({ url, options })
    return new Response(files[String(url)] || '', { status: String(url) in files ? 200 : 404, headers: { 'vhtml-scoped': '/modules/demo', 'vhtml-unsafe': '' } })
  }
  const manager = new ModuleContextManager(), loader = new TemplateLoader(manager), host = document.createElement('div')
  document.body.append(host)
  let mod
  try {
    const descriptor = await loader.fetchUI('/modules/demo/page.html')
    mod = descriptor.mod
    assert.equal(moduleRecord(mod).meta.unsafe, true)
    assert.equal(mod.base, 40)
    const ctx = createRenderContext({})
    await parseRef(descriptor.url, host, {}, {}, { target: descriptor }, ctx)
    await flush()
    assert.equal(instanceOf(host)._error, null)
    assert.equal(host.querySelector('button').textContent, '40')
    assert.equal(host.querySelector('p').textContent, 'undefined')
    const first = host.querySelector('li')
    host.querySelector('button').dispatchEvent(new Event('click'))
    await flush()
    assert.equal(host.querySelector('button').textContent, '41')
    assert.equal(host.querySelectorAll('li')[1], first)
    assert.equal(calls.length, 2)
    instanceOf(host).scope.dispose(host)
  } finally { if (mod) moduleRecord(mod).execution.dispose(); host.remove(); globalThis.fetch = originalFetch }
})

test('body attribute expressions stay with their authoring module and first policy remains immutable', async () => {
  const manager = new ModuleContextManager(), loader = new TemplateLoader(manager)
  const host = document.createElement('div'); document.body.append(host)
  const source = `<body :title="''.constructor.constructor('return typeof process')()"><p>safe</p></body>`
  globalThis.fetch = async input => {
    const path = new URL(input, 'http://localhost').pathname
    const headers = new Headers({ 'vhtml-scoped': '/modules/demo', 'vhtml-unsafe': '' })
    return new Response(path.endsWith('env.js') ? 'export default mod => { mod.$mod = {scoped:""} }' : source, { headers })
  }
  let record
  try {
    const descriptor = await loader.fetchUI('/modules/demo/a.html')
    record = moduleRecord(descriptor.mod)
    assert.equal(record.meta.unsafe, true)
    const ctx = createRenderContext({})
    await parseRef(descriptor.url,host,{}, {},{target:descriptor},ctx)
    await flush()
    assert.equal(host.getAttribute('title'), 'undefined')
    await assert.rejects(loader.fetchUI('@/secret.html', {$mod:descriptor.mod}), /forbidden/)
    assert.throws(() => { descriptor.mod.scoped = '/other' }, /readonly/)
    const initial = manager.moduleMetadata.get('/modules/demo')
    // A cache refresh preserves the first immutable policy record; no policy reconciliation.
    loader.clearScoped('/modules/demo')
    assert.equal(manager.moduleMetadata.get('/modules/demo'), initial)
    instanceOf(host).scope.dispose(host)
  } finally {record?.execution.dispose();host.remove();globalThis.fetch=originalFetch}
})

test('DOM handles and events expose only the module document and Window', async () => {
  const manager = new ModuleContextManager(), loader = new TemplateLoader(manager)
  const host = document.createElement('div'); document.body.append(host)
  globalThis.fetch = async input => new Response(String(input).endsWith('env.js') ? 'export default mod => {}' : `<body><button ref="button" @click="inspect">test</button><p>{{result}}</p><script setup>result='';inspect = event => { result = [$refs.button.ownerDocument === document, event.target.ownerDocument.defaultView === window, $node.parentElement === null, event.target === $refs.button].join(':') }</script></body>`, { headers: {'vhtml-scoped':'/modules/demo','vhtml-unsafe':''} })
  let record
  try {
    const descriptor=await loader.fetchUI('/modules/demo/dom.html'); record=moduleRecord(descriptor.mod)
    await parseRef(descriptor.url,host,{}, {},{target:descriptor},createRenderContext({}))
    host.querySelector('button').dispatchEvent(new Event('click'));await flush()
    assert.equal(host.querySelector('p').textContent,'true:true:true:true')
    instanceOf(host).scope.dispose(host)
  } finally { record?.execution.dispose();host.remove();globalThis.fetch=originalFetch }
})
