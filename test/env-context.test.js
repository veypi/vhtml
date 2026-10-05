import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setupDom } from './harness.js'

setupDom()
const { ModuleContextManager } = await import('../src/module.js')
const { NativeExecutor } = await import('../src/execution/native.js')

test('native env globals support shared-service guards across nested loads and clear', async t => {
  const manager = new ModuleContextManager()
  t.after(() => manager.clear())
  const contexts = [], loaded = []
  let registrations = 0
  const environments = {
    '/app': async (mod, all) => {
      contexts.push(all)
      // AIC loads vhtml-ui before vbase. Its guard must see the service
      // registered by the nested env when that load finishes.
      if (!all.globals.$message) await all.loadModule('v')
      await all.loadModule('vb')
      mod.define('ready', all.globals.$message === mod.$message)
    },
    '/app/v': async (_mod, all) => {
      await Promise.resolve()
      if (!all.globals.$message) {
        registrations++
        all.define('$message', { show: () => 'message' })
      }
    },
    '/app/vb': async (mod, all) => {
      if (!all.globals.$message) await all.loadModule('v')
      // A local override must not hide the host's shared service from globals.
      mod.define('$message', 'local')
      assert.equal(all.globals.$message.show(), 'message')
    },
    '/nested': async (mod, all) => {
      if (!all.globals.$message) await all.loadModule('v')
      mod.define('ready', all.globals.$message === mod.$message)
    },
  }
  t.mock.method(globalThis, 'fetch', async input => {
    const scoped = new URL(input).pathname.replace(/\/env.js$/, '')
    assert(scoped in environments, `Unexpected nested module load: ${scoped}`)
    loaded.push(scoped)
    return new Response('', { headers: { 'vhtml-scoped': scoped } })
  })
  t.mock.method(NativeExecutor.prototype, 'import', async function () {
    return { default: environments[this.resources.meta.scoped] }
  })

  assert.equal((await manager.getModule('/app')).ready, true)
  assert.equal((await manager.getModule('/nested')).ready, true)
  assert.equal(registrations, 1)
  assert.deepEqual(loaded, ['/app', '/app/v', '/app/vb', '/nested'])
  const oldContext = contexts[0]
  assert.equal(oldContext.globals, manager.globals)
  assert(Object.isFrozen(oldContext))
  assert.equal(oldContext.modMap, undefined)

  manager.clear()
  assert.equal((await manager.getModule('/app')).ready, true)
  assert.equal(registrations, 2)
  assert.notEqual(contexts[1].globals, oldContext.globals)
  assert.equal(contexts[1].globals, manager.globals)
  assert.throws(() => oldContext.define('stale', true), /invalidated/)
})

test('isolated env still cannot access host globals', async t => {
  const manager = new ModuleContextManager()
  t.after(() => manager.clear())
  manager.define('hostSecret', 'private')
  t.mock.method(globalThis, 'fetch', async () => new Response(
    `export default (mod, all) => {
      mod.define('globalsType', typeof all.globals)
      mod.define('secretType', typeof mod.hostSecret)
    }`,
    { headers: { 'vhtml-scoped': '/isolated', 'vhtml-unsafe': '1' } }
  ))
  const mod = await manager.getModule('/isolated')
  assert.equal(mod.globalsType, 'undefined')
  assert.equal(mod.secretType, 'undefined')
  assert.equal(manager.globals.hostSecret, 'private')
})
