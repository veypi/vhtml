import assert from 'node:assert/strict'
import { setupDom, flush } from '../test/harness.js'
setupDom()
const calls = []
const sources = {
  '/modules/demo/env.js': `export default mod => mod.define('base', 40)`,
  '/modules/demo/page.html': `<body><button @click="count++">{{count}}</button><span>{{isolated}}</span><script setup>count = base; isolated = ''.constructor.constructor('return typeof process')(); answer = await (await fetch('/api/value')).json();</script></body>`,
  '/modules/demo/api/value': '{"value":42}',
}
globalThis.fetch = async (input, init) => {
  const path = new URL(String(input), 'http://localhost').pathname
  calls.push(path)
  return new Response(sources[path] || '', { status: path in sources ? 200 : 404, headers: path.startsWith('/modules/demo/') ? { 'vhtml-scoped': '/modules/demo', 'vhtml-unsafe': '' } : {} })
}
const { default: VHTML } = await import('../dist/vhtml.min.js')
const root = document.createElement('div'); document.body.append(root)
const app = new VHTML({ target: root })
try {
  await app.ready
  await app.parseRef('/modules/demo/page', root)
  await flush()
  assert.equal(root.querySelector('button')?.textContent, '40')
  assert.equal(root.querySelector('span')?.textContent, 'undefined')
  root.querySelector('button').dispatchEvent(new Event('click'))
  await flush()
  assert.equal(root.querySelector('button').textContent, '41')
  assert(calls.includes('/modules/demo/api/value'))
  console.log('Built sandbox: header → env → setup → fetch → binding → event passed')
} finally { app.destroy(); app.templateLoader.clear(); root.remove() }
