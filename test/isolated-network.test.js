import { test } from 'node:test'
import assert from 'node:assert/strict'
import { IsolatedExecutor } from '../src/execution/isolated.js'
import { ModuleResources } from '../src/resource.js'
import { installNetwork } from '../src/execution/network.js'

async function network(transport, extra) {
  const requests = []
  const resources = new ModuleResources({ origin: 'https://app.test', scoped: '/modules/demo', unsafe: true }, {
    fetch: async (url, options) => { requests.push({ url, options }); return transport ? transport(url, options) : new Response('{"ok":true}', { headers: { 'Content-Type': 'application/json' } }) },
  })
  const vm = await IsolatedExecutor.create(resources)
  const disposeNetwork = installNetwork(vm, resources, extra), scope = vm.createScope()
  return { vm, scope, requests, dispose() { disposeNetwork(); vm.dispose() } }
}

test('fetch and Request preserve familiar methods with scoped URLs and guest-only responses', async () => {
  const context = await network(), { vm, scope, requests } = context
  try {
    await vm.execute(`const request = new Request('/api/xxx', {method:'POST', body:'data'}); const response = await fetch(request); result = await response.json(); isolated = response.constructor.constructor('return globalThis')() === window`, scope)
    assert.deepEqual(vm.evaluate('result', scope), { ok: true })
    assert.equal(vm.evaluate('isolated', scope), true)
    assert.equal(requests[0].url, 'https://app.test/modules/demo/api/xxx')
    assert.equal(requests[0].options.method, 'POST')
    assert.equal(requests[0].options.body, 'data')
    assert.equal(requests[0].options.redirect, 'error')
    for (const url of ['@/secret', 'https://evil.test/a', '../other/a', '/%2e%2e/secret']) {
      await assert.rejects(vm.execute(`await fetch(${JSON.stringify(url)})`, scope), /forbidden|outside/)
    }
    assert.equal(requests.length, 1)
  } finally { context.dispose() }
})

test('XHR events and callbacks only contain guest objects', async () => {
  const context = await network(), { vm, scope } = context
  try {
    await vm.execute(`answer = await new Promise((resolve, reject) => { const xhr = new XMLHttpRequest(); xhr.open('GET', '/api/data'); xhr.responseType = 'json'; xhr.onload = function(e) { resolve([this === xhr, e.target === xhr, xhr.response.ok, e.constructor.constructor('return typeof document')()]); }; xhr.onerror = reject; xhr.send(); })`, scope)
    assert.deepEqual(vm.evaluate('answer', scope), [true, true, true, 'undefined'])
    assert.throws(() => vm.evaluate(`new XMLHttpRequest().open('GET', '@/private')`, scope), /forbidden/)
  } finally { context.dispose() }
})

test('WebSocket uses the same resource policy and copies messages', async () => {
  let socket
  class FakeSocket {
    constructor(url) { this.url = url; this.protocol = ''; this.extensions = ''; this.bufferedAmount = 0; socket = this }
    send(value) { this.sent = value }
    close() { this.closed = true }
  }
  const context = await network(null, { WebSocket: FakeSocket }), { vm, scope } = context
  try {
    await vm.execute(`socket = new WebSocket('/api/live'); socket.onmessage = function(e) { result = [this === socket, e.target === socket, e.data, typeof e.target.ownerDocument] }`, scope)
    assert.equal(socket.url, 'wss://app.test/modules/demo/api/live')
    socket.onopen()
    socket.onmessage({ data: 'hello' })
    assert.deepEqual(vm.evaluate('result', scope), [true, true, 'hello', 'undefined'])
    vm.evaluate(`socket.send('hi')`, scope)
    assert.equal(socket.sent, 'hi')
    assert.throws(() => vm.evaluate(`new WebSocket('wss://evil.test')`, scope), /outside/)
  } finally { context.dispose() }
  assert.equal(socket.closed, true)
})

test('EventSource parses chunks and sends scoped reconnect credentials; beacon stays bounded', async () => {
  const context = await network(() => new Response('event: update\ndata: one\ndata: two\nid: 9\n\n', { headers: { 'Content-Type': 'text/event-stream' } })), { vm, scope, requests } = context
  try {
    await vm.execute(`message = await new Promise(resolve => { const source = new EventSource('/api/events'); source.addEventListener('update', e => { source.close(); resolve([e.data, e.lastEventId, e.target === source]) }) })`, scope)
    assert.deepEqual(vm.evaluate('message', scope), ['one\ntwo', '9', true])
    assert.equal(requests[0].url, 'https://app.test/modules/demo/api/events')
    assert.equal(vm.evaluate(`navigator.sendBeacon('/api/beacon', 'hi')`, scope), true)
    assert.equal(vm.evaluate(`navigator.sendBeacon('/api/beacon', 'x'.repeat(65537))`, scope), false)
    assert.throws(() => vm.evaluate(`navigator.sendBeacon('@/secret')`, scope), /forbidden/)
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.equal(requests[1].url, 'https://app.test/modules/demo/api/beacon')
    assert.equal(requests[1].options.redirect, 'error')
  } finally { context.dispose() }
})

test('virtual location and URL are guest data; URL parsing never grants a network capability', async () => {
  const f = await network()
  try {
    const {vm,scope}=f
    assert.equal(vm.evaluate('location.href',scope),'https://app.test/modules/demo/')
    assert.equal(vm.evaluate("location.constructor.constructor('return globalThis')()===window",scope),true)
    await vm.execute(`url=new URL('/api/data',location);params=url.searchParams;params.append('a','1');url.search='?b=2';params.append('c','3');answer=[url.href,params===url.searchParams,params.get('b'),URL.canParse('bad url')];`,scope)
    assert.deepEqual(vm.evaluate('answer',scope),['https://app.test/api/data?b=2&c=3',true,'2',false])
    await assert.rejects(vm.execute(`await fetch(new URL('https://other.test/private'))`,scope),/outside/)
    assert.equal(f.requests.length,0)
    await vm.execute(`await fetch(new URL('./api/data',location))`,scope)
    assert.equal(f.requests[0].url,'https://app.test/modules/demo/api/data')
  } finally {f.dispose()}
})
