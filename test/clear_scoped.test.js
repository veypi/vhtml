/*
 * clear_scoped.test.js — scoped 前缀缓存清理（v0.10.5）
 *
 * 覆盖：模板/在途键前缀清除（整段边界防 a/a2 撞名、origin 双形态、
 * 绝对 URL scoped、文件级 .html 前缀）、epoch 防在途旧描述符回流、
 * head 样式节点回收与去重集清理、模块上下文/别名前缀清除、clear() 全清补样式回收。
 */

import { test, beforeEach } from 'node:test'
import assert from 'node:assert'
import { setupDom } from './harness.js'

setupDom()

const { templateLoader } = await import('../src/loader.js')
const { default: moduleContextManager } = await import('../src/module.js')

const T = '/skills/local/a/ui/index.html'
const T2 = '/skills/local/a2/ui/index.html'
const OTHER = '/other/b.html'

function seedTemplates() {
  templateLoader.cache.templates.set(T, { fake: 1 })
  templateLoader.cache.templates.set(T2, { fake: 2 })
  templateLoader.cache.templates.set(OTHER, { fake: 3 })
  templateLoader.cache.templates.set('http://localhost/skills/local/a/abs.html', { fake: 4 })
}

beforeEach(() => {
  templateLoader.cache.clear()
  templateLoader.resourceLoader.clearStyles()
  moduleContextManager.modMap.clear()
  moduleContextManager._aliasMap.clear()
})

test('clearScoped 前缀清除：命中前缀、保留撞名前缀与其他 scope', () => {
  seedTemplates()
  templateLoader.clearScoped('/skills/local/a')
  assert.ok(!templateLoader.cache.templates.has(T))
  assert.ok(!templateLoader.cache.templates.has('http://localhost/skills/local/a/abs.html'))
  assert.ok(templateLoader.cache.templates.has(T2), '/a 不得撞名清除 /a2')
  assert.ok(templateLoader.cache.templates.has(OTHER))
})

test('clearScoped 绝对 URL 前缀（http scoped 源）', () => {
  templateLoader.cache.templates.set('https://cdn.example.com/pkg/p.html', { fake: 1 })
  templateLoader.cache.templates.set('https://cdn.example.com/pkg2/p.html', { fake: 2 })
  templateLoader.clearScoped('https://cdn.example.com/pkg')
  assert.ok(!templateLoader.cache.templates.has('https://cdn.example.com/pkg/p.html'))
  assert.ok(templateLoader.cache.templates.has('https://cdn.example.com/pkg2/p.html'))
})

test('clearScoped 文件级 .html 前缀同时命中 fetchUrl 与描述符级键', () => {
  templateLoader.cache.templates.set('/x/index.html', { fake: 1 })
  templateLoader.cache.templates.set('/x/index/sub.html', { fake: 2 })
  templateLoader.clearScoped('/x/index.html')
  assert.ok(!templateLoader.cache.templates.has('/x/index.html'))
  assert.ok(!templateLoader.cache.templates.has('/x/index/sub.html'))
})

test('clearScoped 清 pending 键', () => {
  templateLoader.cache.pending.set(T, Promise.resolve({ fake: 1 }))
  templateLoader.clearScoped('/skills/local/a')
  assert.ok(!templateLoader.cache.pending.has(T))
})

test('clearScoped 回收 head 命中样式并清去重集，其他 scope 样式幸存', () => {
  const rl = templateLoader.resourceLoader
  rl.loadStyle('.a{color:red}', '/skills/local/a/index')
  rl.loadStyle('.b{color:blue}', '/other/index')
  assert.equal(document.head.querySelectorAll('style[vref]').length, 2)
  templateLoader.clearScoped('/skills/local/a')
  const rest = [...document.head.querySelectorAll('style[vref]')]
  assert.equal(rest.length, 1)
  assert.equal(rest[0].getAttribute('vref'), '/other/index')
  assert.equal(rl.loadedStyles.size, 1)
  assert.ok([...rl.loadedStyles][0].startsWith('/other/index::'))
})

test('clearScoped 委托 moduleManager 清同前缀模块上下文与别名', () => {
  moduleContextManager.modMap.set('/skills/local/a', { mod: {} })
  moduleContextManager.modMap.set('/skills/local/a/sub', { mod: {} })
  moduleContextManager.modMap.set('/skills/local/a2', { mod: {} })
  moduleContextManager._aliasMap.set('/skills/local/a', { x: '/y' })
  templateLoader.clearScoped('/skills/local/a')
  assert.ok(!moduleContextManager.modMap.has('/skills/local/a'))
  assert.ok(!moduleContextManager.modMap.has('/skills/local/a/sub'))
  assert.ok(moduleContextManager.modMap.has('/skills/local/a2'))
  assert.ok(!moduleContextManager._aliasMap.has('/skills/local/a'))
})

test('epoch 守卫：在途 fetch 完成后不得把旧描述符写回缓存', async () => {
  let resolveFetch
  let fetchInit = null
  globalThis.fetch = (url, init) => { fetchInit = init; return new Promise((res) => { resolveFetch = res }) }
  try {
    const pending = templateLoader.fetchUI(T)
    await new Promise((r) => setTimeout(r, 10))
    assert.ok(templateLoader.cache.pending.has(T))
    assert.equal(fetchInit?.cache, 'no-cache', '模板 fetch 必须带 cache:no-cache（防 HTTP 缓存层喂旧文件）')

    templateLoader.clearScoped('/skills/local/a')
    assert.ok(!templateLoader.cache.pending.has(T))

    resolveFetch({
      ok: true,
      headers: { entries: () => new Map().entries() },
      text: async () => '<html><head></head><body><div>v1</div></body></html>',
    })
    await pending
    assert.ok(!templateLoader.cache.templates.has(T), '旧描述符不得回流')

    let calls = 0
    globalThis.fetch = async () => {
      calls++
      return {
        ok: true,
        headers: { entries: () => new Map().entries() },
        text: async () => '<html><head></head><body><div>v2</div></body></html>',
      }
    }
    const descriptor = await templateLoader.fetchUI(T)
    assert.equal(calls, 1, '清后首次 fetch 必须重新拉取')
    assert.ok(descriptor.body.textContent.includes('v2'))
    assert.ok(templateLoader.cache.templates.has(T), '新描述符正常入缓存')
  } finally {
    delete globalThis.fetch
  }
})

test('clear() 全清：模板/模块/样式一并回收（补原缺失的样式清理）', () => {
  seedTemplates()
  templateLoader.resourceLoader.loadStyle('.a{}', '/skills/local/a/index')
  moduleContextManager.modMap.set('/skills/local/a', { mod: {} })
  templateLoader.clear()
  assert.equal(templateLoader.cache.templates.size, 0)
  assert.equal(moduleContextManager.modMap.size, 0)
  assert.equal(document.head.querySelectorAll('style[vref]').length, 0)
  assert.equal(templateLoader.resourceLoader.loadedStyles.size, 0)
})

test('scopeOf：返回已缓存描述符的模块 scoped，未缓存返回 null', () => {
  templateLoader.cache.templates.set(T, { scoped: '/skills/local/a' })
  assert.equal(templateLoader.scopeOf(T), '/skills/local/a')
  assert.equal(templateLoader.scopeOf('/nope/x.html'), null)
})

test('scopeOf 双键兜底：fetch 发起方模块路径与页面 runtime scoped 不一致时仍命中', () => {
  // 键 = 裸路径（root scoped vrouter 发起 fetch 的形态），反查时传入页面运行时
  // （scoped 已是模块根 /skills/local/a）——单键公式会拼双前缀键 miss，双键须命中
  templateLoader.cache.templates.set(T, { scoped: '/skills/local/a' })
  const pageRuntime = { $mod: { scoped: '/skills/local/a' } }
  assert.equal(templateLoader.scopeOf(T, pageRuntime), '/skills/local/a')
})

test('clearScoped 空前缀 = 全部模块上下文（与 loader match-all 对齐）', () => {
  moduleContextManager.modMap.set('/a', { mod: {} })
  moduleContextManager.modMap.set('/b', { mod: {} })
  moduleContextManager._aliasMap.set('/a', { x: '/y' })
  moduleContextManager.clearScoped('')
  assert.equal(moduleContextManager.modMap.size, 0)
  assert.equal(moduleContextManager._aliasMap.size, 0)
})
