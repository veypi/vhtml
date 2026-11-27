/*
 * import_parallel_retry.test.js — 原生 import 的并发加载与失败重试
 *
 * 背景：setup 的静态 import 此前逐条串行 await（os.html 的 setup 有 17 个
 * import = 17 次串行往返），且失败即抛穿——一次网络卡顿就让整页布局挂载
 * 失败（白屏）。现在：并发加载 + 网络类失败重试一次（换 URL 强制重新
 * 请求——同一 URL 的 import() 会复用浏览器模块表里的在途请求，重试等于
 * 继续等那个卡死的请求）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setupDom } from './harness.js'
setupDom()
const { importNative } = await import('../src/imports.js')
const { NativeExecutor } = await import('../src/execution/native.js')
const { ModuleResources } = await import('../src/resource.js')
const { registerModule } = await import('../src/execution/context.js')

const DELAY = 200

async function fixture(t, files) {
  const dir = await mkdtemp(join(tmpdir(), 'vhtml-import-parallel-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await Promise.all(
    Object.entries({ 'package.json': '{"type":"module"}', ...files }).map(
      async ([name, source]) => {
        const path = join(dir, name)
        await mkdir(dirname(path), { recursive: true })
        await writeFile(path, source)
      }
    )
  )
  const base = pathToFileURL(dir + '/')
  const mod = { scoped: '/native' }
  const resources = new ModuleResources({
    origin: 'http://localhost',
    scoped: mod.scoped,
    unsafe: false,
  })
  const resolve = resources.resolve.bind(resources)
  // Node 不能 import HTTP 模块：保留真实的模块/引用者解析，只把解析出的
  // URL 映射到本地 ESM 夹具（query/hash 保留）。
  t.mock.method(resources, 'resolve', (input, options) => {
    const address = new URL(resolve(input, options).href)
    assert(address.pathname.startsWith('/native/'))
    const local = new URL(address.pathname.slice('/native/'.length), base)
    local.search = address.search
    local.hash = address.hash
    return { href: local.href }
  })
  const execution = new NativeExecutor(resources)
  registerModule(mod, { mod, resources, execution, meta: resources.meta })
  return {
    execution,
    runtime: { $mod: mod, source: 'http://localhost/native/views/page.html' },
  }
}

test('setup imports load concurrently instead of one round trip each', async (t) => {
  const slow = (tag) =>
    `await new Promise(r => setTimeout(r, ${DELAY})); export const v = '${tag}'`
  const { execution, runtime } = await fixture(t, {
    'views/a.js': slow('a'),
    'views/b.js': slow('b'),
    'views/c.js': slow('c'),
  })
  const data = {}
  const started = Date.now()
  await execution.execute(
    `import {v as a} from './a.js'; import {v as b} from './b.js'; import {v as c} from './c.js';`,
    data,
    runtime
  )
  const elapsed = Date.now() - started
  assert.equal(data.a, 'a')
  assert.equal(data.b, 'b')
  assert.equal(data.c, 'c')
  assert.ok(
    elapsed < DELAY * 2,
    `imports should overlap instead of running one after another (took ${elapsed}ms)`
  )
})

async function slowModule(t, sleep = 150) {
  const dir = await mkdtemp(join(tmpdir(), 'vhtml-import-retry-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(join(dir, 'package.json'), '{"type":"module"}')
  await writeFile(
    join(dir, 'slow.js'),
    `await new Promise(r => setTimeout(r, ${sleep})); export default 'ok'`
  )
  return pathToFileURL(join(dir, 'slow.js')).href
}

// 首次请求慢（超时）、重试请求快——重试必须换一个 URL 才能重新求值，
// 同一 URL 会命中模块表里的在途请求。
async function flakyModule(t) {
  const dir = await mkdtemp(join(tmpdir(), 'vhtml-import-flaky-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(join(dir, 'package.json'), '{"type":"module"}')
  await writeFile(
    join(dir, 'flaky.js'),
    `const retry = new URL(import.meta.url).searchParams.has('__vr')
await new Promise(r => setTimeout(r, retry ? 10 : 400))
export default 'ok'`
  )
  return pathToFileURL(join(dir, 'flaky.js')).href
}

test('a timed-out import retries once and succeeds', async (t) => {
  const url = await flakyModule(t)
  const ns = await importNative(url, 80)
  assert.equal(ns.default, 'ok')
})

test('a permanently failing import still reports the timeout', async (t) => {
  const url = await slowModule(t)
  await assert.rejects(importNative(url, 40), /timeout after \d+ms/)
})

test('a missing module fails fast without retrying', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'vhtml-import-missing-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const url = pathToFileURL(join(dir, 'missing.js')).href
  const started = Date.now()
  await assert.rejects(importNative(url, 40))
  assert.ok(
    Date.now() - started < 300,
    'a missing module must not be retried'
  )
})
