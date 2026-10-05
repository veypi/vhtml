import { test } from 'node:test'
import assert from 'node:assert/strict'
import { IsolatedExecutor } from '../src/execution/isolated.js'
import { ModuleResources } from '../src/resource.js'

async function executor(files = {}, options) {
  const requests = []
  const resources = new ModuleResources({ origin: 'https://app.test', scoped: '/modules/demo', unsafe: true }, {
    fetch: async url => {
      requests.push(url)
      if (!(url in files)) throw new Error(`Unexpected request ${url}`)
      return new Response(files[url])
    },
  })
  const vm = await IsolatedExecutor.create(resources, options)
  return { vm, requests, scope: vm.createScope() }
}

test('isolated scope preserves data/mod/sys/platform lookup without host globals', async () => {
  const { vm } = await executor()
  try {
    const scope = vm.createScope({ n: 1 }, { n: 2, modValue: 3 }, { n: 4, sysValue: 5 })
    assert.deepEqual(vm.evaluate('[n, modValue, sysValue, Math.max(2,3)]', scope), [1, 3, 5, 3])
    await vm.execute('count = 1; increment = () => ++count', scope)
    assert.equal(vm.evaluate('increment()', scope), 2)
    assert.equal(vm.evaluate('$data.count', scope), 2)
    assert.equal(vm.evaluate('window === self && self === globalThis && this === window', scope), true)
    assert.equal(vm.evaluate('[typeof process, typeof document, typeof XMLHttpRequest].join(",")', scope), 'undefined,undefined,undefined')
    assert.equal(vm.evaluate('"".constructor.constructor("return globalThis")() === window', scope), true)
    assert.equal(vm.evaluate('Object.getPrototypeOf(() => {}).constructor("return typeof process")()', scope), 'undefined')
  } finally { vm.dispose() }
})

test('host capability values are copied and host objects cannot leak into the VM', async () => {
  const { vm, scope } = await executor()
  try {
    const state = { n: 1 }
    vm.expose('data', () => state)
    vm.expose('bad', () => new AbortController())
    await vm.execute('copy = data(); copy.n = 9', scope)
    assert.equal(state.n, 1)
    assert.throws(() => vm.evaluate('bad()', scope), /Host objects/)
    vm.expose('load', async () => ({ result: 42 }))
    await vm.execute('answer = (await load()).result', scope)
    assert.equal(vm.evaluate('answer', scope), 42)
  } finally { vm.dispose() }
})

test('static and dynamic ESM imports share one scoped loader, including module dependencies', async () => {
  const files = {
    'https://app.test/modules/demo/lib.js': 'import { n } from "./value.js"; export default () => n + 1; export { n }',
    'https://app.test/modules/demo/value.js': 'export const n = 40',
    'https://app.test/modules/demo/later.js': 'export default async () => (await import("./value.js")).n + 2',
  }
  const { vm, scope, requests } = await executor(files)
  try {
    await vm.execute('import answer, { n as value } from "./lib.js"; total = answer() + value', scope, 'https://app.test/modules/demo/page.html')
    assert.equal(vm.evaluate('total', scope), 81)
    await vm.execute('const module = await import("./later.js"); later = await module.default()', scope, 'https://app.test/modules/demo/page.html')
    assert.equal(vm.evaluate('later', scope), 42)
    assert.equal(requests.filter(url => url.endsWith('/value.js')).length, 1)
    await assert.rejects(vm.execute('await import("@/private.js")', scope), /forbidden/)
    assert.equal(requests.length, 3)
  } finally { vm.dispose() }
})

test('timer callbacks stay in the VM and disposal cancels pending user code', async () => {
  const { vm, scope } = await executor()
  const received = []
  vm.expose('report', n => received.push(n))
  await vm.execute('await new Promise(resolve => setTimeout(resolve)); ready = true; setTimeout(() => report(1), 100)', scope)
  assert.equal(vm.evaluate('ready', scope), true)
  vm.dispose()
  await new Promise(resolve => setTimeout(resolve, 120))
  assert.deepEqual(received, [])
  assert.throws(() => vm.evaluate('ready', scope), /disposed/)
})

test('guest execution has a bounded CPU budget', async () => {
  const { vm, scope } = await executor({}, { timeLimit: 10 })
  try {
    assert.throws(() => vm.evaluate('while (true) {}', scope), /interrupted/)
    assert.equal(vm.evaluate('1 + 1', scope), 2)
  } finally { vm.dispose() }
})

test('disposing an executor rejects a suspended script', async () => {
  const { vm, scope } = await executor()
  vm.expose('never', () => new Promise(() => {}))
  const pending = vm.execute('await never()', scope)
  await new Promise(resolve => setTimeout(resolve, 1))
  vm.dispose()
  await assert.rejects(pending, /disposed/)
})

test('the renderer subscribes to guest state without copying it or losing row identity', async () => {
  const { Watch, Cancel, Wrap, DataID } = await import('../src/reactive.js')
  const { vm, scope } = await executor()
  let effect
  try {
    await vm.execute('count = 0; rows = [{n: 1}, {n: 2}]; increment = () => count++', scope)
    const data = vm.data(scope), values = []
    const first = data.rows[0]
    effect = Watch(() => vm.read('count', scope), n => values.push(n))
    vm.read('increment()', scope)
    await new Promise(resolve => setTimeout(resolve, 40))
    assert.deepEqual(values, [0, 1])
    vm.read('rows.unshift({n: 0})', scope)
    assert.equal(data.rows[1], first)
    assert.equal(data.rows[1][DataID], first[DataID])
    const row = Wrap({ item: first }, data)
    assert.equal(row.count, 1)
    row.item.n = 9
    assert.equal(vm.evaluate('rows[1].n', scope), 9)
    assert.deepEqual(Object.keys(data.rows), ['0', '1', '2'])
    Cancel(effect)
    vm.read('increment()', scope)
    await new Promise(resolve => setTimeout(resolve, 40))
    assert.deepEqual(values, [0, 1])
  } finally { Cancel(effect); vm.dispose() }
})

test('async guest callbacks resolve through the bridge instead of exposing a Promise object', async () => {
  const {vm,scope} = await executor()
  try {
    await vm.execute('guard = async () => { await new Promise(resolve => setTimeout(resolve,1)); return false }',scope)
    assert.equal(await vm.data(scope).guard(),false)
  } finally {vm.dispose()}
})
