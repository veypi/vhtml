/*
 * lifecycle.test.js — v0.10.1 生命周期确定性回归
 *
 * 覆盖 todo 清单：显式 dispose 后兜底不二次触发（dispose 计数）；外部
 * el.remove() 仍被兜底回收（含 dev 警告）；keepOnDetach 节点移除后存活、
 * 重插后 activate；同帧移动（remove+insert）不误销；dispose 幂等；
 * 异步挂载：await 期间被 dispose 后 token 失效、无孤儿挂载。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadSrc, mount, flush, texts } from './harness.js'

await loadSrc()
const { Wrap } = await import('../src/reactive.js')
const { instanceOf, disposeNode, disposeRuntimeSubtree } = await import('../src/component-instance.js')

// ---- fetch 打桩：测试组件模板 ----
const fakeHeaders = { get: () => null, entries: () => [][Symbol.iterator]() }
const TEMPLATES = {
  '/x/child.html': `<!DOCTYPE html><html><head><title>c</title></head><body><span class="c">{{ msg }}</span></body>
<script setup>
msg = 'm'
</script></html>`,
  '/x/keep.html': `<!DOCTYPE html><html><head><title>k</title></head><body><span class="k">kept</span></body></html>`,
}
// 慢组件单独走延迟分支：不能进 endsWith 速查表（否则立即返回，dispose
// 落不到 fetch await 窗口内，第 6 个测试的竞态场景就 never 发生）
const SLOW_HTML = `<!DOCTYPE html><html><head><title>s</title></head><body><div class="slow">{{ msg }}</div></body>
<script setup>
msg = 'loaded'
</script></html>`
const realFetch = globalThis.fetch
const stubFetch = async (url) => {
  const u = String(url).split('?')[0]
  if (u.endsWith('/x/slow.html')) {
    await new Promise((r) => setTimeout(r, 120))   // 慢组件：dispose 需落在 fetch await 期间
    return { ok: true, status: 200, headers: fakeHeaders, text: async () => SLOW_HTML }
  }
  for (const [key, html] of Object.entries(TEMPLATES)) {
    if (u.endsWith(key)) return { ok: true, status: 200, headers: fakeHeaders, text: async () => html }
  }
  return realFetch ? realFetch(url) : { ok: false, status: 404, headers: fakeHeaders, text: async () => '' }
}
globalThis.fetch = stubFetch
window.fetch = stubFetch

// MO 异步 + rAF：兜底路径需要两帧以上
const settleMO = () => flush(120)

test('explicit dispose then observer fallback: no double dispose, no warning', async () => {
  const { app, host } = await mount(
    `<ul><li v-for="o in list">{{ o.name }}</li></ul>`,
    { list: [{ name: 'a' }, { name: 'b' }] },
  )
  const warns = []
  const origWarn = console.warn
  console.warn = (...args) => { warns.push(String(args[0] || '')) }

  const li = host.querySelector('li')
  const inst = instanceOf(li, false) || instanceOf(li)
  // v-for 条目宿主 li 自身无实例（实例在注释范围的外层），取子树内组件态：
  // 此模板 li 无子组件，disposeRuntimeSubtree 应清理插值 watcher（meta）
  disposeNode(li)          // 显式销毁（幂等起点）
  const again = disposeNode(li)  // 幂等：无内容可清
  assert.equal(again, false, 'second dispose is a no-op')

  li.remove()              // 显式销毁后移除 → MO 兜底空转
  await settleMO()
  console.warn = origWarn
  const fallbackWarns = warns.filter((w) => w.includes('observer fallback'))
  assert.equal(fallbackWarns.length, 0, 'explicitly disposed nodes must not trigger fallback warning')
  app.destroy()
})

test('external el.remove() of unmarked DOM: collected silently, no warning', async () => {
  const { app, host } = await mount(
    `<div><x-child v-for="o in list" :msg="o.name"></x-child></div>`,
    { list: [{ name: 'a' }] },
  )
  const warns = []
  const origWarn = console.warn
  console.warn = (...args) => { warns.push(String(args[0] || '')) }
  const child = host.querySelector('x-child')
  assert.ok(child, 'component mounted')
  const inst = instanceOf(child, false)
  assert.ok(inst, 'component instance exists')

  // 剥离标记模拟非模板衍生、外部自管的 DOM（如三方库容器、v-html 注入内容）
  child.removeAttribute('vref')
  child.removeAttribute('vrefof')
  child.remove()           // 外部移除：不走 disposeNode，无标记则静默回收
  await settleMO()
  console.warn = origWarn

  assert.equal(instanceOf(child, false), null, 'instance purged via fallback')
  assert.equal(inst.scope.state, 'disposed', 'scope disposed via fallback')
  const fallbackWarns = warns.filter((w) => w.includes('observer fallback'))
  assert.equal(fallbackWarns.length, 0, 'unmarked DOM removal is silent (third-party noise gate)')
  app.destroy()
})

test('external el.remove() of vhtml-marked DOM: collected with warning', async () => {
  const { app, host } = await mount(
    `<div><x-child v-for="o in list" :msg="o.name"></x-child></div>`,
    { list: [{ name: 'a' }] },
  )
  const warns = []
  const origWarn = console.warn
  console.warn = (...args) => { warns.push(String(args[0] || '')) }
  const child = host.querySelector('x-child')
  // 组件宿主天然携带 vref（加载器从模板 body 复制到宿主）——模板衍生 DOM 的标记

  child.remove()
  await settleMO()
  console.warn = origWarn

  assert.equal(instanceOf(child, false), null, 'instance purged via fallback')
  const fallbackWarns = warns.filter((w) => w.includes('observer fallback'))
  assert.equal(fallbackWarns.length, 1, 'marked template DOM removal still warns (convergence signal)')
  app.destroy()
})

test('keepOnDetach: node survives removal, reactivates after re-insertion', async () => {
  // div+vsrc 走 vsrc 分支真正加载模板（dash 标签会按标签名解析成 /keep/box.html，
  // vsrc 被忽略，历史上此测试是在「加载失败」的实例上断言生命周期的）
  const { app, host } = await mount(
    `<div><div class="keep-box" vsrc="/x/keep.html"></div></div>`,
    {},
  )
  const box = host.querySelector('.keep-box')
  assert.ok(box, 'component mounted')
  const inst = instanceOf(box, false)
  assert.ok(inst, 'instance exists')
  // v0.10.3：keepOnDetach 只走实例字段（路由经 parseRef options.keepOnDetach 声明，
  // 见 error-contract 测试）；data-keep DOM 属性通道已整体废除，模板里写它不生效
  box.setAttribute('data-keep', '')
  assert.equal(inst.keepOnDetach, false, 'data-keep attribute no longer translates')
  inst.keepOnDetach = true
  await flush(120)
  assert.ok(box.textContent.includes('kept'), 'component content actually loaded')

  box.remove()             // 缓存页软断开形态
  await settleMO()
  assert.equal(inst.scope.state !== 'disposed', true, 'keepOnDetach survives observer fallback')
  assert.equal(instanceOf(box, false), inst, 'instance kept')

  host.querySelector('div').append(box)   // 重插
  await settleMO()
  inst.scope.activate(box, 'route')       // 路由重入语义
  assert.equal(inst.scope.state, 'active')
  app.destroy()
})

test('same-frame move (remove + re-insert) does not dispose', async () => {
  const { app, host } = await mount(
    `<ul><li v-for="o in list">{{ o.name }}</li></ul>`,
    { list: [{ name: 'a' }, { name: 'b' }] },
  )
  const li = host.querySelector('li')
  const parent = li.parentNode
  const sibling = li.nextSibling

  li.remove()
  parent.insertBefore(li, sibling)   // 同帧移回（v-for moveItemBefore 形态）
  await settleMO()
  // li 无自身实例；其插值绑定应仍存活（文本可继续响应）
  app._data.list[0] = { name: 'z' }
  await flush()
  assert.deepEqual(texts(host, 'li'), ['z', 'b'], 'bindings still alive after same-frame move')
  app.destroy()
})

test('disposeNode is idempotent across removal cycles', async () => {
  const { app, host } = await mount(
    `<div><x-child v-for="o in list" :msg="o.name"></x-child></div>`,
    { list: [{ name: 'a' }] },
  )
  const child = host.querySelector('x-child')
  const inst = instanceOf(child, false)
  let disposeCalls = 0
  inst.scope.onDispose(() => disposeCalls++)

  assert.equal(disposeNode(child), true, 'first dispose cleans up')
  assert.equal(disposeNode(child), false, 'second dispose is a no-op')
  child.remove()
  await settleMO()
  assert.equal(disposeCalls, 1, 'dispose callback fired exactly once')
  app.destroy()
})

test('async mount: token invalidates when disposed during await', async () => {
  const VHTML = await loadSrc()
  const root = document.createElement('div')
  root.innerHTML = `<div class="box"></div>`
  document.body.appendChild(root)
  const app2 = new VHTML({ target: root, data: {} })
  await app2.ready

  const box = root.querySelector('.box')
  const parsePromise = app2.parseRef('/x/slow.html', box, {}, {})
  await new Promise((r) => setTimeout(r, 20))   // parseRef 已进入 fetchUI await（顶部 stub 的慢分支）
  disposeNode(box)         // 期间销毁 → token kill
  await parsePromise
  await flush(200)

  // 布尔断言（happy-dom 节点直接 equal 失败时会触发 util.inspect 无限扁平化拖死进程）
  assert.ok(!box.querySelector('.slow'), 'no orphan mount after token invalidation')
  assert.equal(box.hasAttribute('vparsing'), false, 'vparsing cleared by finally guard')
  app2.destroy()
})
