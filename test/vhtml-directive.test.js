/*
 * vhtml-directive.test.js — v-html 的元素约束
 *
 * v-html 只在 <div> 上生效：写在 <span>/<li> 等元素上时，属性会原样留在 DOM 上，
 * 内容永远不渲染，而且没有任何提示（提示条只剩文字、图标消失就是这么来的）。
 * 框架现在对非 div 直接报错，不留静默空白。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setupDom, loadSrc, flush } from './harness.js'
import { setSanitizedHTML } from '../src/html-sanitize.js'

setupDom()
const VHTML = await loadSrc()

async function mount(html) {
  const host = document.createElement('div')
  document.body.append(host)
  const app = new VHTML({ target: host })
  await app.ready
  const error = await app
    .parseRaw(host, {}, {}, html)
    .then(() => null, (e) => e)
  return { host, app, error }
}

test('v-html on a non-div element fails loudly', async () => {
  const { host, app, error } = await mount(
    '<body><span v-html="content"></span></body>'
  )
  try {
    assert.ok(error, '编译必须报错，不能静默留空')
    assert.match(String(error.message || error), /v-html 只能用在 <div>/)
    // 错误可见：不是一片空白
    assert.match(host.textContent, /v-html/)
  } finally {
    app.destroy()
    host.remove()
  }
})

test('v-html on a non-div element inside v-for also fails', async () => {
  const { host, app, error } = await mount(
    '<body><ul><li v-for="p in list" v-html="p"></li></ul><script setup>list = ["a"]</script></body>'
  )
  try {
    assert.ok(error, 'v-for 克隆出来的元素同样要报错')
    assert.match(String(error.message || error), /v-html 只能用在 <div>/)
  } finally {
    app.destroy()
    host.remove()
  }
})

test('native Sanitizer API writes through setHTML', async () => {
  let received = null
  const dom = {
    setHTML(value) {
      received = value
    },
  }
  await setSanitizedHTML(dom, '<b>safe</b><script>bad</script>')
  assert.equal(received, '<b>safe</b><script>bad</script>')
  await setSanitizedHTML(dom, null)
  assert.equal(received, '')
})

test('v-html on a div still renders', async () => {
  const { host, app, error } = await mount(
    '<body><div v-html="html"></div><script setup>html = "<b>ok</b>"</script></body>'
  )
  try {
    assert.equal(error, null)
    await flush(5)
    assert.equal(host.querySelector('div').innerHTML, '<b>ok</b>')
  } finally {
    app.destroy()
    host.remove()
  }
})
