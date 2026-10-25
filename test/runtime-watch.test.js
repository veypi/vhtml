import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadSrc, flush } from './harness.js'

await loadSrc()
const { Wrap } = await import('../src/reactive.js')
const { ComponentScope } = await import('../src/component-scope.js')
const { watch, publicWatch } = await import('../src/runtime-watch.js')

test('internal watch still returns a watcher handle for compiler teardown', () => {
  const scope = new ComponentScope()
  const state = Wrap({ n: 0 })
  const handle = watch(scope, () => state.n, () => {})
  assert.equal(typeof handle, 'object')
  assert.equal(typeof handle.deps?.[Symbol.iterator], 'function')
  scope.dispose()
})

test('public watch returns an idempotent unsubscribe function', async () => {
  const scope = new ComponentScope()
  const state = Wrap({ n: 0 })
  let calls = 0
  const stop = publicWatch(scope, () => state.n, () => calls++)

  assert.equal(typeof stop, 'function')
  assert.equal(calls, 1)
  assert.equal(scope.cleanups.size, 1)

  state.n++
  await flush()
  assert.equal(calls, 2)

  stop()
  stop()
  assert.equal(scope.cleanups.size, 0)
  state.n++
  await flush()
  assert.equal(calls, 2)
  scope.dispose()
})

test('public watch cancelled before the setup queue flushes never registers', () => {
  const scope = new ComponentScope()
  const state = Wrap({ n: 0 })
  let calls = 0
  scope.beginWatchQueue()
  const stop = publicWatch(scope, () => state.n, () => calls++)
  stop()
  scope.flushWatchQueue()
  assert.equal(calls, 0)
  assert.equal(scope.cleanups.size, 0)
  scope.dispose()
})
