/*
 * setup_scope.test.js — <script setup> 执行上下文提供 $scope（回归）
 *
 * 背景：ai/input.html 的 IME 提交延迟同步在 setup 里调 $scope.requestAnimationFrame；
 * 而 setup 上下文此前只注入 $node/$watch（$scope 仅生命周期脚本有），compositionend
 * 处理器读到 undefined 直接 TypeError——提交中文后高度/发送态不刷新，要等下一次
 * 普通输入事件才补上。本用例挂载一个在 setup 里注册帧/定时任务的组件，断言：
 *   1. $scope 可用且帧回调执行；
 *   2. 任务受 scope 托管：未完成的 timer 留在 pending 集合、完成的帧自然退出；
 *   3. dispose 释放 setup 注册的任务；
 *   4. 不再出现 identifier "$scope" is not defined 的沙盒警告。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadSrc, mount, flush } from './harness.js'

await loadSrc()
const { instanceOf } = await import('../src/component-instance.js')

// fetch 打桩：返回带 <script setup> 的组件模板
const fakeHeaders = { get: () => null, entries: () => [][Symbol.iterator]() }
const TEMPLATE = `<!DOCTYPE html><html><head><title>s</title></head><body><b class="probe">{{ frameSeen }}</b></body>
<script setup>
frameSeen = -1
$scope.requestAnimationFrame(() => { frameSeen = 0 })
$scope.setTimeout(() => {}, 60000)
</script></html>`
const realFetch = globalThis.fetch
const stubFetch = async (url) => {
  const u = String(url).split('?')[0]
  if (u.endsWith('/x/scope.html')) {
    return { ok: true, status: 200, headers: fakeHeaders, text: async () => TEMPLATE }
  }
  return realFetch ? realFetch(url) : { ok: false, status: 404, headers: fakeHeaders, text: async () => '' }
}
globalThis.fetch = stubFetch
window.fetch = stubFetch

test('script setup exposes $scope with scope-owned tasks', async () => {
  const warns = []
  const origWarn = console.warn
  console.warn = (...args) => { warns.push(String(args[0] || '')) }
  let app = null
  let scope = null
  try {
    const mounted = await mount('<x-scope></x-scope>', {})
    app = mounted.app
    await flush()
    const child = mounted.host.querySelector('x-scope')
    assert.ok(child, 'component mounted')
    assert.equal(child.$data.frameSeen, 0, '$scope.requestAnimationFrame ran inside script setup')
    scope = instanceOf(child, false).scope
    assert.equal(scope.timers.size, 1, 'setup-registered timeout is scope-owned (still pending)')
    assert.equal(scope.frames.size, 0, 'completed frame left the scope collection')
    assert.equal(warns.filter(w => w.includes('$scope')).length, 0, 'no missing-identifier warning for $scope')
  } finally {
    console.warn = origWarn
    app?.destroy()
  }
  assert.equal(scope.timers.size, 0, 'dispose released setup-registered tasks')
})
