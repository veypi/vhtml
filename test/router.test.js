/*
 * router.test.js — v0.10.2 路由语义回归（导航级 happy-dom 挂载测试）
 *
 * 覆盖 todo 回归重点：快速连续导航、不同 layout 间返回、缓存页跨 layout
 * 跳转、query-only 快速路径、dropPage、memory history（OS 多窗口形态）、
 * 页缓存 LRU 上限、导航前缀三层语义（跨模块导航）。
 *
 * RouterView 经 <vrouter history="memory"> 挂载（renderer mountRouter →
 * $router.mountView），测试经 instanceOf(vr).runtime.$sys.$router 直取视图。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadSrc, flush } from './harness.js'

const VHTML = await loadSrc()
const { instanceOf } = await import('../src/component-instance.js')
const { setRouterRoutesSource } = await import('../src/router.js')

// ---- fetch 打桩：页面与 layout 组件 ----
const fakeHeaders = { get: () => null, entries: () => [][Symbol.iterator]() }
const page = (cls, setup) => `<!DOCTYPE html><html><head><title>t</title></head><body><div class="${cls}">${cls}</div></body>
<script setup>
${setup || ''}
</script></html>`
const TEMPLATES = {
  '/pg/a.html': page('pg-a', `window.__c.a = (window.__c.a || 0) + 1`),
  '/pg/b.html': page('pg-b', `window.__c.b = (window.__c.b || 0) + 1`),
  '/pg/x.html': page('pg-x', `window.__c.x = (window.__c.x || 0) + 1`),
  '/pg/y.html': page('pg-y', `window.__c.y = (window.__c.y || 0) + 1`),
  '/pg/z.html': page('pg-z', `window.__c.z = (window.__c.z || 0) + 1`),
  '/layout/default.html': `<!DOCTYPE html><html><head><title>L</title></head><body><div class="lay"><span class="lay-t">L1</span><div data-vrouter-outlet></div></div></body>
<script setup>
window.__c.lay1 = (window.__c.lay1 || 0) + 1
</script></html>`,
  '/layout/alt.html': `<!DOCTYPE html><html><head><title>L2</title></head><body><div class="lay-alt"><div data-vrouter-outlet></div></div></body></html>`,
}
const realFetch = globalThis.fetch
const stubFetch = async (url) => {
  const u = String(url).split('?')[0]
  if (u === '/pg/slow.html') {
    await new Promise((r) => setTimeout(r, 80))   // 慢页面：导航竞态窗口
    return { ok: true, status: 200, headers: fakeHeaders, text: async () => page('pg-slow') }
  }
  for (const [key, html] of Object.entries(TEMPLATES)) {
    if (u.endsWith(key)) return { ok: true, status: 200, headers: fakeHeaders, text: async () => html }
  }
  return realFetch ? realFetch(url) : { ok: false, status: 404, headers: fakeHeaders, text: async () => '' }
}
globalThis.fetch = stubFetch
window.fetch = stubFetch

const ROUTES = [
  { path: '/a', component: '/pg/a' },
  { path: '/b', component: '/pg/b' },
  { path: '/slow', component: '/pg/slow' },
  { path: '/x', component: '/pg/x', layout: 'default' },
  { path: '/y', component: '/pg/y', layout: 'default' },
  { path: '/z', component: '/pg/z', layout: 'alt' },
]

async function createRouter(initial = '/a', routes = ROUTES, beforeEnter = null, extra = {}) {
  window.__c = {}
  const host = document.createElement('div')
  const vr = document.createElement('vrouter')
  vr.setAttribute('history', 'memory')
  vr.setAttribute('initial', initial)
  // extra.attrs → vrouter 元素属性（如 prefix）；其余键 → 路由模块字段（如 path_prefix）
  const { attrs, ...sourceExtra } = extra
  for (const [key, value] of Object.entries(attrs || {})) vr.setAttribute(key, String(value))
  host.appendChild(vr)
  setRouterRoutesSource(vr, { routes, ...(beforeEnter ? { beforeEnter } : {}), ...sourceExtra })
  document.body.appendChild(host)
  const app = new VHTML({ target: host, data: {} })
  await app.ready
  await flush()
  const view = instanceOf(vr)?.runtime?.$sys?.$router
  assert.ok(view && typeof view.push === 'function', 'router view mounted')
  return { app, host, vr, view }
}

test('basic mount and push: page content swaps, current updates', async () => {
  const { app, host, view } = await createRouter('/a')
  assert.ok(host.querySelector('.pg-a'), 'initial page mounted')
  assert.equal(view.current.fullPath, '/a')

  await view.push('/b')
  await flush()
  assert.ok(host.querySelector('.pg-b'), 'page b mounted')
  assert.ok(!host.querySelector('.pg-a'), 'page a detached (cached)')
  assert.equal(view.current.fullPath, '/b')
  assert.equal(view.activePage.htmlPath, '/pg/b.html')
  app.destroy()
})

test('page cache: same path navigation reuses instance (no setup re-run)', async () => {
  const { app, host, view } = await createRouter('/a')
  assert.equal(window.__c.a, 1, 'initial setup ran once')
  await view.push('/b')
  await view.push('/a')
  await flush()
  assert.equal(window.__c.a, 1, 'cached page reused, setup not re-run')
  assert.ok(host.querySelector('.pg-a'), 'cached page re-attached')
  const keys = view.cachedPages().map((p) => p.key)
  assert.deepEqual([...keys].sort(), ['/a', '/b'], 'both pages cached')
  app.destroy()
})

test('shared layout: same-layout navigation keeps layout DOM identity', async () => {
  const { app, host, view } = await createRouter('/x')
  await flush()
  assert.ok(host.querySelector('.lay'), 'layout mounted')
  assert.equal(window.__c.lay1, 1, 'layout setup ran once')
  const layoutDom = host.querySelector('.lay')

  await view.push('/y')
  await flush()
  assert.strictEqual(host.querySelector('.lay'), layoutDom, 'layout DOM identity preserved')
  assert.equal(window.__c.lay1, 1, 'layout not remounted')
  assert.ok(host.querySelector('.pg-y'), 'content y inside layout outlet')
  assert.ok(!host.querySelector('.pg-x'), 'old content removed from outlet')
  const outlet = layoutDom.querySelector('[data-vrouter-outlet]')
  assert.ok(outlet.contains(host.querySelector('.pg-y')), 'y lives in the outlet')
  app.destroy()
})

test('layout switch and back: both layout and page identities preserved', async () => {
  const { app, host, view } = await createRouter('/x')
  await flush()
  const layoutDom = host.querySelector('.lay')
  const xDom = host.querySelector('.pg-x')

  await view.push('/z')
  await flush()
  assert.ok(host.querySelector('.lay-alt'), 'alt layout mounted')
  assert.ok(!host.querySelector('.lay'), 'default layout detached but cached')

  await view.push('/x')
  await flush()
  assert.strictEqual(host.querySelector('.lay'), layoutDom, 'default layout restored from cache (same DOM)')
  assert.strictEqual(host.querySelector('.pg-x'), xDom, 'page x restored from cache (same DOM)')
  assert.ok(layoutDom.contains(xDom), 'cached content re-attached into outlet')
  app.destroy()
})

test('query-only fast path: no remount, current.query updates', async () => {
  const { app, host, view } = await createRouter('/a')
  const aPage = view.activePage
  await view.push('/a?foo=1')
  await flush()
  assert.strictEqual(view.activePage, aPage, 'same page instance')
  assert.equal(window.__c.a, 1, 'no setup re-run')
  assert.equal(view.current.query.foo, '1', 'query synced')
  app.destroy()
})

test('rapid navigation: slow page superseded, final state clean', async () => {
  const { app, host, view } = await createRouter('/a')
  const p1 = view.push('/slow')   // 不 await：fetch 延迟 80ms，进入 resolving
  await view.push('/b')           // 更新导航，作废旧令牌
  await p1.catch(() => {})
  await flush(200)
  assert.ok(host.querySelector('.pg-b'), 'final page b active')
  assert.ok(!host.querySelector('.pg-slow'), 'superseded slow page not half-attached')
  assert.equal(view.current.fullPath, '/b', 'url committed to final target')
  assert.equal(view.activePage.htmlPath, '/pg/b.html')
  app.destroy()
})

test('dropPage: cached page removed; active page drop remounts', async () => {
  const { app, host, view } = await createRouter('/a')
  await view.push('/b')
  await flush()
  assert.equal(view.dropPage('/a'), true, 'cached page dropped')
  assert.ok(!view.cachedPages().some((p) => p.key === '/a'), 'gone from cache list')

  await view.push('/a')
  await flush()
  assert.equal(window.__c.a, 2, 'dropped page remounts fresh')

  assert.equal(view.dropPage('/a'), true, 'active page dropped')
  await flush(200)
  assert.ok(host.querySelector('.pg-a'), 'active page remounted after drop')
  assert.equal(window.__c.a, 3, 'remounted fresh')
  assert.equal(view.activePage.htmlPath, '/pg/a.html')
  app.destroy()
})

test('memory history: back/forward walk cached pages', async () => {
  const { app, host, view } = await createRouter('/a')
  await view.push('/b')
  await view.push('/x')
  await flush()
  await view.back()
  await flush()
  assert.ok(host.querySelector('.pg-b'), 'back lands on b')
  assert.equal(view.current.fullPath, '/b')
  await view.forward()
  await flush()
  assert.ok(host.querySelector('.pg-x'), 'forward returns to x')
  app.destroy()
})

test('page cache LRU: capped at 8, oldest evicted', async () => {
  const routes = []
  for (let i = 1; i <= 10; i++) {
    routes.push({ path: `/p${i}`, component: `/pg/p${i}`, cacheKey: `p${i}` })
    TEMPLATES[`/pg/p${i}.html`] = page(`pg-p${i}`)
  }
  const { app, host, view } = await createRouter('/p1', routes)
  for (let i = 2; i <= 10; i++) {
    await view.push(`/p${i}`)
    await flush()
  }
  const keys = view.cachedPages().map((p) => p.key).sort()
  assert.equal(keys.length, 8, 'cache capped at 8')
  assert.ok(!keys.includes('p1'), 'oldest evicted')
  assert.ok(!keys.includes('p2'), 'second oldest evicted')
  assert.ok(keys.includes('p10'), 'newest kept')
  assert.ok(host.querySelector('.pg-p10'), 'active page visible')
  app.destroy()
})

// ---- 路由参数（v0.10.2 回归：staging 写入目标快照，终止回滚） ----

const PARAM_ROUTES = [
  {
    path: '/a',
    component: '/pg/a',
    children: [
      {
        path: '/:agent_id',
        component: '/pg/u',
        children: [
          { path: '/chat', component: '/pg/chat', cacheKey: 'core' },
        ],
      },
    ],
  },
  { path: '/slow/:uid', component: '/pg/slow' },
]

function guardAfterFirst() {
  let n = 0
  return () => { n += 1; return n > 1 ? false : true }
}

test('route params: setup reads target params on first build, child inherits', async () => {
  TEMPLATES['/pg/u.html'] = page('pg-u', `window.__u = $router.params.agent_id || 'NONE'`)
  TEMPLATES['/pg/chat.html'] = page('pg-chat', `window.__chat = $router.params.agent_id || 'NONE'`)
  const { app, view } = await createRouter('/a/d735d979260540bdb4aeba051058b4ac', PARAM_ROUTES)
  await flush()
  assert.equal(window.__u, 'd735d979260540bdb4aeba051058b4ac', 'page setup reads params on first build')
  assert.equal(view.current.params.agent_id, 'd735d979260540bdb4aeba051058b4ac', 'current params committed')
  await view.push('/a/d735d979260540bdb4aeba051058b4ac/chat')
  await flush()
  assert.equal(window.__chat, 'd735d979260540bdb4aeba051058b4ac', 'child route inherits parent param')
  assert.equal(view.current.params.agent_id, 'd735d979260540bdb4aeba051058b4ac')
  app.destroy()
})

test('blocked navigation rolls back to last committed snapshot', async () => {
  const { app, view } = await createRouter('/a', PARAM_ROUTES, guardAfterFirst())
  await flush()
  assert.equal(view.current.fullPath, '/a')
  await view.push('/a/xyz')
  await flush()
  assert.equal(view.current.fullPath, '/a', 'current rolled back to committed path')
  assert.equal(Object.keys(view.current.params).length, 0, 'no staged params leaked')
  app.destroy()
})

test('superseded slow navigation does not leak staged params', async () => {
  const { app, view } = await createRouter('/a', PARAM_ROUTES)
  await flush()
  const p1 = view.push('/slow/abc')   // 80ms 慢：staging 已写入 /slow/abc 中间态
  await view.push('/a/xyz')            // 作废 p1 并覆盖中间态
  await p1.catch(() => {})
  await flush(200)
  assert.equal(view.current.fullPath, '/a/xyz', 'final navigation committed')
  assert.equal(view.current.params.uid, undefined, 'superseded params not leaked')
  assert.equal(view.current.params.agent_id, 'xyz', 'committed params intact')
  app.destroy()
})

test('superseded then blocked: rolls back to last commit, not staged middle state', async () => {
  // p1（慢）先进 staging 写入中间态；p2 随后进入被 beforeEnter 阻断，
  // 回滚目标必须是最近 commit（/a），而不是 p1 残留的 staging 中间态。
  const { app, view } = await createRouter('/a', PARAM_ROUTES)
  await flush()
  view.beforeEnter = guardAfterFirst()
  const p1 = view.push('/slow/abc')
  await new Promise((r) => setTimeout(r, 20))
  await view.push('/a/xyz')  // p2：beforeEnter 第二次调用返回 false → 阻断
  await p1.catch(() => {})
  await flush(200)
  assert.equal(view.current.fullPath, '/a', 'blocked p2 rolls back to last committed /a')
  assert.equal(view.current.params.uid, undefined, 'no staged uid leaked')
  assert.equal(view.current.params.agent_id, undefined, 'no staged agent_id leaked')
  app.destroy()
})

// ---- v0.10.2 回归：页面自身 URL 同步 watcher 与在途导航 ----
// chat.html 模式：setup 读路由参数 + $watch 首轮立即把本地状态同步回路由。
// 修复前：构建期首轮回调发起同目标导航 → issue() 作废正在构建的导航票据 →
// 构建静默中止（首页跳转无反应）；直接加载时 activePage 为空、无短路可兜底，
// 退化成无限构建循环卡死页面。不变式：幂等导航（同提交态/同在途目标）不得作废在途导航。

const SYNC_ROUTES = [
  { path: '/a', component: '/pg/a' },
  { path: '/p/:agent_id', component: '/pg/sync' },
]
TEMPLATES['/pg/sync.html'] = page('pg-sync', `
  id = $router.query.session_id || ''
  agent_id = $router.params.agent_id || ''
  syncRoute = () => {
    $router.setParams({agent_id: agent_id})
    $router.setQuery({session_id: id})
  }
  $watch(() => [id, agent_id], () => {
    if (!agent_id) return
    syncRoute()
  })
  window.__c.sync = (window.__c.sync || 0) + 1
`)

const hangGuard = (ms, what) => new Promise((_, rej) => setTimeout(() => rej(new Error(what)), ms))

test('sync-route page: direct load commits without infinite build loop', async () => {
  const { app, host, view } = await Promise.race([
    createRouter('/p/7', SYNC_ROUTES),
    hangGuard(5000, 'navigation hung: infinite build loop'),
  ])
  await flush()
  assert.ok(host.querySelector('.pg-sync'), 'page mounted on direct load')
  assert.equal(view.current.fullPath, '/p/7')
  assert.equal(view.current.params.agent_id, '7')
  assert.equal(window.__c.sync, 1, 'page built exactly once')
  app.destroy()
})

test('sync-route page: push from other page commits (not superseded by its own sync)', async () => {
  const { app, host, view } = await createRouter('/a', SYNC_ROUTES)
  await flush()
  await Promise.race([
    view.push('/p/7'),
    hangGuard(5000, 'push hung: infinite build loop'),
  ])
  await flush()
  assert.ok(host.querySelector('.pg-sync'), 'pushed page mounted')
  assert.equal(view.current.fullPath, '/p/7')
  assert.equal(window.__c.sync, 1, 'page built exactly once')
  app.destroy()
})

test('empty target is not a valid navigation', async () => {
  const { app, view } = await createRouter('/a')
  await flush()
  assert.equal(view.matchTo(''), null, 'matchTo("") must not resolve to current path')
  assert.equal(view.resolveHref(''), '', 'resolveHref("") passes through empty')
  assert.equal(view.current.fullPath, '/a', 'current unchanged')
  app.destroy()
})

test('href-less anchor (pure @click) gets no href/active pollution', async () => {
  TEMPLATES['/pg/btn.html'] = `<!DOCTYPE html><html><head><title>t</title></head><body><a class="btn" @click="hits=(hits||0)+1">go</a></body>
<script setup>
hits = 0
</script></html>`
  const { app, host } = await createRouter('/btn', [{ path: '/btn', component: '/pg/btn' }])
  await flush()
  const a = host.querySelector('a.btn')
  assert.ok(a, 'anchor rendered')
  assert.ok(!a.hasAttribute('href'), 'no href injected into href-less anchor')
  assert.ok(!a.hasAttribute('active'), 'no active injected into href-less anchor')
  app.destroy()
})

test('routes reload disposes previous layout instances (no shell leak)', async () => {
  const { app, host, vr } = await createRouter('/x')
  await flush()
  const layoutDom = host.querySelector('.lay')
  const layoutInst = instanceOf(layoutDom)   // 实例挂在 layout 根（body 包装）上，.lay 是其子级
  assert.ok(layoutInst, 'layout instance attached')
  assert.equal(layoutInst.scope.active, true)
  setRouterRoutesSource(vr, { routes: ROUTES })
  await flush()
  assert.equal(layoutInst.scope.phase, 'disposed', 'old layout disposed on routes reload')
  assert.ok(host.querySelector('.lay'), 'new layout mounted after reload')
  app.destroy()
})

test('redirect to missing page: swallowed into error registry, no unhandled rejection', async () => {
  const { errorLog } = await import('../src/errors.js')
  const routes = [
    ...ROUTES,
    { path: '/redir-missing', redirect: '/missing' },
    { path: '/missing', component: '/pg/missing' },
  ]
  const { app, view } = await createRouter('/a', routes)
  await view.push('/redir-missing')   // 内部 fire-and-forget push('/missing')：404 失败
  await flush()
  assert.equal(view.current.fullPath, '/a', 'failed redirect leaves current page untouched')
  const navErr = errorLog.find((e) => e.kind === 'navigation')
  assert.ok(navErr, 'navigation failure recorded in registry')
  assert.match(navErr.message, /load page failed/)
  app.destroy()
})

test('initial mount to missing page: error-box page committed, no white screen', async () => {
  const { errorLog } = await import('../src/errors.js')
  // 初始 deep link 组件 404（挂载即 miss）：mount 不抛穿杀应用（白屏 = 视觉
  // 静默空白）——降级错误盒页照常 commit，布局外壳在、错误三处暴露。
  const routes = [
    ...ROUTES,
    { path: '/boot-missing', component: '/pg/missing', layout: 'default' },
  ]
  const { app, host, view } = await createRouter('/boot-missing', routes)
  await flush()
  assert.ok(host.querySelector('.lay'), 'layout shell mounted around error box')
  const box = host.querySelector('[vsrc="/pg/missing.html"]')
  assert.ok(box, 'error page committed with vsrc marker')
  assert.match(box.textContent, /\[Load Error\] \/pg\/missing\.html/, 'error box visible')
  assert.equal(view.current.fullPath, '/boot-missing', 'bad deep link URL committed (visible + copyable)')
  const navErr = errorLog.find((e) => e.kind === 'navigation')
  assert.ok(navErr, 'mount failure recorded in registry')
  assert.match(navErr.message, /load page failed/)
  app.destroy()
})

// ---- vrouter title（双源：路由 nav.name 优先，页面 <title> 兜底；
//      虚拟 vrouter 只落宿主 __title，不碰 document.title）----
TEMPLATES['/pg/t1.html'] = `<!DOCTYPE html><html><head><title>Page One</title></head><body><div class="pg-t1">t1</div></body></html>`
TEMPLATES['/pg/t2.html'] = `<!DOCTYPE html><html><head><title>Page Two</title></head><body><div class="pg-t2">t2</div></body></html>`
const TITLE_ROUTES = [
  { path: '/t1', component: '/pg/t1' },
  { path: '/t2', component: '/pg/t2' },
]

test('vrouter title: page <title> 落 view.title + 宿主 __title，memory history 不碰 document.title', async () => {
  document.title = 'keep-me'
  const { app, vr, view } = await createRouter('/t1', TITLE_ROUTES)
  await flush()
  assert.equal(view.title, 'Page One')
  assert.equal(vr.__title, 'Page One')
  assert.equal(document.title, 'keep-me', '虚拟 vrouter 不得写 document.title')
  await view.push('/t2')
  await flush()
  assert.equal(view.title, 'Page Two')
  assert.equal(vr.__title, 'Page Two')
  app.destroy()
})

test('vrouter title: 路由节点 nav.instances 按 params 匹配出实例名，优先于页面 <title>', async () => {
  const routes = [
    { path: '/t3/:id', component: '/pg/t1', nav: {
      name: 'Category',
      instances: async () => [{ params: { id: 'ab12' }, name: 'Agent ab12' }],
    } },
    { path: '/t2', component: '/pg/t2' },
  ]
  const { app, view } = await createRouter('/t3/ab12', routes)
  await flush()
  assert.equal(view.title, 'Agent ab12')   // 实例名覆盖页面 <title> 与分类名
  await view.push('/t3/nope')
  await flush()
  assert.equal(view.title, 'Page One')     // 未命中实例 → 页面 <title>
  await view.push('/t2')
  await flush()
  assert.equal(view.title, 'Page Two')     // 无实例源 → 页面 <title>
  app.destroy()
})

test('vrouter title: onTitleChange 订阅随导航触发', async () => {
  const { app, view } = await createRouter('/t1', TITLE_ROUTES)
  await flush()
  const seen = []
  const off = view.onTitleChange((t) => seen.push(t))
  await view.push('/t2')
  await flush()
  assert.deepEqual(seen, ['Page Two'])
  off()
  app.destroy()
})

// ---- 导航前缀（navigation prefix）三层语义 ----
// 优先级：$router.prefix（vrouter[prefix] 实例声明）> 发起方 $mod.router_prefix（模块声明，
// 唯一的动态前缀通道，如 agent UI /agents/{id} → /a/{id}）> 路由表空间（#routePathPrefix：
// routes.js path_prefix，默认 = vrouter 所属模块挂载点）。
// 回归重点：兜底必须是路由表空间而不是发起方模块挂载点——库组件（vhtml-ui 挂在 /v）
// 在宿主页面（vbase 挂在根）里 push 相对路径时，按发起方拼前缀会得到 /v/xxx → catch-all 404。
const libRuntime = (extra = {}) => ({ $mod: { scoped: '/v', ...extra } })

test('navigation prefix: 跨模块 push 落在宿主路由空间，不带发起方 $mod.scoped', async () => {
  const { app, host, view } = await createRouter('/a')
  assert.equal(view.path_prefix, '', '路由空间默认 = vrouter 所属模块挂载点（根）')
  const info = view.normalizeRouteTarget('/b', null, { runtime: libRuntime() })
  assert.equal(info.navigationPrefix, '')
  assert.equal(info.path, '/b')

  await view.push('/b', null, { runtime: libRuntime() })
  await flush()
  assert.ok(host.querySelector('.pg-b'), 'page b mounted')
  assert.equal(view.current.fullPath, '/b')
  app.destroy()
})

test('navigation prefix: 兜底取 routes.js path_prefix（与发起方挂载点无关）', async () => {
  const { app, view } = await createRouter('/panel/a', ROUTES, null, { path_prefix: '/panel' })
  assert.equal(view.path_prefix, '/panel')
  const info = view.normalizeRouteTarget('/b', null, { runtime: libRuntime() })
  assert.equal(info.navigationPrefix, '/panel')
  assert.equal(info.path, '/panel/b')

  await view.push('/b', null, { runtime: libRuntime() })
  await flush()
  assert.equal(view.current.fullPath, '/panel/b')
  app.destroy()
})

test('navigation prefix: 发起方 $mod.router_prefix 优先于路由空间（agent UI 动态前缀通道）', async () => {
  const { app, view } = await createRouter('/panel/a', ROUTES, null, { path_prefix: '/panel' })
  const info = view.normalizeRouteTarget('/b', null, { runtime: libRuntime({ router_prefix: '/a/ab12' }) })
  assert.equal(info.navigationPrefix, '/a/ab12')
  assert.equal(info.path, '/a/ab12/b')
  app.destroy()
})

test('navigation prefix: vrouter[prefix] 实例声明优先于发起方与路由空间', async () => {
  const { app, view } = await createRouter('/panel/a', ROUTES, null, {
    path_prefix: '/panel', attrs: { prefix: '/panel' },
  })
  assert.equal(view.prefix, '/panel')
  const info = view.normalizeRouteTarget('/b', null, { runtime: libRuntime({ router_prefix: '/x' }) })
  assert.equal(info.navigationPrefix, '/panel')
  assert.equal(info.path, '/panel/b')
  app.destroy()
})

test('navigation prefix: @ 逃生口跳过全部前缀层（跨空间链接仍可用）', async () => {
  const { app, view } = await createRouter('/panel/a', ROUTES, null, { path_prefix: '/panel' })
  const info = view.normalizeRouteTarget('@/a', null, { runtime: libRuntime({ router_prefix: '/x' }) })
  assert.equal(info.bypassRouterPrefix, true)
  assert.equal(info.path, '/a')
  app.destroy()
})

test('guard redirect: 守卫 next(path) 落在路由表空间，不继承发起方前缀', async () => {
  const routes = [
    { path: '/x', component: '/pg/x' },
    { path: '/a', component: '/pg/a', meta: { deny: true } },
    { path: '/b', component: '/pg/b' },
  ]
  const beforeEnter = (to, from, next) => {
    if (to.meta?.deny) next('/b')
    else next()
  }
  const { app, host, view } = await createRouter('/x', routes, beforeEnter)
  await flush()
  assert.ok(host.querySelector('.pg-x'), 'initial page mounted')

  await view.push('/a', null, { runtime: libRuntime() })
  await flush()
  assert.ok(host.querySelector('.pg-b'), '守卫落点页面已渲染')
  assert.equal(view.current.fullPath, '/b', '落点按路由空间解析，不是 /v/b')
  app.destroy()
})
