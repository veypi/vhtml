import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadSrc, mount, flush, texts } from './harness.js'

await loadSrc()
const { Wrap, DataID } = await import('../src/reactive.js')
const { perfStats } = await import('../src/perf-stats.js')
const rowCounts = () => [perfStats.vforRowsCreated, perfStats.vforRowsMoved, perfStats.vforRowsDisposed]

test('equivalent 1,000-row list takes no-op path; prepend creates only the new row', async () => {
  const rows = Array.from({ length: 1000 }, (_, n) => ({ n }))
  const { app, host } = await mount('<b v-for="(row, i) in rows">{{i}}:{{row.n}}</b>', { rows })
  try {
    const original = [...host.querySelectorAll('b')], before = rowCounts(), noops = perfStats.vforNoops
    app._data.rows = rows.slice()
    await flush()
    assert.deepEqual(rowCounts(), before)
    assert.equal(perfStats.vforNoops, noops + 1)
    app._data.rows = [{ n: -1 }, ...rows]
    await flush()
    assert.deepEqual(rowCounts(), [before[0] + 1, before[1], before[2]])
    assert.ok(host.querySelectorAll('b')[1] === original[0])
    assert.equal(original[0].textContent, '1:0')
    app._data.rows = rows.slice().reverse()
    await flush()
    assert.ok(host.querySelectorAll('b')[0] === original[999])
    assert.equal(perfStats.vforRowsDisposed, before[2] + 1)
    app._data.rows = rows.map(row => ({ ...row }))
    await flush()
    assert.ok(host.querySelectorAll('b')[0] !== original[0])
    assert.equal(perfStats.vforRowsCreated, before[0] + 1001)
  } finally { app.destroy() }
})

test('function-source fresh raw rows position-merge even with a stale DataID stamp', async () => {
  const state = Wrap({ tick: 0 })
  const oldRaw = { text: 'a' }
  oldRaw[DataID] = 'legacy-stamp'
  const { app, host } = await mount('<b v-for="row in rows">{{row.text}}</b>', {
    rows: () => state.tick === 0 ? [oldRaw] : [{ text: `b${state.tick}`, [DataID]: 'another-stamp' }],
  })
  try {
    const original = host.querySelector('b')
    state.tick++
    await flush()
    assert.ok(host.querySelector('b') === original)
    assert.equal(original.textContent, 'b1')
    state.tick++
    await flush()
    assert.ok(host.querySelector('b') === original)
    assert.equal(original.textContent, 'b2')
  } finally { app.destroy() }
})

test('duplicate references render distinct rows and share field notifications', async () => {
  const row = { text: 'a' }
  const { app, host } = await mount('<b v-for="row in rows">{{row.text}}</b>', { rows: [row, row] })
  try {
    const original = [...host.querySelectorAll('b')]
    assert.equal(original.length, 2)
    assert.ok(original[0] !== original[1])
    app._data.rows = [row, row]
    await flush()
    assert.ok(host.querySelectorAll('b')[1] === original[1])
    app._data.rows[0].text = 'both'
    await flush()
    assert.deepEqual(texts(host, 'b'), ['both', 'both'])
  } finally { app.destroy() }
})

test('function primitive values and object iteration keys invalidate the fast path', async () => {
  const state = Wrap({ tick: 0 })
  const { app, host } = await mount('<b v-for="(v, k) in rows">{{k}}:{{v}}</b>', {
    rows: () => state.tick === 0 ? { a: 1 } : state.tick === 1 ? { a: 2 } : { b: 2 },
  })
  try {
    state.tick++; await flush()
    assert.deepEqual(texts(host, 'b'), ['a:2'])
    state.tick++; await flush()
    assert.deepEqual(texts(host, 'b'), ['b:2'])
  } finally { app.destroy() }
})
