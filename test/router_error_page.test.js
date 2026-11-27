/*
 * router_error_page.test.js — 首 mount 失败的可见错误页与「重试」
 *
 * 背景：布局（layout）挂载失败此前抛穿成 navigation error——整个应用停摆，
 * 屏幕上只剩一片空白（视觉静默空白，违反错误暴露契约）。现在：首 mount
 * 失败降级为整屏可见错误页（错误信息 + 重试 + 重新加载），应用存活。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadSrc, flush } from './harness.js'

const VHTML = await loadSrc()
const { instanceOf } = await import('../src/component-instance.js')
const { setRouterRoutesSource } = await import('../src/router.js')

const fakeHeaders = new Headers()
const page = (cls) =>
  `<!DOCTYPE html><html><head><title>t</title></head><body><div class="${cls}">${cls}</div></body></html>`
const TEMPLATES = {
  '/pg/good.html': page('pg-good'),
  '/layout/default.html': `<!DOCTYPE html><html><head><title>L</title></head><body><div class="lay"><div data-vrouter-outlet></div></div></body></html>`,
  '/layout/broken.html': `<!DOCTYPE html><html><head><title>L</title></head><body><div class="lay"><div data-vrouter-outlet></div></div></body>
<script setup>
throw new Error('layout boom')
</script></html>`,
}
let badPageMissing = true
const baseFetch = globalThis.fetch
const stubFetch = async (url, init) => {
  const u = new URL(String(url), 'http://localhost').pathname
  if (u.endsWith('/pg/bad.html')) {
    if (badPageMissing) {
      return { ok: false, status: 404, headers: fakeHeaders, text: async () => '' }
    }
    return {
      ok: true,
      status: 200,
      headers: fakeHeaders,
      text: async () => page('pg-bad'),
    }
  }
  for (const [key, html] of Object.entries(TEMPLATES)) {
    if (u.endsWith(key)) {
      return { ok: true, status: 200, headers: fakeHeaders, text: async () => html }
    }
  }
  return baseFetch(url, init)
}
globalThis.fetch = stubFetch
window.fetch = stubFetch

async function createRouter(initial, routes) {
  const host = document.createElement('div')
  const vr = document.createElement('vrouter')
  vr.setAttribute('history', 'memory')
  vr.setAttribute('initial', initial)
  host.appendChild(vr)
  setRouterRoutesSource(vr, { routes })
  document.body.appendChild(host)
  const app = new VHTML({ target: host, data: {} })
  await app.ready
  await flush()
  const view = instanceOf(vr)?.runtime?.$sys?.$router
  assert.ok(view && typeof view.push === 'function', 'router view mounted')
  return { app, host, vr, view }
}

const button = (root, label) =>
  [...root.querySelectorAll('button')].find((b) => b.textContent === label)

test('a failing page shows a visible error page with a retry button', async () => {
  badPageMissing = true
  const { app, host } = await createRouter('/bad', [
    { path: '/bad', component: '/pg/bad' },
  ])
  const alert = host.querySelector('[role="alert"]')
  assert.ok(alert, 'error page is rendered instead of a blank screen')
  assert.match(alert.textContent, /页面加载失败/)
  assert.match(alert.textContent, /pg\/bad\.html/)
  const retry = button(alert, '重试')
  assert.ok(retry, 'retry button exists')
  assert.ok(button(alert, '重新加载页面'), 'reload button exists')

  badPageMissing = false
  retry.click()
  await flush(120)
  assert.ok(host.querySelector('.pg-bad'), 'retry re-mounts the page')
  assert.equal(host.querySelector('[role="alert"]'), null, 'error page is gone')
  app.destroy()
})

test('a failing layout shows a visible error page naming the layout', async () => {
  const { app, host } = await createRouter('/l', [
    { path: '/l', component: '/pg/good', layout: 'broken' },
  ])
  const alert = host.querySelector('[role="alert"]')
  assert.ok(alert, 'error page is rendered instead of a blank screen')
  assert.match(alert.textContent, /布局加载失败/)
  assert.match(alert.textContent, /layout\/broken\.html/)
  assert.match(alert.textContent, /layout boom/)
  app.destroy()
})
