import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setupDom } from './harness.js'
setupDom()
const { NativeExecutor } = await import('../src/execution/native.js')
const { ModuleResources } = await import('../src/resource.js')
const { registerModule } = await import('../src/execution/context.js')
const { bumpImportEpoch } = await import('../src/imports.js')

async function fixture(t, files) {
  const dir = await mkdtemp(join(tmpdir(), 'vhtml-native-import-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await Promise.all(Object.entries({ 'package.json': '{"type":"module"}', ...files }).map(async ([name, source]) => {
    const path = join(dir, name)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, source)
  }))
  const base = pathToFileURL(dir + '/'), mod = { scoped: '/native' }
  const resources = new ModuleResources({ origin: 'http://localhost', scoped: mod.scoped, unsafe: false })
  const resolve = resources.resolve.bind(resources)
  // Node cannot import HTTP modules. Keep the real module/referrer resolution,
  // then map its checked URL to a local ESM fixture without losing query/hash.
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
  return { execution, mod, runtime: { $mod: mod, source: 'http://localhost/native/views/page.html' } }
}

test('env, routes, static and dynamic native imports retain resolution and cache-busting behavior', async t => {
  const { execution, mod, runtime } = await fixture(t, {
    'env.js': `const token = {}; export default (mod, context) => { mod.marker = context.marker; mod.envToken = token; mod.envURL = import.meta.url }`,
    'routes.js': `const token = {}; export default ({$mod}) => [{path:'/',component:'/page',meta:{marker:$mod.marker,token,url:import.meta.url}}]`,
    'views/shared.js': `export const token = {}; export const url = import.meta.url`,
    'root.js': `export default 'module root'`,
  })
  const read = async () => {
    await execution.environment(mod, { marker: 42 }, true)
    const routes = await execution.routes('./routes.js?kind=route', { $mod: mod })
    const first = {}, second = {}
    await Promise.all([first, second].map(data => execution.execute(
      `import {token, url} from './shared?kind=setup';`, data, runtime
    )))
    const dynamic = await execution.evaluate(`import('./shared?kind=setup')`, {}, runtime)
    const root = await execution.evaluate(`import('/root.js')`, {}, runtime)
    assert.equal(first.token, second.token)
    assert.equal(first.token, dynamic.token)
    assert.equal(root.default, 'module root')
    assert.equal(routes.routes[0].meta.marker, 42)
    assert(new URL(first.url).pathname.endsWith('/views/shared.js'), 'setup imports resolve relative to their source and append .js')
    assert.equal(new URL(first.url).searchParams.get('kind'), 'setup')
    assert.equal(new URL(routes.routes[0].meta.url).searchParams.get('kind'), 'route')
    return { env: { token: mod.envToken, url: mod.envURL }, route: routes.routes[0].meta, setup: first }
  }
  const before = await read(), cached = await read()
  for (const name of ['env', 'route', 'setup']) assert.equal(cached[name].token, before[name].token)
  bumpImportEpoch()
  const after = await read()
  for (const name of ['env', 'route', 'setup']) {
    assert.notEqual(after[name].token, before[name].token)
    assert.notEqual(new URL(after[name].url).searchParams.get('__ve'), new URL(before[name].url).searchParams.get('__ve'))
  }
})

test('native import errors propagate from every script entry point', async t => {
  const { execution, mod, runtime } = await fixture(t, {
    'env.js': `export default () => { throw new Error('env initialization failed') }`,
    'broken.js': `throw new Error('module evaluation failed')`,
  })
  await assert.rejects(execution.environment(mod, {}, true), /env initialization failed/)
  await assert.rejects(execution.routes('./broken.js'), /module evaluation failed/)
  await assert.rejects(execution.execute(`import '/broken.js';`, {}, runtime), /module evaluation failed/)
  await assert.rejects(execution.evaluate(`import('/broken.js')`, {}, runtime), /module evaluation failed/)
  await assert.rejects(execution.execute(`import './missing';`, {}, runtime), /Cannot find module/)
})
