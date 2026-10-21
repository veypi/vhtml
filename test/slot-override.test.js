/* slot override（V2，profile.md §2）集成 + 单元测试：
 * 三源优先级（override > projected > fallback；soft 只压 fallback）、惰性片段装载
 * 自动重渲、样式按片段自身 ref 注入与释放、纯结构闸门、注册表 CRUD。 */
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { setupDom } from './harness.js'
setupDom()
const { default: moduleContextManager } = await import('../src/module.js')
const { fragmentPurityProblem, templateLoader } = await import('../src/loader.js')
const { default: VHTML } = await import('../src/index.js')

const HOST_HTML = `<!DOCTYPE html><html><head><title>host</title></head><body>
  <div class="host-box"><vslot name=""><span class="fb">fallback-content</span></vslot></div>
  </body></html>`
const FRAG_HTML = `<!DOCTYPE html><html><head><style>.frag { color: red }</style></head><body>
  <div class="frag">fragment-content</div>
  </body></html>`
const DIRTY_FRAG_HTML = `<!DOCTYPE html><html><body><div>{{ hacked }}</div></body></html>`

const HEADERS = new Headers()
globalThis.fetch = window.fetch = async (url) => {
  const u = String(url)
  const text = u.endsWith('/x/host.html') ? HOST_HTML
    : u.endsWith('/x/frag.html') ? FRAG_HTML
    : u.endsWith('/x/dirty.html') ? DIRTY_FRAG_HTML
    : null
  return { ok: !!text, status: text ? 200 : 404, headers: HEADERS, text: async () => text || '' }
}
const flush = (ms = 80) => new Promise((r) => setTimeout(r, ms))

afterEach(() => {
  moduleContextManager.removeSlotOverride('/x/host.html', '')
  moduleContextManager.removeSlotOverride('/x/host.html', 'side')
  moduleContextManager.clear()
  document.body.innerHTML = ''
})

let current = null  // 最近挂载的宿主（辅助函数缺省目标）
async function mountHost(inner = '') {
  const host = document.createElement('div')
  host.innerHTML = `<x-host>${inner}</x-host>`
  document.body.appendChild(host)
  const app = new VHTML({ target: host, data: {} })
  await app.ready
  await flush()
  current = host
  return { host, app }
}

const fragText = (host = current) => host?.querySelector('.frag')?.textContent || null
const fbText = (host = current) => host?.querySelector('.fb')?.textContent || null
const projText = (host = current) => host?.querySelector('.proj')?.textContent || null
const fragStyle = () => document.head.querySelector('style[vref="/x/frag"]')

test('override 模式：profile 片段压过原生 fallback（无投影时）', async () => {
  const { host } = await mountHost()
  assert.equal(fbText(), 'fallback-content', '注册前渲染 fallback')
  moduleContextManager.addSlotOverride('/x/host.html', '', '/x/frag.html')
  await flush()
  await flush()
  assert.equal(fragText(), 'fragment-content', '片段就绪后自动重渲（注册表版本号）')
  assert.equal(fbText(), null, 'fallback 让位')
  assert.ok(fragStyle(), '片段样式按自身 ref 注入（vcss 作用域）')
})

test('三源优先级：override 压 projected；soft 只压 fallback', async () => {
  const { host } = await mountHost('<span class="proj">projected</span>')
  assert.equal(projText(), 'projected')
  moduleContextManager.addSlotOverride('/x/host.html', '', '/x/frag.html')
  await flush(); await flush()
  assert.equal(fragText(), 'fragment-content', 'override 压 projected')
  assert.equal(projText(), null)

  moduleContextManager.removeSlotOverride('/x/host.html', '')
  moduleContextManager.addSlotOverride('/x/host.html', '', '/x/frag.html', { mode: 'soft' })
  await flush()
  assert.equal(projText(), 'projected', 'soft：projected 优先')
  assert.equal(fragText(), null)

  // soft 无投影时压 fallback（新挂一个没有投影的宿主）
  const { host: host2 } = await mountHost()
  await flush(); await flush()
  assert.equal(fragText(host2), 'fragment-content')
  assert.equal(fbText(host2), null)
})

test('规则删除：回退 fallback + 片段样式释放', async () => {
  const { host } = await mountHost()
  moduleContextManager.addSlotOverride('/x/host.html', '', '/x/frag.html')
  await flush(); await flush()
  assert.ok(fragText())
  assert.ok(fragStyle())
  assert.equal(moduleContextManager.removeSlotOverride('/x/host.html', ''), true)
  await flush()
  assert.equal(fbText(), 'fallback-content', '删除后回退 fallback')
  assert.equal(fragText(), null)
  await flush()
  assert.equal(fragStyle(), null, '片段样式随规则删除释放')
  assert.equal(moduleContextManager.removeSlotOverride('/x/host.html', ''), false, '幂等')
})

test('纯结构闸门：带数据绑定的片段拒绝装载（fallback 保持）', async () => {
  const { host } = await mountHost()
  moduleContextManager.addSlotOverride('/x/host.html', '', '/x/dirty.html')
  await flush(); await flush()
  assert.equal(fbText(), 'fallback-content', '脏片段不生效')
  assert.equal(host.querySelector('.frag'), null)
})

test('fragmentPurityProblem 单元面', () => {
  const doc = new DOMParser().parseFromString(
    '<div><span>{{ x }}</span></div>', 'text/html')
  assert.match(fragmentPurityProblem(doc.body), /\{\{/)
  const doc2 = new DOMParser().parseFromString(
    '<div><span :class="x"></span></div>', 'text/html')
  assert.match(fragmentPurityProblem(doc2.body), /:class/)
  const doc3 = new DOMParser().parseFromString(
    '<div><x-thing foo="1"></x-thing></div>', 'text/html')
  assert.equal(fragmentPurityProblem(doc3.body), null, '纯结构 + 组件标签允许')
  const doc4 = new DOMParser().parseFromString(
    '<div v-if="ok"></div>', 'text/html')
  assert.match(fragmentPurityProblem(doc4.body), /v-if/)
})

test('注册表 CRUD 与归一化（键 = 运行期 ref，去 .html 留 query）', () => {
  moduleContextManager.addSlotOverride('/x/host.html', 'side', '/x/frag.html')
  assert.deepEqual(
    moduleContextManager.slotOverrideFor('/x/host', 'side'),
    { component: '/x/host', slot: 'side', url: '/x/frag.html', mode: 'override' }
  )
  assert.equal(moduleContextManager.slotOverrideFor('/x/host', ''), null)
  assert.throws(() => moduleContextManager.addSlotOverride('x/host.html', '', '/x'), /absolute path/)
  assert.throws(() => moduleContextManager.addSlotOverride('/x/h.html', '', '/x', { mode: 'hard' }), /override\|soft/)
  assert.throws(() => moduleContextManager.addSlotOverride('/x/h.html', '', 'x/frag.html'), /absolute path/)
})
