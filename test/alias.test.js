/* Alias 规则（URL 键）单元测试：归一化、匹配优先级、三档表、组件地址解析。
 * 契约文档：aic/docs/reference/profile.md §1（addAlias URL 化）。 */
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { setupDom } from './harness.js'
setupDom()
const {
  ModuleContextManager,
  default: manager,
  normalizeAliasKey,
  normalizeAliasValue,
  matchAlias,
} = await import('../src/module.js')
const { registerModule } = await import('../src/execution/context.js')
const { resolveComponentUrl } = await import('../src/compiler-attrs.js')

// ---- normalizeAliasKey ----

test('alias key: requires absolute logical path below /', () => {
  assert.throws(() => normalizeAliasKey('ai'), /absolute logical path/)
  assert.throws(() => normalizeAliasKey('/'), /below \//)
  assert.throws(() => normalizeAliasKey(''), /non-empty/)
  assert.throws(() => normalizeAliasKey(null), /non-empty/)
})

test('alias key: lowercase path segments, no dot segments', () => {
  assert.throws(() => normalizeAliasKey('/AI'), /lowercase/)
  assert.throws(() => normalizeAliasKey('/a/../b'), /lowercase/)
  assert.throws(() => normalizeAliasKey('/a/./b'), /lowercase/)
  assert.throws(() => normalizeAliasKey('/a b'), /lowercase/)
})

test('alias key: normalizes trailing slashes', () => {
  assert.equal(normalizeAliasKey('/ai/'), '/ai')
  assert.equal(normalizeAliasKey('/ai/box/'), '/ai/box')
  assert.equal(normalizeAliasKey('/ai/box.html'), '/ai/box.html')
})

// ---- normalizeAliasValue ----

test('alias value: requires / or https origin', () => {
  assert.throws(() => normalizeAliasValue('/ai', 'ai'), /start with \//)
  assert.throws(() => normalizeAliasValue('/ai', 'blob:x'), /start with \//)
  assert.throws(() => normalizeAliasValue('/ai', ''), /non-empty/)
  assert.equal(normalizeAliasValue('/ai', '/ai'), '/ai')
  assert.equal(normalizeAliasValue('/ai', 'https://cdn.example.com/ui'), 'https://cdn.example.com/ui')
})

test('alias value: exact key requires .html file, prefix key requires directory', () => {
  assert.equal(normalizeAliasValue('/ai/box.html', '/x/y.html'), '/x/y.html')
  assert.throws(() => normalizeAliasValue('/ai/box.html', '/x/y'), /exact key/)
  assert.throws(() => normalizeAliasValue('/ai', '/x/y.html'), /prefix key/)
  assert.equal(normalizeAliasValue('/ai/', '/ai/'), '/ai')
})

// ---- matchAlias ----

const tables = (primary, scoped, global) => ({ primary, scoped, global })

test('matchAlias: prefix match requires segment boundary', () => {
  const t = tables(null, null, { '/ai': '/ai' })
  assert.equal(matchAlias('/ai/box', t), '/ai/box')
  assert.equal(matchAlias('/ai', t), '/ai')
  assert.equal(matchAlias('/aix', t), null)
  assert.equal(matchAlias('/aix/box', t), null)
})

test('matchAlias: longest prefix wins, tier breaks ties', () => {
  const t = tables(null, null, { '/ai': '/g/ai', '/ai/box': '/g/aibox' })
  assert.equal(matchAlias('/ai/box/deep', t), '/g/aibox/deep')
  assert.equal(matchAlias('/ai/box', t), '/g/aibox')
  assert.equal(matchAlias('/ai/other', t), '/g/ai/other')
  // '/ai/b' 不是 '/ai/box' 的段边界前缀，不得命中
  assert.equal(matchAlias('/ai/box', tables(null, null, { '/ai/b': '/g/b' })), null)
})

test('matchAlias: exact beats prefix regardless of tier', () => {
  const t = tables(
    { '/ai': '/p/ai' },
    null,
    { '/ai/box.html': '/g/exact.html' }
  )
  // exact 键在最低档也压过最高档的前缀键
  assert.equal(matchAlias('/ai/box', t), '/g/exact.html')
  assert.equal(matchAlias('/ai/other', t), '/p/ai/other')
})

test('matchAlias: 首段索引生效（连续查找不再全表扫描）', () => {
  const raw = { '/ai': '/g/ai', '/ai/box': '/g/aibox', '/os': '/g/os' }
  let ownKeysCalls = 0
  const counted = new Proxy(raw, {
    ownKeys(target) {
      ownKeysCalls++
      return Reflect.ownKeys(target)
    },
  })
  const t = tables(counted, null, null)
  assert.equal(matchAlias('/ai/box', t), '/g/aibox')
  const afterFirst = ownKeysCalls
  matchAlias('/ai/other', t)
  matchAlias('/os/x', t)
  assert.equal(ownKeysCalls, afterFirst, '后续查找不再遍历表键（首段索引缓存命中）')
})

test('matchAlias: same specificity resolves primary > scoped > global', () => {
  const t = tables(
    { '/ai': '/p' },
    { '/ai': '/s' },
    { '/ai': '/g' }
  )
  assert.equal(matchAlias('/ai/box', t), '/p/box')
  assert.equal(matchAlias('/ai/box', tables(null, t.scoped, t.global)), '/s/box')
  assert.equal(matchAlias('/ai/box', tables(null, null, t.global)), '/g/box')
  assert.equal(matchAlias('/none', t), null)
})

// ---- ModuleContextManager tiers ----

test('manager: tier registration and getAliases shape', () => {
  const m = new ModuleContextManager()
  m.modMap.set('/x', { scoped: '/x', aliases: {} })
  m.addAlias('/x', '/ui', '/x/ui')
  m.addAlias('/x', '/shared', '/shared', 'global')
  m.addAlias('/x', '/pin', '/pin', 'primary')
  const t = m.getAliases('/x')
  assert.deepEqual(Object.keys(t), ['primary', 'scoped', 'global'])
  assert.equal(t.scoped['/ui'], '/x/ui')
  assert.equal(t.global['/shared'], '/shared')
  assert.equal(t.primary['/pin'], '/pin')
  assert.equal(m.getAliases('/unregistered').scoped, null)
  assert.equal(m.getAliases(null).scoped, null)
  assert.throws(() => m.addAlias('/missing', '/ui', '/y'), /not registered/)
  assert.throws(() => m.addAlias('/x', '/ui', '/y', 'weird'), /unknown tier/)
})

test('manager: alias 表冻结（调用方拿到引用也改不了全局档）+ copy-on-write', () => {
  const m = new ModuleContextManager()
  m.modMap.set('/x', { scoped: '/x', aliases: {} })
  m.addAlias('/x', '/ui', '/x/ui')
  m.addAlias('/x', '/shared', '/shared', 'global')
  const t = m.getAliases('/x')
  assert.ok(Object.isFrozen(t.global), 'global 表冻结')
  assert.ok(Object.isFrozen(t.scoped), 'scoped 表冻结')
  // 拿到引用的调用方改不动（严格模式抛错，非严格静默）
  assert.throws(() => { 'use strict'; t.global['/evil'] = '/evil' })
  assert.equal(t.global['/evil'], undefined)
  // copy-on-write：再注册一条 → 换新表对象（旧引用不受影响）
  const before = t.global
  m.addAlias('/x', '/more', '/more', 'global')
  const after = m.getAliases('/x').global
  assert.notEqual(after, before, '写入走 copy-on-write（新表对象）')
  assert.equal(after['/shared'], '/shared')
  assert.equal(after['/more'], '/more')
  assert.equal(before['/more'], undefined, '旧引用不被就地改写')
})

test('manager: clearScoped preserves global and primary tiers', () => {
  const m = new ModuleContextManager()
  m.modMap.set('/x', { scoped: '/x', aliases: {} })
  m.addAlias('/x', '/ui', '/x/ui')
  m.addAlias('/x', '/shared', '/shared', 'global')
  m.addAlias('/x', '/pin', '/pin', 'primary')
  m.clearScoped('/x')
  assert.equal(m.getAliases('/x').scoped, null)
  assert.equal(m.getAliases('/x').global['/shared'], '/shared')
  assert.equal(m.getAliases('/x').primary['/pin'], '/pin')
  m.clear()
  assert.deepEqual(m.getAliases('/x').primary, {})
  assert.deepEqual(m.getAliases('/x').global, {})
})

// ---- resolveComponentUrl ----

const runtimeOf = (scoped, unsafe = false) => {
  const mod = { scoped }
  if (unsafe) registerModule(mod, { meta: { unsafe: true } })
  return { $mod: mod }
}

beforeEach(() => manager.clear())
afterEach(() => manager.clear())

test('resolveComponentUrl: no alias → module-root-relative candidate unchanged', () => {
  assert.equal(resolveComponentUrl('ai-box', runtimeOf('')), '/ai/box')
  assert.equal(resolveComponentUrl('v-dialog', runtimeOf('/v')), '/v/dialog')
})

test('resolveComponentUrl: global prefix hit maps to origin-absolute', () => {
  manager.addAlias('', '/ai', '/ai', 'global')
  assert.equal(resolveComponentUrl('ai-box', runtimeOf('')), '@/ai/box')
  assert.equal(resolveComponentUrl('ai-box', runtimeOf('/skills/x')), '@/ai/box')
  assert.equal(resolveComponentUrl('ai', runtimeOf('')), '@/ai')
})

test('resolveComponentUrl: root module consults alias tables (regression)', () => {
  // 旧实现根模块 scoped==='' 不查表；URL 化后 profile 规则必须对根页面生效
  manager.addAlias('', '/ai/box.html', '/custom/box.html', 'primary')
  assert.equal(resolveComponentUrl('ai-box', runtimeOf('')), '@/custom/box.html')
  assert.equal(resolveComponentUrl('ai-input', runtimeOf('')), '/ai/input')
})

test('resolveComponentUrl: exact key hit keeps .html, prefix hit leaves it to loader', () => {
  manager.addAlias('', '/ai/box.html', '/x/y.html', 'global')
  manager.addAlias('', '/v', 'https://cdn.example.com/v', 'global')
  assert.equal(resolveComponentUrl('ai-box', runtimeOf('')), '@/x/y.html')
  assert.equal(resolveComponentUrl('v-dialog', runtimeOf('')), '@https://cdn.example.com/v/dialog')
})

test('resolveComponentUrl: unsafe module bypasses alias tables', () => {
  manager.addAlias('', '/ai', '/pwned', 'global')
  assert.equal(resolveComponentUrl('ai-box', runtimeOf('', true)), '/ai/box')
})
