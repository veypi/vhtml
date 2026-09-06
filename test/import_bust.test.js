/*
 * import_bust.test.js — ESM 缓存穿透令牌（v0.10.5）
 *
 * 浏览器原生模块表按完整 URL 缓存、无 API 可驱逐；clearScoped/clear 递增
 * importEpoch，import 点（imports.js 静态/动态、env.js、routes.js）经
 * withImportBust 给 URL 追加 ?__ve={n} 强制重取。
 *
 * 覆盖：零令牌原样返回、令牌递增单调、已有 query 用 &、blob:/data:/外部
 * http(s) 跳过、同源绝对 URL 穿透、clearScoped/clear 触发递增。
 * 注意：node --test 每文件独立进程，本文件依赖 importEpoch 从 0 起步，
 * 用例按定义序执行，勿调整顺序。
 */

import { test } from 'node:test'
import assert from 'node:assert'
import { setupDom } from './harness.js'

setupDom()

const { bumpImportEpoch, withImportBust } = await import('../src/module.js')
const { templateLoader } = await import('../src/loader.js')

test('令牌为 0：URL 原样返回', () => {
  assert.equal(withImportBust('/os/tiling.js'), '/os/tiling.js')
  assert.equal(withImportBust('http://localhost/os/tiling.js'), 'http://localhost/os/tiling.js')
})

test('令牌非 0：追加 ?__ve={n}，单调递增', () => {
  bumpImportEpoch()
  assert.equal(withImportBust('/os/tiling.js'), '/os/tiling.js?__ve=1')
  bumpImportEpoch()
  assert.equal(withImportBust('/os/tiling.js'), '/os/tiling.js?__ve=2')
})

test('已有 query 用 & 拼接', () => {
  assert.equal(withImportBust('/x.js?a=1'), '/x.js?a=1&__ve=2')
})

test('blob:/data: 不穿透', () => {
  assert.equal(withImportBust('blob:http://localhost/xx'), 'blob:http://localhost/xx')
  assert.equal(withImportBust('data:text/js,export default 1'), 'data:text/js,export default 1')
})

test('外部 http(s) 跳过；同源绝对 URL 穿透', () => {
  assert.equal(withImportBust('https://cdn.example.com/lib.js'), 'https://cdn.example.com/lib.js')
  assert.equal(withImportBust('http://localhost/skills/local/a/env.js'), 'http://localhost/skills/local/a/env.js?__ve=2')
})

test('clearScoped 递增穿透令牌', () => {
  const before = withImportBust('/x.js')
  templateLoader.clearScoped('/skills/local/a')
  const after = withImportBust('/x.js')
  assert.notEqual(before, after)
  assert.ok(/__ve=3$/.test(after))
})

test('clear() 递增穿透令牌', () => {
  templateLoader.clear()
  assert.ok(/__ve=4$/.test(withImportBust('/x.js')))
})
