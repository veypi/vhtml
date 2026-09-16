import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadSrc, mount, flush, texts } from './harness.js'

await loadSrc()
const { Wrap, EnsureWrap, SetDataRoot, Watch, Cancel, DataID, defineProperty, batch } = await import('../src/reactive.js')

test('distinct raw IDs cannot collide when browser clock and random values repeat', t => {
  t.mock.method(performance, 'now', () => 1)
  t.mock.method(Math, 'random', () => 0.5)
  const ids = new Set(Array.from({ length: 10000 }, () => Wrap({})[DataID]))
  assert.equal(ids.size, 10000)
})

test('one raw has one ordinary proxy across aliases, arrays and cyclic reads', async () => {
  const raw = { n: 1 }; raw.self = raw
  const array = [raw]; array.push(array)
  const p = Wrap({ a: raw, b: raw, array })
  assert.equal(p.a, p.b)
  assert.equal(p.a, p.array[0])
  assert.equal(p.a.self, p.a)
  assert.equal(p.array[1], p.array)
  assert.equal(Wrap(raw), p.a)
  assert.equal(Wrap(p.a), p.a)
  assert.equal(EnsureWrap(p.a), p.a)
  assert.notEqual(Wrap({ n: 1 })[DataID], p.a[DataID])
  let runs = 0, value
  const h = Watch(() => p.a.n + p.array[0].n, v => { value = v; runs++ })
  batch(() => { p.b.n = 2; p.array[0].n = 3 })
  await flush()
  assert.equal(value, 6)
  assert.equal(runs, 2)
  Cancel(h)
})

test('scope wrappers share own notifications but isolate roots and root rebinding', async () => {
  const raw = { local: 1 }
  const left = Wrap({ name: 'left' }), right = Wrap({ name: 'right' })
  const canonical = Wrap(raw), a = Wrap(raw, left), b = Wrap(raw, right)
  assert.notEqual(a, b)
  assert.equal(canonical.name, undefined)
  let av, bv, cv, aruns = 0
  const hs = [
    Watch(() => { aruns++; return `${a.local}:${a.name}` }, v => { av = v }),
    Watch(() => `${b.local}:${b.name}`, v => { bv = v }),
    Watch(() => canonical.local, v => { cv = v }),
  ]
  b.local = 2
  await flush()
  assert.deepEqual([av, bv, cv], ['2:left', '2:right', 2])
  SetDataRoot(a, right)
  await flush()
  assert.equal(av, '2:right')
  const before = aruns
  left.name = 'old'
  await flush()
  assert.equal(aruns, before, 'old inherited dependencies detached')
  a.name = 'new'
  await flush()
  assert.equal(right.name, 'new')
  assert.equal(bv, '2:new')
  defineProperty(a, 'name', 'local')
  await flush()
  assert.deepEqual([av, bv, right.name], ['2:local', '2:local', 'new'])
  delete a.name
  await flush()
  assert.equal(av, '2:new')
  SetDataRoot(a, null)
  await flush()
  assert.equal(av, '2:undefined')
  assert.equal(bv, '2:new')
  hs.forEach(Cancel)
})

test('scope getters use their receiver; EnsureWrap never retargets canonical data', async () => {
  const raw = { get label() { return this.name } }
  const ordinary = Wrap(raw), a = EnsureWrap(ordinary, Wrap({ name: 'a' }))
  const b = EnsureWrap(ordinary, Wrap({ name: 'b' }))
  assert.equal(ordinary.label, undefined)
  assert.equal(a.label, 'a')
  assert.equal(b.label, 'b')
  assert.equal(EnsureWrap(a, Wrap({ name: 'c' })), a)
  assert.equal(a.label, 'c')
  defineProperty(a, 'locked', 7, { writable: false, configurable: false })
  assert.throws(() => { b.locked = 8 }, TypeError)
  assert.equal(b.locked, 7)
})

test('legacy SetDataRoot promotes only the supplied wrapper and invalidates missing reads', async () => {
  const raw = {}, scope = Wrap(raw)
  let seen
  const h = Watch(() => scope.inherited, value => { seen = value })
  SetDataRoot(scope, Wrap({ inherited: 7 }))
  await flush()
  assert.equal(seen, 7)
  const ordinary = Wrap(raw)
  assert.ok(ordinary !== scope)
  assert.equal(ordinary.inherited, undefined)
  assert.equal(Wrap(raw), ordinary)
  Cancel(h)
})

test('excluded values and readonly descriptors preserve native behavior', () => {
  const values = [document.createElement('div'), new Date(), /a/, new Event('x'), { __noproxy: true }]
  for (const value of values) {
    assert.equal(Wrap(value), value)
    assert.equal(Wrap({ value }).value, value)
  }
  const nested = { n: 1 }, frozen = Object.freeze({ nested })
  assert.equal(Wrap(frozen).nested, nested, 'Proxy invariant for locked object-valued property')
})

test('prepend same raw retains original row, input state and shared updates across components', async () => {
  const raw = { label: 'existing' }
  const first = await mount('<ul><li v-for="row in rows"><input value="draft"><b>{{row.label}}</b></li></ul>', { rows: [raw] })
  const second = await mount('<b>{{item.label}}</b>', { item: raw })
  try {
    const li = first.host.querySelector('li'), input = li.querySelector('input')
    input.focus(); input.setSelectionRange(1, 3)
    first.app._data.rows = [{ label: 'new' }, raw]
    await flush()
    assert.equal(first.host.querySelectorAll('li')[1], li)
    assert.equal(document.activeElement, input)
    assert.equal(input.selectionStart, 1)
    second.app._data.item.label = 'changed'
    await flush()
    assert.deepEqual(texts(first.host, 'b'), ['new', 'changed'])
  } finally { first.app.destroy(); second.app.destroy() }
})
