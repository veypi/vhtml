import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setupDom, loadSrc, flush } from './harness.js'
setupDom()
const VHTML = await loadSrc()
const { NativeExecutor } = await import('../src/execution/native.js')
const { IsolatedExecutor } = await import('../src/execution/isolated.js')
const { ModuleResources } = await import('../src/resource.js')
const { ModuleContextManager } = await import('../src/module.js')
const { TemplateLoader } = await import('../src/loader.js')
const { errorLog } = await import('../src/errors.js')
const { AsyncRun } = await import('../src/sandbox.js')
const gate = () => {
  let resolve
  const promise = new Promise((r) => {
    resolve = r
  })
  return { promise, resolve }
}

test('native and isolated execution share expression and lookup semantics', async () => {
  const native = new NativeExecutor()
  const vm = await IsolatedExecutor.create(
    new ModuleResources({
      origin: 'http://localhost',
      scoped: '/demo',
      unsafe: true,
    })
  )
  const data = { value: 'data' },
    mod = { value: 'module', m: 3 },
    sys = { m: 4, s: 5 },
    locals = { value: 'locals', s: 6, local: 7 }
  const scope = vm.createScope(data, mod, sys)
  try {
    for (const source of [
      '(1 + 2)',
      '({n:1}).n',
      '(() => 9)()',
      'value',
      'm + s + local',
      '1 + 2;',
      'function () { return 8 }',
      '/https?:\\/\\//.test("https://a")',
      '"//" // comment',
    ]) {
      let a = native.evaluate(source, data, { $mod: mod, $sys: sys }, locals)
      let b = vm.read(source, scope, locals)
      if (typeof a === 'function') {
        a = a()
        b = b()
      }
      assert.equal(a, b, source)
    }
  } finally {
    vm.dispose()
  }
})

test('concurrent env contexts keep aliases and nested module loads bound to their owner', async () => {
  const originalFetch = globalThis.fetch,
    originalImport = NativeExecutor.prototype.import
  const startedA = gate(),
    startedB = gate(),
    releaseA = gate(),
    releaseB = gate()
  const seen = []
  const manager = new ModuleContextManager()
  globalThis.fetch = async (input) => {
    const url = new URL(input)
    return new Response('', {
      headers: { 'vhtml-scoped': url.pathname.replace(/\/env.js$/, '') },
    })
  }
  NativeExecutor.prototype.import = async function () {
    const scoped = this.resources.meta.scoped
    return {
      default: async (_mod, context) => {
        seen.push(scoped)
        if (scoped === '/a') {
          startedA.resolve()
          await releaseA.promise
        }
        if (scoped === '/b') {
          startedB.resolve()
          await releaseB.promise
        }
        context.addAlias('ui', `${scoped}/ui`)
        if (scoped === '/a' || scoped === '/b')
          await context.loadModule('child')
      },
    }
  }
  try {
    const a = manager.getModule('/a')
    await startedA.promise
    const b = manager.getModule('/b')
    await startedB.promise
    releaseA.resolve()
    await a
    releaseB.resolve()
    await b
    assert.equal(manager.getAliases('/a').ui, '/a/ui')
    assert.equal(manager.getAliases('/b').ui, '/b/ui')
    assert(seen.includes('/a/child'))
    assert(seen.includes('/b/child'))
  } finally {
    globalThis.fetch = originalFetch
    NativeExecutor.prototype.import = originalImport
    manager.clear()
  }
})

test('env errors reject and preserve the first metadata for a clean retry', async () => {
  const fetch = globalThis.fetch,
    importer = NativeExecutor.prototype.import
  const manager = new ModuleContextManager()
  globalThis.fetch = async () =>
    new Response('', { headers: { 'vhtml-scoped': '/broken' } })
  NativeExecutor.prototype.import = async () => ({
    default: () => {
      throw new Error('invalid config')
    },
  })
  try {
    await assert.rejects(manager.getModule('/broken'), /invalid config/)
    assert.equal(manager.modMap.size, 0)
    const metadata = manager.moduleMetadata.get('/broken')
    NativeExecutor.prototype.import = async () => ({
      default: (mod) => mod.define('ready', true),
    })
    assert.equal((await manager.getModule('/broken')).ready, true)
    assert.equal(manager.moduleMetadata.get('/broken'), metadata)
  } finally {
    globalThis.fetch = fetch
    NativeExecutor.prototype.import = importer
    manager.clear()
  }
})

test('template scope lookup and invalidation use canonical resource identities', async () => {
  const fetch = globalThis.fetch
  const manager = new ModuleContextManager(),
    loader = new TemplateLoader(manager)
  globalThis.fetch = async (input) =>
    new Response(String(input).endsWith('/env.js') ? '' : '<body>ok</body>', {
      status: String(input).endsWith('/env.js') ? 404 : 200,
      headers: { 'vhtml-scoped': '/demo' },
    })
  try {
    const descriptor = await loader.fetchUI('/demo/page.html?v=1')
    const runtime = { $mod: descriptor.mod }
    assert.equal(loader.scopeOf('/page.html?v=1', runtime), '/demo')
    assert.equal(await loader.fetchUI('/page.html?v=1', runtime), descriptor)
    loader.clearScoped('http://localhost/demo')
    assert.equal(loader.scopeOf('/page.html?v=1', runtime), null)
    assert.equal(manager.modMap.size, 0)
  } finally {
    globalThis.fetch = fetch
    loader.clear()
  }
})

test('descriptor parsing does not execute scripts or inject styles', async () => {
  const manager = new ModuleContextManager(),
    loader = new TemplateLoader(manager)
  const mod = await manager.getModule('')
  const before = document.head.childNodes.length
  const descriptor = loader.parser.parse(
    '<head><script>window.__parserRan = true</script><style>p{color:red}</style></head><body><p>ok</p></body>',
    mod,
    'http://localhost/pure.html'
  )
  assert.equal(window.__parserRan, undefined)
  assert.equal(document.head.childNodes.length, before)
  assert.equal(descriptor.heads[0].tag, 'script')
  assert(descriptor.styles.includes('red'))
  loader.clear()
})

test('parseRaw resolves after async setup and rejects mount failures', async () => {
  const host = document.createElement('div')
  document.body.append(host)
  const app = new VHTML({ target: host })
  await app.ready
  const pendingSetup = gate()
  window.__setupGate = pendingSetup.promise
  let finished = false
  try {
    const pending = app
      .parseRaw(
        host,
        {},
        {},
        '<body><p>{{answer}}</p><script setup>answer = await window.__setupGate</script></body>'
      )
      .then(() => {
        finished = true
      })
    await flush(10)
    assert.equal(finished, false)
    pendingSetup.resolve(42)
    await pending
    assert.equal(host.querySelector('p').textContent, '42')
    await assert.rejects(
      app.parseRaw(
        host,
        {},
        {},
        '<body><script setup>throw new Error("bad setup")</script></body>'
      ),
      /bad setup/
    )
    assert.match(host.textContent, /bad setup/)
  } finally {
    delete window.__setupGate
    app.destroy()
    host.remove()
  }
})

test('async diagnostics retain the runtime that initiated execution', async () => {
  const a = gate(),
    b = gate()
  const pa = AsyncRun(
    'await wait; throw new Error("a failure")',
    { wait: a.promise },
    { diagnostic: { vsrc: 'a.html' } }
  )
  const pb = AsyncRun(
    'await wait; throw new Error("b failure")',
    { wait: b.promise },
    { diagnostic: { vsrc: 'b.html' } }
  )
  const caughtA = assert.rejects(pa, /a failure/),
    caughtB = assert.rejects(pb, /b failure/)
  a.resolve()
  await caughtA
  b.resolve()
  await caughtB
  assert.equal(
    errorLog.findLast((x) => x.message === 'a failure').component.vsrc,
    'a.html'
  )
  assert.equal(
    errorLog.findLast((x) => x.message === 'b failure').component.vsrc,
    'b.html'
  )
})

test('optional sandbox env does not hide missing dependencies and routes retain module context', async () => {
  const { ModuleExecutor } = await import('../src/execution/module-executor.js')
  const files = new Map()
  const resources = new ModuleResources(
    { origin: 'http://localhost', scoped: '/isolated', unsafe: true },
    {
      fetch: async (url) =>
        new Response(files.get(url) || '', {
          status: files.has(url) ? 200 : 404,
        }),
    }
  )
  const executor = await ModuleExecutor.create(resources)
  try {
    await executor.environment()
    files.set(
      'http://localhost/isolated/env.js',
      'import "./missing.js"; export default () => {}'
    )
    await assert.rejects(
      executor.environment(),
      (error) => error.status === 404 && error.url.endsWith('/missing.js')
    )
    files.set(
      'http://localhost/isolated/routes.js',
      'export default async ({$mod}) => { await Promise.resolve(); return [{path:"/",component:$mod.scoped+"/page"}] }'
    )
    const result = await executor.routes('./routes.js')
    assert.equal(result.routes[0].component, '/isolated/page')
  } finally {
    executor.dispose()
  }
})

test('CLI uses shared import parsing and rejects non-static two-way bindings', async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { fileURLToPath } = await import('node:url')
  const { spawnSync } = await import('node:child_process')
  const dir = await mkdtemp(tmpdir() + '/vhtml-check-')
  const html = dir + '/page.html'
  const cli = fileURLToPath(new URL('../cli/vhtml/check.mjs', import.meta.url))
  const env = {
    ...process.env,
    VHTML_COMPILE_CORE: fileURLToPath(
      new URL('../src/compile.js', import.meta.url)
    ),
  }
  try {
    await writeFile(
      html,
      `<body><input v:value="item.name"><script setup>import './side-effect.js'; import {value} from './data.js'; result = await import('./later.js');</script></body>`
    )
    const valid = spawnSync(process.execPath, [cli, '--json', html], {
      env,
      encoding: 'utf8',
    })
    assert.equal(valid.status, 0, valid.stdout + valid.stderr)
    await writeFile(html, `<body><input v:value="items[index]"></body>`)
    const invalid = spawnSync(process.execPath, [cli, '--json', html], {
      env,
      encoding: 'utf8',
    })
    assert.equal(invalid.status, 1)
    assert(
      JSON.parse(invalid.stdout).some((item) =>
        item.message.includes('static property path')
      )
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
