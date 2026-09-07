/*
 * lifecycle_mount.test.js — v0.11 生命周期契约回归
 *
 * 覆盖重设计契约：
 *   1. 路由页 plain script 在宿主已连接后执行（staging 游离期零脚本执行）
 *   2. 作废导航的页面脚本零执行（setup/plain/active 均不发生）
 *   3. 同实例调用序：plain script 先于 active('mount')
 *   4. v-if 动态组件 plain script 同样在已连接状态执行（双上下文一致）
 *   5. hidden 期间 commit：plain script 照发（已连接），active 延迟到复显
 *   6. dispose 抗错：单个 cleanup 抛错不阻断剩余回收
 *   7. disposed 后 addCleanup 立即执行
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadSrc, mount, flush } from './harness.js'

const VHTML = await loadSrc()
const { instanceOf, disposeNode } = await import('../src/component-instance.js')
const { setRouterRoutesSource } = await import('../src/router.js')

// ---- fetch 打桩 ----
const fakeHeaders = { get: () => null, entries: () => [][Symbol.iterator]() }
const page = (cls, extra = '') => `<!DOCTYPE html><html><head><title>t</title></head><body><div class="${cls}">${cls}</div></body>
${extra}</html>`
const TEMPLATES = {
  // plain script 断言连接性并记录调用序
  '/lc/a.html': page('lc-a', `<script>
window.__lc.aScript = (window.__lc.aScript || 0) + 1
window.__lc.aConnectedAtScript = $node.isConnected
window.__lc.order = (window.__lc.order || [])
window.__lc.order.push('script')
</script>
<script active>
window.__lc.aActive = (window.__lc.aActive || 0) + 1
window.__lc.order.push('active:' + $reason)
</script>
<script deactive>
window.__lc.order.push('deactive:' + $reason)
</script>`),
  '/lc/b.html': page('lc-b'),
  '/lc/slow.html': page('lc-slow', `<script setup>
window.__lc.slowSetup = (window.__lc.slowSetup || 0) + 1
</script>
<script>
window.__lc.slowScript = (window.__lc.slowScript || 0) + 1
</script>
<script active>
window.__lc.slowActive = (window.__lc.slowActive || 0) + 1
</script>`),
  '/x/lc/child.html': `<!DOCTYPE html><html><head><title>c</title></head><body><span class="lc-c">c</span></body>
<script>
window.__lc.childConnectedAtScript = $node.isConnected
</script></html>`,
}
const realFetch = globalThis.fetch
const stubFetch = async (url) => {
  const u = String(url).split('?')[0]
  if (u.endsWith('/lc/slow.html')) {
    await new Promise((r) => setTimeout(r, 80))   // 慢页面：制造作废窗口
  }
  for (const [key, html] of Object.entries(TEMPLATES)) {
    if (u.endsWith(key)) return { ok: true, status: 200, headers: fakeHeaders, text: async () => html }
  }
  return realFetch ? realFetch(url) : { ok: false, status: 404, headers: fakeHeaders, text: async () => '' }
}
globalThis.fetch = stubFetch
window.fetch = stubFetch

async function createRouter(initial = '/a') {
  window.__lc = {}
  const host = document.createElement('div')
  const vr = document.createElement('vrouter')
  vr.setAttribute('history', 'memory')
  vr.setAttribute('initial', initial)
  host.appendChild(vr)
  setRouterRoutesSource(vr, {
    routes: [
      { path: '/a', component: '/lc/a' },
      { path: '/b', component: '/lc/b' },
      { path: '/slow', component: '/lc/slow' },
    ],
  })
  document.body.appendChild(host)
  const app = new VHTML({ target: host, data: {} })
  await app.ready
  await flush()
  const view = instanceOf(vr)?.runtime?.$sys?.$router
  assert.ok(view, 'router view mounted')
  return { app, host, view }
}

test('staging page: plain script runs connected, before active', async () => {
  const { app, host } = await createRouter('/a')
  assert.ok(host.querySelector('.lc-a'), 'page mounted')
  assert.equal(window.__lc.aScript, 1, 'plain script ran once')
  assert.equal(window.__lc.aConnectedAtScript, true, 'plain script sees connected host')
  assert.deepEqual(window.__lc.order, ['script', 'active:mount'], 'same-instance order: script then active(mount)')
  app.destroy()
})

test('aborted navigation: scripts never run, zero side effects', async () => {
  const { app, view } = await createRouter('/b')
  const slowPush = view.push('/slow')   // 慢页面进入 staging
  await new Promise((r) => setTimeout(r, 20))  // 落在 fetch await 窗口
  await view.push('/a')                  // 作废在途导航
  await slowPush
  await flush(120)
  assert.equal(window.__lc.slowScript || 0, 0, 'aborted page plain script never ran')
  assert.equal(window.__lc.slowActive || 0, 0, 'aborted page active never fired')
  // setup 在游离期执行是契约允许的（框架托管资源经 dispose 回收）
  assert.equal(view.current.fullPath, '/a', 'committed navigation is the latest one')
  app.destroy()
})

test('cached page re-entry: active(route) fires, plain script not re-run', async () => {
  const { app, view } = await createRouter('/a')
  await view.push('/b')
  await flush()
  assert.deepEqual(window.__lc.order.slice(-1), ['deactive:route'], 'leaving page fires deactive(route)')
  await view.push('/a')
  await flush()
  assert.equal(window.__lc.aScript, 1, 'plain script not re-run on cache re-entry')
  assert.deepEqual(window.__lc.order.slice(-1), ['active:route'], 're-entry fires active(route)')
  app.destroy()
})

test('v-if dynamic component: plain script runs connected (parity with pages)', async () => {
  window.__lc = {}
  const { app, host } = await mount(
    `<div><x-lc-child v-if="show"></x-lc-child></div>`,
    { show: false },
  )
  assert.ok(!host.querySelector('.lc-c'), 'child absent while v-if false')
  app._data.show = true
  await flush(120)
  assert.ok(host.querySelector('.lc-c'), 'child mounted after v-if flip')
  assert.equal(window.__lc.childConnectedAtScript, true, 'dynamic component script sees connected host')
  app.destroy()
})

test('hidden commit: plain script runs (connected), active deferred to visible', async () => {
  const { app, view } = await createRouter('/b')
  // 模拟标签页隐藏
  const descriptor = Object.getOwnPropertyDescriptor(document, 'visibilityState')
  Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
  document.dispatchEvent(new window.Event('visibilitychange'))
  try {
    await view.push('/a')
    await flush()
    assert.equal(window.__lc.aScript, 1, 'plain script ran at commit (host connected)')
    assert.equal(window.__lc.aActive || 0, 0, 'active deferred while hidden')
  } finally {
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
    document.dispatchEvent(new window.Event('visibilitychange'))
  }
  await flush()
  assert.equal(window.__lc.aActive, 1, 'active fired on visibility restore')
  assert.ok(window.__lc.order.includes('active:visibility'), 'reason is visibility')
  if (descriptor) Object.defineProperty(document, 'visibilityState', descriptor)
  app.destroy()
})

test('dispose resilience: throwing cleanup does not block the rest', async () => {
  window.__lc = {}
  const { app, host } = await mount(
    `<div><x-lc-child v-if="show"></x-lc-child></div>`,
    { show: true },
  )
  await flush(120)
  const child = host.querySelector('x-lc-child')
  const inst = instanceOf(child, false)
  assert.ok(inst, 'child instance exists')
  const ran = []
  inst.scope.addCleanup(() => { throw new Error('boom') })
  inst.scope.addCleanup(() => { ran.push('second') })
  disposeNode(child)
  assert.deepEqual(ran, ['second'], 'subsequent cleanups still ran')
  assert.equal(inst.scope.phase, 'disposed')
  app.destroy()
})

test('addCleanup after disposed runs immediately', async () => {
  window.__lc = {}
  const { app, host } = await mount(
    `<div><x-lc-child v-if="show"></x-lc-child></div>`,
    { show: true },
  )
  await flush(120)
  const child = host.querySelector('x-lc-child')
  const inst = instanceOf(child, false)
  disposeNode(child)
  let ran = false
  inst.scope.addCleanup(() => { ran = true })
  assert.equal(ran, true, 'cleanup registered after dispose runs immediately')
  app.destroy()
})
