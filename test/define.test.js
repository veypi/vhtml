/*
 * define.test.js — defineProperty 原语 + $mod 二级对象树（v0.10.1）
 *
 * 语义矩阵：普通对象 / Wrap proxy 新装 / Wrap proxy 已有 key（赋值语义）/
 * getter·setter 描述符语义 / 只读描述符锁 / 显式本地不穿透（vs 赋值穿透）。
 * $mod 二级树：globals 回落读、穿透写、define 本地遮蔽、内置件锁、登记表。
 */
import { test } from 'node:test'
import assert from 'node:assert'
import { setupDom, flush } from './harness.js'

setupDom()
const { Wrap, Watch, Cancel, defineProperty } = await import('../src/reactive.js')
const { createModuleContext, ModuleContextManager } = await import('../src/module.js')

test('defineProperty: plain object — open defaults, repeated define overwrites, explicit lock throws', () => {
  const o = {}
  defineProperty(o, 'x', 1)
  const d = Object.getOwnPropertyDescriptor(o, 'x')
  assert.ok(d.configurable === true && d.writable === true && d.enumerable === true)
  defineProperty(o, 'x', 2)
  assert.strictEqual(o.x, 2)
  defineProperty(o, 'locked', 3, { writable: false, configurable: false })
  assert.strictEqual(o.locked, 3)
  assert.throws(() => { o.locked = 4 }, TypeError)
  assert.throws(() => defineProperty(o, 'locked', 5), TypeError)
})

test('defineProperty: fresh key on wrapped proxy notifies watchers (install notify)', async () => {
  const p = Wrap({})
  const seen = []
  const h = Watch(() => p.a, (v) => seen.push(v))
  defineProperty(p, 'a', 1)
  await flush()
  Cancel(h)
  // 首轮 miss 读 undefined；define 新装触发 key 通道 → 重估得 1
  assert.deepStrictEqual(seen, [undefined, 1])
})

test('defineProperty: existing own key = assign semantics (overwrite + notify)', async () => {
  const p = Wrap({ n: 1 })
  const seen = []
  const h = Watch(() => p.n, (v) => seen.push(v))
  defineProperty(p, 'n', 2)
  await flush()
  Cancel(h)
  assert.deepStrictEqual(seen, [1, 2])
})

test('defineProperty: getter this = proxy, deps inside getter tracked', async () => {
  const p = Wrap({ count: 1 })
  defineProperty(p, 'double', 0, { get() { return this.count * 2 } })
  assert.strictEqual(p.double, 2)
  const seen = []
  const h = Watch(() => p.double, (v) => seen.push(v))
  p.count = 5
  await flush()
  Cancel(h)
  assert.deepStrictEqual(seen, [2, 10])
})

test('defineProperty: setter invoked via proxy write, watcher re-eval sees new value', async () => {
  const p = Wrap({})
  let stored = -1
  defineProperty(p, 'raw', 0, {
    get() { return stored },
    set(v) { stored = v * 10 },
  })
  const seen = []
  const h = Watch(() => p.raw, (v) => seen.push(v))
  p.raw = 3
  await flush()
  Cancel(h)
  assert.strictEqual(stored, 30)
  assert.deepStrictEqual(seen, [-1, 30])
})

test('defineProperty: readonly lock on wrapped proxy — assign / redefine / accessor-redefine all throw', () => {
  const p = Wrap({})
  defineProperty(p, 'fixed', 1, { writable: false, configurable: false })
  assert.strictEqual(p.fixed, 1)
  assert.throws(() => { p.fixed = 2 }, TypeError)
  assert.throws(() => defineProperty(p, 'fixed', 2), TypeError)
  assert.throws(() => defineProperty(p, 'fixed', 0, { get() { return 2 } }), TypeError)
})

test('defineProperty: explicit local install never falls through to root (define shadows global)', () => {
  const globals = Wrap({})
  const child = Wrap({}, globals)
  globals.shared = 'g'
  // 赋值穿透：本地无 key 且 root 有 → 写 root
  child.shared = 'assign'
  assert.strictEqual(globals.shared, 'assign')
  // define 显式本地新装 → 遮蔽 root，root 不被改写
  defineProperty(child, 'shared', 'local')
  assert.strictEqual(child.shared, 'local')
  assert.strictEqual(globals.shared, 'assign')
})

test('$mod two-level tree: cross-module fallback to globals (read identity + write-through)', () => {
  const globals = Wrap({})
  const locale = Wrap({ locale: 'zh-CN', fallback: 'en-US' })
  const modA = createModuleContext('/a', locale, {}, null, globals)
  const modB = createModuleContext('/b', locale, {}, null, globals)
  defineProperty(globals, '$svc', { ping: () => 'pong' })
  assert.strictEqual(modA.$svc.ping(), 'pong')
  assert.ok(modA.$svc === modB.$svc) // 读时惰性 Wrap 回写缓存 → 同实体身份
  // 穿透写：globals 已建立 $os 条目（env.js all.define 等价物）→ 赋值穿透
  // 写 globals → 双方同实体
  defineProperty(globals, '$os', { cap: null })
  modA.$os = { cap: 1 }
  assert.ok(modB.$os === modA.$os)
  assert.strictEqual(modB.$os.cap, 1)
  // 赋值本地兜底：globals 无此 key → 写本地私有，对方不可见
  modA.localOnly = 'a'
  assert.strictEqual(modA.localOnly, 'a')
  assert.strictEqual(modB.localOnly, undefined)
  // define 本地：不穿透，对方不可见
  modA.define('priv', 7)
  assert.strictEqual(modA.priv, 7)
  assert.strictEqual(modB.priv, undefined)
})

test('module context: builtins locked, $mod.define bound, registry recorded', () => {
  const globals = Wrap({})
  const mod = createModuleContext('/x', Wrap({ locale: 'zh-CN', fallback: 'en-US' }), {}, null, globals)
  assert.throws(() => { mod.scoped = '/y' }, TypeError)
  assert.throws(() => { mod.$bus = null }, TypeError)
  assert.throws(() => mod.define('scoped', 1), TypeError)
  assert.strictEqual(typeof mod.define, 'function')
  mod.define('entry', { v: 1 })
  assert.strictEqual(mod.entry.v, 1)
  const reg = window.__vhtml_dev.defines
  assert.ok(Array.isArray(reg))
  assert.ok(reg.some((r) => r.name === 'entry' && r.target === '/x'))
})

test('manager.define: writes globals, records $globals, warns outside env loading', () => {
  const manager = new ModuleContextManager()
  const warnings = []
  const origWarn = console.warn
  console.warn = (msg) => warnings.push(String(msg))
  try {
    manager.define('$g1', 42)
  } finally {
    console.warn = origWarn
  }
  assert.strictEqual(manager.globals.$g1, 42)
  assert.ok(warnings.some((w) => w.includes('outside env.js loading')))
  assert.ok(window.__vhtml_dev.defines.some((r) => r.name === '$g1' && r.target === '$globals'))
})

test('defineProperty: symbol key and non-object target throw', () => {
  assert.throws(() => defineProperty({}, Symbol('s'), 1), /symbol key/)
  assert.throws(() => defineProperty(null, 'x', 1), /target must be an object/)
})
