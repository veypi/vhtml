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
const fetchCount = new Map()
globalThis.fetch = window.fetch = async (url) => {
  const u = String(url)
  fetchCount.set(u, (fetchCount.get(u) || 0) + 1)
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

test('纯结构闸门：带数据绑定的片段拒绝装载（错误占位，不静默回落）', async () => {
  const { host } = await mountHost()
  moduleContextManager.addSlotOverride('/x/host.html', '', '/x/dirty.html')
  await flush(); await flush()
  assert.equal(host.querySelector('.frag'), null, '脏片段不生效')
  const err = host.querySelector('.vhtml-slot-error')
  assert.ok(err, '闸门拒绝给错误占位（可见）')
  assert.match(err.textContent, /data binding|text binding/)
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

test('fragmentPurityProblem：闸门覆盖 vhtml 真实指令面（复核 2026-10-22）', () => {
  const bad = (html, re) => {
    const doc = new DOMParser().parseFromString(html, 'text/html')
    assert.match(fragmentPurityProblem(doc.body), re, html)
  }
  const good = (html) => {
    const doc = new DOMParser().parseFromString(html, 'text/html')
    assert.equal(fragmentPurityProblem(doc.body), null, html)
  }
  // 双向绑定（v: 前缀）：component.js 的 v:${key} props 双向 + compiler-attrs 的 v: 前缀
  bad('<input v:value="x">', /v:value/)
  bad('<div v:foo="bar"></div>', /v:foo/)
  // 事件绑定与内联处理器
  bad('<button @click="go()"></button>', /@click/)
  bad('<img src=x onerror="alert(1)">', /onerror/)
  bad('<iframe srcdoc="<script>1</script>"></iframe>', /iframe/)
  bad('<div srcdoc="<b>x</b>"></div>', /srcdoc/)
  // 其余 v- 指令（vhtml 实际存在的）
  bad('<div v-else-if="ok"></div>', /v-else-if/)
  bad('<div v-else></div>', /v-else/)
  bad('<div v-for="x in list"></div>', /v-for/)
  bad('<div v-show="ok"></div>', /v-show/)
  bad('<div v-html="html"></div>', /v-html/)
  bad('<div v-whitespace="trim"></div>', /v-whitespace/)
  // 槽相关：vbind 把宿主数据绑进槽、vslot 是嵌套投影（投影链不穿越片段）
  bad('<div vbind="x"></div>', /vbind/)
  bad('<div vslot="s"></div>', /vslot/)
  // 主动内容元素
  for (const tag of ['object', 'embed', 'form', 'base', 'meta', 'link'])
    bad(`<${tag}></${tag}>`, new RegExp(tag))
  // 纯结构仍放行：静态属性 + 组件标签 + 普通元素
  good('<div class="a" id="b" data-x="1" aria-label="l"><span>文本</span></div>')
  good('<x-thing foo="1"><span class="c">组件内容</span></x-thing>')
  good('<ul><li>一</li><li>二</li></ul>')
})

test('注册表 CRUD 与归一化（键 = 运行期 ref，去 .html 留 query）', () => {
  moduleContextManager.addSlotOverride('/x/host.html', 'side', '/x/frag.html')
  assert.deepEqual(
    moduleContextManager.slotOverrideFor('/x/host', 'side'),
    {
      component: '/x/host',
      slot: 'side',
      url: '/x/frag.html',
      // 片段落点 = 平台根绝对（注册期解析）：缓存键/释放键/解析源统一
      source: 'http://localhost/x/frag.html',
      mode: 'override',
    }
  )
  assert.equal(moduleContextManager.slotOverrideFor('/x/host', ''), null)
  assert.throws(() => moduleContextManager.addSlotOverride('x/host.html', '', '/x'), /absolute path/)
  assert.throws(() => moduleContextManager.addSlotOverride('/x/h.html', '', '/x', { mode: 'hard' }), /override\|soft/)
  assert.throws(() => moduleContextManager.addSlotOverride('/x/h.html', '', 'x/frag.html'), /absolute path/)
  // 槽名白名单（P2-22）：含分隔符/非法字符的槽名直接拒（否则可撞键）
  assert.throws(() => moduleContextManager.addSlotOverride('/x/h.html', 'a\nb', '/x/frag.html'), /slot name/)
  assert.throws(() => moduleContextManager.addSlotOverride('/x/h.html', '槽 名', '/x/frag.html'), /slot name/)
})

test('片段装载失败：错误占位 + 记住失败态（不反复重试）', async () => {
  const { host } = await mountHost()
  moduleContextManager.addSlotOverride('/x/host.html', '', '/x/missing.html')
  await flush(); await flush(); await flush()
  const err = host.querySelector('.vhtml-slot-error')
  assert.ok(err, '失败给错误占位（不静默回落）')
  assert.match(err.textContent, /Slot fragment failed/)
  assert.equal(fetchCount.get('http://localhost/x/missing.html'), 1, '坏片段只请求一次')
  await flush(); await flush()
  assert.equal(fetchCount.get('http://localhost/x/missing.html'), 1, '后续重渲不再重试')
})

test('clear()：释放片段样式 + 保留同一响应式版本号（出口 watch 仍能触发）', async () => {
  const { host } = await mountHost()
  moduleContextManager.addSlotOverride('/x/host.html', '', '/x/frag.html')
  await flush(); await flush()
  assert.ok(fragStyle(), '片段样式已注入')
  const version = moduleContextManager.slotOverrideVersion
  moduleContextManager.clear()
  assert.equal(moduleContextManager.slotOverrideVersion, version, '版本号对象不换（watch 依赖登记）')
  assert.ok(moduleContextManager.slotOverrideVersion.v > 0, '版本号已 bump')
  await flush(); await flush()
  assert.equal(fragStyle(), null, 'clear() 连带释放片段样式')
  assert.equal(fbText(), 'fallback-content', 'clear() 后回退 fallback')
})
