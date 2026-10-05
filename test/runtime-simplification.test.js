import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setupDom, loadSrc, flush } from './harness.js'
setupDom()
const VHTML = await loadSrc()
const { templateLoader } = await import('../src/loader.js')
const { instanceOf } = await import('../src/component-instance.js')
const { moduleRecord } = await import('../src/execution/context.js')
const { ModuleContextManager } = await import('../src/module.js')
const { NativeExecutor } = await import('../src/execution/native.js')
const { ModuleExecutor } = await import('../src/execution/module-executor.js')
const { IsolatedExecutor } = await import('../src/execution/isolated.js')
const { RenderPolicy } = await import('../src/execution/render-policy.js')
const { ModuleResources } = await import('../src/resource.js')
const { RouteMatcher } = await import('../src/router/matcher.js')
const { compileAttr } = await import('../src/compiler-attrs.js')

function gate() {
  let resolve
  const promise = new Promise(r => { resolve = r })
  return { promise, resolve }
}

test('failed module assembly releases installed capabilities, resources, and its VM', async () => {
  const resources = new ModuleResources({ origin: 'http://localhost', scoped: '/review', unsafe: true })
  const initialize = IsolatedExecutor.prototype.initializeModule
  const disposeRender = RenderPolicy.prototype.dispose
  let engine, releasedRender = 0
  IsolatedExecutor.prototype.initializeModule = function () {
    engine = this
    throw new Error('assembly failed')
  }
  RenderPolicy.prototype.dispose = function () {
    releasedRender++
    return disposeRender.call(this)
  }
  try {
    await assert.rejects(ModuleExecutor.create(resources), /assembly failed/)
    assert.equal(engine.disposed, true)
    assert.equal(releasedRender, 1)
    await assert.rejects(resources.open('/api'), /disposed/)
  } finally {
    IsolatedExecutor.prototype.initializeModule = initialize
    RenderPolicy.prototype.dispose = disposeRender
    engine?.dispose()
    resources.dispose()
  }
})

test('module termination completes once even if a capability cleanup throws', async () => {
  const resources = new ModuleResources({ origin: 'http://localhost', scoped: '/review', unsafe: true })
  const execution = await ModuleExecutor.create(resources)
  const disposeDOM = execution.dom.dispose, disposeRender = execution.render.dispose.bind(execution.render)
  const errors = []
  let releasedDOM = 0, releasedRender = 0
  execution.engine.onError = error => errors.push(error)
  execution.dom.dispose = () => {
    releasedDOM++
    disposeDOM()
    throw new Error('cleanup failed')
  }
  execution.render.dispose = () => { releasedRender++; disposeRender() }
  try {
    execution.engine.onFatal(new Error('fatal VM error'))
    execution.dispose()
    assert.equal(releasedDOM, 1)
    assert.equal(releasedRender, 1)
    assert.equal(execution.engine.disposed, true)
    assert.deepEqual(errors.map(error => error.message), ['cleanup failed'])
    await assert.rejects(resources.open('/api'), /disposed/)
  } finally { execution.dispose() }
})

async function mountModule(source, unsafe = true, files = {}) {
  const saved = globalThis.fetch
  templateLoader.clear()
  const host = document.createElement('div')
  document.body.append(host)
  globalThis.fetch = async input => {
    const path = new URL(String(input), 'http://localhost').pathname
    const headers = path.startsWith('/review/')
      ? { 'vhtml-scoped': '/review', ...(unsafe ? { 'vhtml-unsafe': '' } : {}) }
      : {}
    const text = path === '/review/page.html' ? source
      : path === '/review/env.js' && unsafe ? 'export default () => {}' : files[path]
    return new Response(text || '', { status: text === undefined ? 404 : 200, headers })
  }
  const app = new VHTML({ target: host })
  const close = () => {
    app.destroy()
    templateLoader.clear()
    host.remove()
    globalThis.fetch = saved
    // First metadata is immutable, so each fixture uses a fresh page/module identity.
    templateLoader.moduleManager.moduleMetadata.delete('/review')
  }
  try {
    await app.ready
    await app.parseRef('/review/page.html', host)
    const instance = instanceOf(host)
    const execution = moduleRecord(instance.runtime).execution
    return { host, app, instance, execution, close,
      run: code => execution.execute(code, instance.data, instance.runtime) }
  } catch (error) {
    close()
    throw error
  }
}

test('removed list rows release their execution state while the component stays mounted', async () => {
  const f = await mountModule(`<body><button v-for="row in rows" @click="row.count++">{{row.count}}:{{suffix}}</button><script setup>rows=[];suffix='ok'</script></body>`)
  const engine = f.execution.engine
  const create = engine.createScope.bind(engine)
  let extraScopes = 0
  engine.createScope = (...args) => { extraScopes++; return create(...args) }
  try {
    for (let round = 0; round < 5; round++) {
      await f.run('rows=Array.from({length:20},(_,i)=>({count:i}))')
      await flush()
      assert.equal(f.host.querySelectorAll('button').length, 20)
      f.host.querySelector('button').click()
      await flush()
      assert.equal(f.host.querySelector('button').textContent, '1:ok')
      await f.run('rows=[]')
      await flush()
      assert.equal(f.host.querySelectorAll('button').length, 0)
    }
    assert.equal(extraScopes, 0, 'temporary row data must not allocate persistent VM frames')
    assert.equal(f.instance.scope.phase, 'mounted')
  } finally { f.close() }
})

for (const unsafe of [false, true]) {
  test(`${unsafe ? 'isolated' : 'native'} bindings track nested styles and update dirty form properties`, async () => {
    const f = await mountModule(`<body>
      <p style="padding:3px">text</p>
      <input :value="label"><input type="checkbox" :checked="checked">
      <script setup>styles={color:'red',marginTop:'2px'};label='first';checked=true</script>
      </body>`, unsafe)
    try {
      const p = f.host.querySelector('p'), [input, check] = f.host.querySelectorAll('input')
      // happy-dom clones style/:style onto the same attribute slot. Compile the
      // binding after cloning; the browser fixture covers both literal attributes.
      compileAttr(p, ':style', 'styles', f.instance.data, f.instance.runtime)
      assert.equal(p.style.color, 'red')
      input.value = 'edited'
      check.checked = false
      await f.run("styles.color='blue';delete styles.marginTop;label='second';checked=false")
      await flush()
      assert.equal(p.style.color, 'blue')
      assert.equal(p.style.marginTop, '')
      assert.equal(p.style.padding, '3px', 'static styles survive dynamic updates')
      assert.equal(input.value, 'second')
      await f.run("styles='color:green!important';checked=true")
      await flush()
      assert.equal(p.style.color, 'green')
      assert.equal(p.style.getPropertyPriority('color'), 'important')
      assert.equal(p.style.padding, '3px')
      assert.equal(check.checked, true)
    } finally { f.close() }
  })
}

test('cleared env contexts cannot change the replacement module or shared registrations', async () => {
  const savedFetch = globalThis.fetch, savedImport = NativeExecutor.prototype.import
  const manager = new ModuleContextManager(), started = gate(), resume = gate()
  let oldContext, runs = 0
  globalThis.fetch = async () => new Response('', { headers: { 'vhtml-scoped': '/review' } })
  NativeExecutor.prototype.import = async () => ({ default: async (_mod, context) => {
    if (++runs === 1) {
      oldContext = context
      started.resolve()
      await resume.promise
      throw new Error('old env failed')
    }
    context.addAlias('ui', '/review/new')
    context.define('current', 'new')
  } })
  try {
    const old = manager.getModule('/review')
    const failed = assert.rejects(old, /old env failed/)
    await started.promise
    manager.clearScoped('/review')
    const current = await manager.getModule('/review')
    assert.throws(() => oldContext.addAlias('ui', '/review/old'), /invalidated/)
    assert.throws(() => oldContext.addAlias('global', '/old', true), /invalidated/)
    assert.throws(() => oldContext.define('current', 'old'), /invalidated/)
    assert.throws(() => oldContext.loadModule('child'), /invalidated/)
    resume.resolve()
    await failed
    assert.equal(await manager.getModule('/review'), current)
    assert.equal(manager.getAliases('/review').ui, '/review/new')
    assert.equal(manager.globals.current, 'new')
  } finally {
    resume.resolve()
    manager.clear()
    globalThis.fetch = savedFetch
    NativeExecutor.prototype.import = savedImport
  }
})

test('module discovery deduplicates requests and a scoped clear preserves other pending modules', async () => {
  const savedFetch = globalThis.fetch, savedImport = NativeExecutor.prototype.import
  const manager = new ModuleContextManager(), started = gate(), resume = gate()
  let fetches = 0, cancelled = 0, imports = 0
  globalThis.fetch = async () => {
    fetches++
    started.resolve()
    await resume.promise
    return new Response(new ReadableStream({ cancel() { cancelled++ } }), {
      headers: { 'vhtml-scoped': '/other' },
    })
  }
  NativeExecutor.prototype.import = async () => { imports++; return { default: () => {} } }
  try {
    const a = manager.getModule('/other'), b = manager.getModule('/other')
    await started.promise
    manager.clearScoped('/review')
    resume.resolve()
    assert.equal(await a, await b)
    assert.equal(fetches, 1, 'reuse discovery instead of probing env again')
    assert.equal(cancelled, 1, 'release the discovery response body')
    assert.equal(imports, 1)
  } finally {
    resume.resolve()
    manager.clear()
    globalThis.fetch = savedFetch
    NativeExecutor.prototype.import = savedImport
  }
})

test('isolated route callbacks receive data snapshots and a guest-owned next callback', async () => {
  const source = `export default ({$mod}) => ({
    routes:[{path:'/item/:id',component:'/item',
      cacheKey:m=>m.route.path+':'+m.params.id,
      redirect:m=>m.params.redirect ? '/login' : null,
      error_redirect:(m,error)=>error.message==='missing'?'/error':null}],
    beforeEnter:async(to,from,next)=>{
      await Promise.resolve();
      $mod.define('guard', [to.matched[0].path, typeof to.matched[0].matcher,
        next.constructor('return typeof process')(), from.path].join(':'));
      if(to.params.redirect) next({path:'/login',query:{reason:'guard'}});
      return !to.params.block;
    },
    afterEnter:(to,from)=>{$mod.define('after',to.path+':'+from.path)}
  })`
  const resources = new ModuleResources({ origin:'http://localhost', scoped:'/review', unsafe:true }, {
    fetch: async () => new Response(source),
  })
  const execution = await ModuleExecutor.create(resources)
  try {
    const routes = await execution.routes('./routes.js')
    const record = { ...routes.routes[0], matcher:new RouteMatcher('/item/:id') }
    const to = { path:'/item/1',fullPath:'/item/1',params:{id:'1'},matched:[record] }
    const from = { path:'/before' }, redirects = []
    assert.equal(await routes.beforeEnter(to, from, target=>redirects.push(target)), true)
    assert.equal(execution.mod.guard, '/item/:id:undefined:undefined:/before')
    assert.equal(await routes.beforeEnter({...to,params:{block:true}},from,()=>{}), false)
    await routes.beforeEnter({...to,params:{redirect:true}},from,target=>redirects.push(target))
    assert.equal(redirects[0].path, '/login')
    assert.equal(redirects[0].query.reason, 'guard')
    const match = { ...to,route:record }
    assert.equal(record.cacheKey(match), '/item/:id:1')
    assert.equal(record.redirect({...match,params:{redirect:true}}), '/login')
    assert.equal(record.error_redirect(match,new Error('missing')), '/error')
    routes.afterEnter(to,from)
    assert.equal(execution.mod.after, '/item/1:/before')
  } finally { execution.dispose() }
})

test('a real isolated router mounts, redirects through an async guard, and stays navigable', async () => {
  const f = await mountModule('<body><vrouter history="memory" initial="/review/item/1"></vrouter></body>', true, {
    '/review/routes.js': `export default {routes:[{path:'/item/:id',component:'/item'},{path:'/login',component:'/login'}],
      beforeEnter:async(to,from,next)=>{await Promise.resolve();if(to.params.id==='2'){next('/login');return false}},
      afterEnter:(to)=>{globalThis.lastRoute=to.path}}`,
    '/review/item.html': '<body><p>item</p></body>',
    '/review/login.html': '<body><p>login</p></body>',
  })
  try {
    await flush(150)
    const view = instanceOf(f.host.querySelector('vrouter')).runtime.$sys.$router
    assert.equal(f.host.querySelector('p')?.textContent, 'item')
    await view.push('/item/2')
    await flush(150)
    assert.equal(f.host.querySelector('p')?.textContent, 'login')
    assert.equal(view.current.path, '/review/login')
    await view.push('/item/3')
    await flush()
    assert.equal(view.current.params.id, '3')
    assert.equal(f.host.querySelector('p')?.textContent, 'item')
  } finally { f.close() }
})
