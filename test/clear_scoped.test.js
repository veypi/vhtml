/* Template cache behavior: scoped invalidation, concurrent loads and dependency races. */
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { setupDom } from './harness.js'
setupDom()
const { TemplateLoader } = await import('../src/loader.js')
const { ModuleContextManager } = await import('../src/module.js')
const { NativeExecutor } = await import('../src/execution/native.js')
const originalFetch = globalThis.fetch
const T = 'http://localhost/skills/local/a/ui/index.html'
const T2 = 'http://localhost/skills/local/a2/ui/index.html'
const OTHER = 'http://localhost/other/b.html'
const roots = ['/skills/local/a', '/skills/local/a2', '/other', '/pkg', '/pkg2', '/x']
let loader, manager, requests, respond

function gate() {
  let resolve
  const promise = new Promise(r => { resolve = r })
  return { promise, resolve }
}
function response(url) {
  if (url.pathname.endsWith('/env.js')) return new Response('', { status: 404 })
  const scoped = roots.find(root => url.pathname.startsWith(root + '/')) || ''
  return new Response(`<body><p>${url.pathname}</p></body>`, {
    headers: { 'vhtml-scoped': scoped },
  })
}
const calls = url => requests.filter(request => request.url === url).length
const load = (...urls) => Promise.all(urls.map(url => loader.fetchUI(url)))

beforeEach(() => {
  manager = new ModuleContextManager()
  loader = new TemplateLoader(manager)
  requests = []
  respond = response
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input))
    requests.push({ url: url.href, init })
    return respond(url, init)
  }
})
afterEach(() => {
  loader.clear()
  globalThis.fetch = originalFetch
})

test('clearScoped removes matching templates but preserves neighboring prefixes and modules', async () => {
  const abs = 'http://localhost/skills/local/a/abs.html'
  const [a, a2, other] = await load(T, T2, OTHER, abs)
  loader.clearScoped('/skills/local/a')
  assert.equal(loader.scopeOf(T), null)
  assert.equal(loader.scopeOf(abs), null)
  assert.equal(await loader.fetchUI(T2), a2)
  assert.equal(await loader.fetchUI(OTHER), other)
  assert.notEqual(await loader.fetchUI(T), a)
  assert.equal(calls(T), 2)
  assert.equal(calls(T2), 1)
  assert.equal(calls(OTHER), 1)
})

test('clearScoped matches canonical absolute URLs and respects the origin', async () => {
  const a = 'https://cdn.example.com/pkg/p.html'
  const sibling = 'https://cdn.example.com/pkg2/p.html'
  const otherOrigin = 'https://other.example.com/pkg/p.html'
  const [, b, c] = await load(a, sibling, otherOrigin)
  loader.clearScoped('https://cdn.example.com/pkg')
  assert.equal(loader.scopeOf(a), null)
  assert.equal(await loader.fetchUI(sibling), b)
  assert.equal(await loader.fetchUI(otherOrigin), c)
  await loader.fetchUI(a)
  assert.equal(calls(a), 2)
})

test('file invalidation covers the extensionless subtree without matching neighboring files', async () => {
  const urls = ['http://localhost/x/index.html', 'http://localhost/x/index/sub.html', 'http://localhost/x/index2.html']
  const [, , neighbor] = await load(...urls)
  loader.clearScoped('/x/index.html')
  assert.equal(loader.scopeOf(urls[0]), null)
  assert.equal(loader.scopeOf(urls[1]), null)
  assert.equal(await loader.fetchUI(urls[2]), neighbor)
})

test('scoped clearing releases matching styles and their deduplication entries', () => {
  const resources = loader.resourceLoader
  resources.loadStyle('.a{color:red}', T)
  resources.loadStyle('.b{color:blue}', OTHER)
  loader.clearScoped('/skills/local/a')
  assert.deepEqual([...document.head.querySelectorAll('style[vref]')].map(node => node.getAttribute('vref')), ['/other/b'])
  resources.loadStyle('.a{color:red}', T)
  resources.loadStyle('.b{color:blue}', OTHER)
  assert.equal(document.head.querySelectorAll('style[vref]').length, 2)
})

test('compact DOM references preserve canonical sources and distinguish foreign origins', async () => {
  respond = url => url.pathname.endsWith('/env.js') ? response(url) : new Response(
    '<head><style>body{color:red}.label{color:blue}</style></head><body><span class="label">ok</span><template><b>nested</b></template><script setup>value = 1</script></body>',
    { headers: { 'vhtml-scoped': '/pkg' } }
  )
  const localURL = 'http://localhost/pkg/page.html?v=1'
  const foreignURL = 'https://cdn.example.com/pkg/page.html?v=1'
  const local = await loader.fetchUI(localURL)
  const foreign = await loader.fetchUI(foreignURL)
  assert.equal(local.url, localURL)
  assert.equal(local.setup.source, localURL)
  assert.equal(local.body.getAttribute('vref'), '/pkg/page?v=1')
  assert.equal(local.body.querySelector('span').getAttribute('vrefof'), '/pkg/page?v=1')
  assert.equal(local.body.querySelector('template').content.firstElementChild.getAttribute('vrefof'), '/pkg/page?v=1')
  assert.match(local.styles, /\[vref="\/pkg\/page\?v=1"\]/)
  assert.match(local.styles, /\[vrefof="\/pkg\/page\?v=1"\]/)
  assert.equal(foreign.url, foreignURL)
  assert.equal(foreign.body.getAttribute('vref'), 'https://cdn.example.com/pkg/page?v=1')
  assert.equal(await loader.fetchUI('/pkg/page.html?v=1'), local)
  loader.clearScoped('/pkg/page.html')
  assert.equal(loader.scopeOf(localURL), null)
  assert.equal(await loader.fetchUI(foreignURL), foreign)
  assert.deepEqual([...document.head.querySelectorAll('style[vref]')].map(node => node.getAttribute('vref')), ['https://cdn.example.com/pkg/page?v=1'])
})

test('isolated inline and linked styles use the same compact reference as their host', async () => {
  respond = url => {
    if (url.pathname.endsWith('/env.js')) return response(url)
    return new Response(url.pathname.endsWith('.css')
      ? '.linked{color:blue}'
      : '<head><style>.label{color:red}</style><link rel="stylesheet" href="/theme.css"></head><body><span class="label linked">ok</span></body>',
    { headers: { 'vhtml-scoped': '/pkg', 'vhtml-unsafe': '1' } })
  }
  const descriptor = await loader.fetchUI('/pkg/page.html')
  assert.equal(descriptor.body.getAttribute('vref'), '/pkg/page')
  const styles = [...document.head.querySelectorAll('style[vref]')]
  assert.equal(styles.length, 2)
  for (const style of styles) {
    assert.equal(style.getAttribute('vref'), '/pkg/page')
    assert(style.textContent.includes('[vref="/pkg/page"]'))
    assert(!style.textContent.includes('http://localhost'))
  }
  loader.clearScoped('/pkg/page.html')
  assert.equal(document.head.querySelectorAll('style[vref]').length, 0)
})

test('scoped clearing rebuilds matching modules and aliases, preserving sibling modules', async () => {
  const [a, child, a2] = await Promise.all(['/skills/local/a', '/skills/local/a/sub', '/skills/local/a2'].map(path => manager.getModule(path)))
  manager.addAlias('/skills/local/a', 'ui', '/shared/ui')
  loader.clearScoped('/skills/local/a')
  assert.notEqual(await manager.getModule('/skills/local/a'), a)
  assert.notEqual(await manager.getModule('/skills/local/a/sub'), child)
  assert.equal(await manager.getModule('/skills/local/a2'), a2)
  assert.deepEqual(manager.getAliases('/skills/local/a'), {})
})

test('keepLive reloads descriptors while preserving module identity, aliases and styles', async () => {
  const first = await loader.fetchUI(T)
  manager.addAlias('/skills/local/a', 'ui', '/shared/ui')
  loader.resourceLoader.loadStyle('.a{color:red}', T)
  loader.clearScoped('/skills/local/a', { keepLive: true })
  assert.equal(loader.scopeOf(T), null)
  const next = await loader.fetchUI(T)
  assert.notEqual(next, first)
  assert.equal(next.mod, first.mod)
  assert.equal(manager.getAliases('/skills/local/a').ui, '/shared/ui')
  assert.equal(document.head.querySelectorAll('style[vref]').length, 1)
  assert.equal(calls(T), 2)
})

test('keepLive with an empty prefix clears all descriptors but preserves modules and styles', async () => {
  const [a, b] = await load(T, OTHER)
  loader.resourceLoader.loadStyle('.a{color:red}', T)
  loader.clearScoped('', { keepLive: true })
  assert.equal(loader.scopeOf(T), null)
  assert.equal(loader.scopeOf(OTHER), null)
  assert.equal((await loader.fetchUI(T)).mod, a.mod)
  assert.equal((await loader.fetchUI(OTHER)).mod, b.mod)
  assert.equal(document.head.querySelectorAll('style[vref]').length, 1)
})

test('same-URL callers share one request and scopeOf only exposes a ready descriptor', async () => {
  const started = gate(), release = gate()
  respond = async url => {
    if (url.href === T) { started.resolve(); await release.promise }
    return response(url)
  }
  const first = loader.fetchUI(T), second = loader.fetchUI(T)
  await started.promise
  assert.equal(calls(T), 1)
  assert.equal(loader.scopeOf(T), null)
  assert.equal(requests.find(request => request.url === T).init.cache, 'no-cache')
  release.resolve()
  const [a, b] = await Promise.all([first, second])
  assert.equal(a, b)
  assert.equal(loader.scopeOf(T), '/skills/local/a')
  assert.equal(loader.scopeOf('/ui/index.html', { $mod: a.mod }), '/skills/local/a')
  assert.equal(loader.scopeOf(T, { $mod: a.mod }), '/skills/local/a')
  assert.equal(loader.scopeOf('/not-loaded.html'), null)
  assert.equal(await loader.fetchUI(T), a)
  assert.equal(calls(T), 1)
})

test('clearing A preserves an unrelated in-flight template B', async () => {
  const started = gate(), release = gate()
  respond = async url => {
    if (url.href === OTHER) { started.resolve(); await release.promise }
    return response(url)
  }
  const pending = loader.fetchUI(OTHER)
  await started.promise
  loader.clearScoped('/skills/local/a')
  release.resolve()
  const descriptor = await pending
  assert.equal(await loader.fetchUI(OTHER), descriptor)
  assert.equal(calls(OTHER), 1)
})

for (const status of [200, 500]) {
  test(`an invalidated request (${status}) cannot replace or remove a newer same-URL load`, async () => {
    const started = gate(), release = gate()
    respond = async url => {
      if (url.href === T && calls(T) === 1) {
        started.resolve()
        await release.promise
        return new Response('<body>old</body>', { status })
      }
      return response(url)
    }
    const old = loader.fetchUI(T)
    const rejected = assert.rejects(old, /invalidated|HTTP 500/)
    await started.promise
    loader.clearScoped('/skills/local/a')
    const replacement = await loader.fetchUI(T)
    release.resolve()
    await rejected
    assert.equal(await loader.fetchUI(T), replacement)
    assert.equal(calls(T), 2)
  })
}

for (const mode of ['scoped', 'keepLive', 'all']) {
  test(`${mode} clearing during dependency preparation rejects stale results and stops subsequent scripts`, async t => {
    const started = gate(), release = gate()
    let laterScripts = 0
    t.mock.method(NativeExecutor.prototype, 'externalScript', async () => { started.resolve(); await release.promise })
    t.mock.method(NativeExecutor.prototype, 'script', async () => { laterScripts++ })
    respond = url => url.href === T
      ? new Response('<head><script src="/library.js"></script><script>later()</script></head><body>old</body>', { headers: { 'vhtml-scoped': '/skills/local/a' } })
      : response(url)
    const pending = loader.fetchUI(T)
    // Attach a rejection observer before resuming the paused dependency.
    const outcome = pending.then(value => ({ value }), error => ({ error }))
    await started.promise
    if (mode === 'all') loader.clear()
    else loader.clearScoped('/skills/local/a', { keepLive: mode === 'keepLive' })
    release.resolve()
    const result = await outcome
    assert.match(result.error?.message || '', /invalidated/)
    assert.equal(laterScripts, 0)
    assert.equal(loader.scopeOf(T), null)
  })
}

test('failed loads reject every waiting caller and can be retried', async () => {
  respond = url => url.href === T && calls(T) === 1
    ? new Response('', { status: 500 }) : response(url)
  const first = loader.fetchUI(T), second = loader.fetchUI(T)
  await Promise.all([assert.rejects(first, /HTTP 500/), assert.rejects(second, /HTTP 500/)])
  assert.equal(loader.scopeOf(T), null)
  const next = await loader.fetchUI(T)
  assert.equal(await loader.fetchUI(T), next)
  assert.equal(calls(T), 2)
})

test('clear removes templates, modules and styles together', async () => {
  const [a, b] = await load(T, OTHER)
  loader.resourceLoader.loadStyle('.a{color:red}', T)
  loader.clear()
  assert.equal(loader.scopeOf(T), null)
  assert.equal(loader.scopeOf(OTHER), null)
  assert.equal(document.head.querySelectorAll('style[vref]').length, 0)
  assert.notEqual((await loader.fetchUI(T)).mod, a.mod)
  assert.notEqual((await loader.fetchUI(OTHER)).mod, b.mod)
})

test('empty module prefix invalidates all module records and local aliases', async () => {
  const [a, b] = await Promise.all([manager.getModule('/a'), manager.getModule('/b')])
  manager.addAlias('/a', 'ui', '/shared/ui')
  manager.clearScoped('')
  assert.notEqual(await manager.getModule('/a'), a)
  assert.notEqual(await manager.getModule('/b'), b)
  assert.deepEqual(manager.getAliases('/a'), {})
})
