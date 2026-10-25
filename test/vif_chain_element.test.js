/*
 * vif_chain_element.test.js — v-if 链的元素分支契约
 *
 * 背景（2026-10-26 复核一个“元素 v-else 链不更新”的报告）：
 *   compileVif 对元素分支与 template 分支走同一条路径（sourceBranches +
 *   cloneNode + clearContent），只有 getSourceNodes 取“元素克隆”还是
 *   “template 子节点”之别 —— 不存在按分支容器类型分叉的代码。实测各形状
 *   翻转都正确；报告里的“切不过去”实际是 rAF 批量语义：翻转后同步/微任务
 *   阶段 DOM 仍是旧分支（reactive.js 用 requestAnimationFrame 调度 flush）。
 *
 * 本文件锁定：
 *   ① 元素分支 / template 分支行为对齐（三元链反复翻转、根级直挂、v-for 行内、
 *      相邻两链、空态互斥的两种真实页面形状、页面修复后的嵌套 template 形状）；
 *   ② flush 的 rAF 批量语义（微任务阶段陈旧、一帧后更新）；
 *   ③ 落单 v-else/v-else-if（无链可依附，或同节点被 v-for 接管）只清属性 +
 *      告警一次，不残留 v-else="" 到 DOM。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mount, flush } from './harness.js'

const cnt = (host, sels) => sels.map((s) => host.querySelectorAll(s).length).join('/')

/** 捕获 console.warn 里的 [vhtml] orphan 告警 */
function captureOrphanWarns() {
  const warns = []
  const orig = console.warn
  console.warn = (...args) => {
    const text = args.map(String).join(' ')
    if (text.includes('[vhtml] orphan')) warns.push(text)
    else orig.apply(console, args)
  }
  return { warns, restore: () => { console.warn = orig } }
}

test('element branch and template branch behave identically (1->2->3->1)', async () => {
  const element = await mount(
    `<div class="w">
       <div v-if="n === 1" class="b1">1</div>
       <div v-else-if="n === 2" class="b2">2</div>
       <div v-else class="b3">3</div>
     </div>`,
    { n: 1 },
  )
  const tpl = await mount(
    `<div class="w">
       <template v-if="n === 1"><div class="b1">1</div></template>
       <template v-else-if="n === 2"><div class="b2">2</div></template>
       <template v-else><div class="b3">3</div></template>
     </div>`,
    { n: 1 },
  )
  for (const n of [2, 3, 1, 3, 2]) {
    element.app._data.n = n
    tpl.app._data.n = n
    await flush()
    assert.equal(
      cnt(element.host, ['.b1', '.b2', '.b3']),
      cnt(tpl.host, ['.b1', '.b2', '.b3']),
      `branch mismatch at n=${n}`,
    )
    assert.equal(element.host.querySelectorAll('.' + 'b' + n).length, 1)
  }
  element.app.destroy()
  tpl.app.destroy()
})

test('chain as direct children of the mount target (style/script siblings present)', async () => {
  const { app, host } = await mount(
    `<div v-if="n === 1" class="b1">1</div>
     <div v-else-if="n === 2" class="b2">2</div>
     <div v-else class="b3">3</div>
     <style>.b1{color:red}</style>
     <script setup>n = 1;</` + `script>`,
    { n: 1 },
  )
  for (const n of [2, 3, 1]) {
    app._data.n = n
    await flush()
    assert.equal(host.querySelectorAll('.b' + n).length, 1)
  }
  app.destroy()
})

test('chain inside v-for rows: field patch and push', async () => {
  const { app, host } = await mount(
    `<div class="w">
       <div v-for="r in rows" class="row">
         <div v-if="r.s === 1" class="b1">1</div>
         <div v-else-if="r.s === 2" class="b2">2</div>
         <div v-else class="b3">3</div>
       </div>
     </div>`,
    { rows: [{ id: 1, s: 1 }, { id: 2, s: 2 }] },
  )
  assert.equal(cnt(host, ['.b1', '.b2', '.b3']), '1/1/0')
  app._data.rows[0].s = 3
  await flush()
  assert.equal(host.querySelectorAll('.row')[0].textContent.trim(), '3')
  app._data.rows.push({ id: 3, s: 1 })
  await flush()
  // row0 -> 3, row1 -> 2, 新行 -> 1
  assert.equal(cnt(host, ['.b1', '.b2', '.b3']), '1/1/1')
  app.destroy()
})

test('two adjacent element chains flip independently', async () => {
  const { app, host } = await mount(
    `<div class="w">
       <div v-if="a === 1" class="a1">a1</div>
       <div v-else class="a2">a2</div>
       <div v-if="b" class="b1">b1</div>
       <div v-else class="b2">b2</div>
     </div>`,
    { a: 1, b: true },
  )
  assert.equal(cnt(host, ['.a1', '.a2', '.b1', '.b2']), '1/0/1/0')
  app._data.a = 2
  app._data.b = false
  await flush()
  assert.equal(cnt(host, ['.a1', '.a2', '.b1', '.b2']), '0/1/0/1')
  app._data.a = 1
  app._data.b = true
  await flush()
  assert.equal(cnt(host, ['.a1', '.a2', '.b1', '.b2']), '1/0/1/0')
  app.destroy()
})

test('empty-state互斥 (element v-else): array replace + root object replace', async () => {
  const { app, host } = await mount(
    `<div class="w">
       <div v-if="stats.model_stats.length > 0" class="table-wrap"><div v-for="m in stats.model_stats" class="row">{{ m.model_id }}</div></div>
       <div v-else class="empty-state">none</div>
     </div>`,
    { stats: { model_stats: [{ model_id: 'x' }] } },
  )
  assert.equal(cnt(host, ['.table-wrap', '.row', '.empty-state']), '1/1/0')
  app._data.stats.model_stats = []
  await flush()
  assert.equal(cnt(host, ['.table-wrap', '.row', '.empty-state']), '0/0/1')
  app._data.stats.model_stats = [{ model_id: 'a' }, { model_id: 'b' }]
  await flush()
  assert.equal(cnt(host, ['.table-wrap', '.row', '.empty-state']), '1/2/0')
  app._data.stats = { model_stats: [] }
  await flush()
  assert.equal(cnt(host, ['.table-wrap', '.row', '.empty-state']), '0/0/1')
  app.destroy()
})

test('skeleton -> content with nested v-if empty state (dashboard shape)', async () => {
  const { app, host } = await mount(
    `<div class="w">
       <div v-if="loading" class="sk">loading</div>
       <template v-else>
         <div class="stats">stats</div>
         <div v-if="recentUsers.length === 0" class="empty">none</div>
         <div class="item" v-for="u in recentUsers">{{ u }}</div>
       </template>
     </div>`,
    { loading: true, recentUsers: [] },
  )
  assert.equal(cnt(host, ['.sk', '.stats', '.empty', '.item']), '1/0/0/0')
  app._data.recentUsers = ['a', 'b']
  app._data.loading = false
  await flush()
  assert.equal(cnt(host, ['.sk', '.stats', '.empty', '.item']), '0/1/0/2')
  app._data.loading = true
  await flush()
  assert.equal(cnt(host, ['.sk', '.stats', '.empty', '.item']), '1/0/0/0')
  app.destroy()
})

// models/index.html 修复后的形状：v-if 骨架 + template v-else 里再套 template v-for
test('fixed models shape: template v-else > template v-for', async () => {
  const { app, host } = await mount(
    `<div class="w">
       <div v-if="loading" class="empty-hint">loading</div>
       <template v-else>
         <template v-for="g in groups">
           <div class="mp-group" v-if="g.items.length">{{ g.label }}</div>
           <div class="mp-item" v-for="m in g.items">{{ m.name }}</div>
         </template>
       </template>
     </div>`,
    { loading: true, groups: [{ label: 'G', items: [{ name: 'm1' }, { name: 'm2' }] }] },
  )
  assert.equal(cnt(host, ['.empty-hint', '.mp-group', '.mp-item']), '1/0/0')
  app._data.loading = false
  await flush()
  assert.equal(cnt(host, ['.empty-hint', '.mp-group', '.mp-item']), '0/1/2')
  app._data.groups = [{ label: 'G2', items: [] }]
  await flush()
  assert.equal(cnt(host, ['.empty-hint', '.mp-group', '.mp-item']), '0/0/0')
  app.destroy()
})

// input.html 修复后的形状：三态 v-if/v-else-if 链 + template v-else 包住 v-for
test('fixed panel shape: v-else-if chain + template v-else > v-for', async () => {
  const { app, host } = await mount(
    `<div class="w">
       <div v-if="panelLoading" class="panel-empty">loading</div>
       <div v-else-if="panelError" class="panel-empty panel-error">{{ panelError }}</div>
       <div v-else-if="!panelItems.length" class="panel-empty">no match</div>
       <template v-else>
         <div class="panel-item" v-for="(item, i) in panelItems" :class="{active: i === panelIdx}">{{ item.name }}</div>
       </template>
     </div>`,
    { panelLoading: true, panelError: '', panelItems: [], panelIdx: 0 },
  )
  const sels = ['.panel-empty', '.panel-error', '.panel-item']
  assert.equal(cnt(host, sels), '1/0/0')
  app._data.panelLoading = false
  await flush()
  assert.equal(cnt(host, sels), '1/0/0')
  app._data.panelItems = [{ name: 'a' }, { name: 'b' }]
  await flush()
  assert.equal(cnt(host, sels), '0/0/2')
  app._data.panelError = 'boom'
  await flush()
  assert.equal(cnt(host, sels), '1/1/0')
  app.destroy()
})

// flush 走 requestAnimationFrame：翻转后同步/微任务阶段仍是旧分支，一帧后才是新的
test('flip is rAF-batched (microtask stale, frame fresh)', async () => {
  const { app, host } = await mount(
    `<div class="w">
       <div v-if="n === 1" class="b1">1</div>
       <div v-else-if="n === 2" class="b2">2</div>
       <div v-else class="b3">3</div>
     </div>`,
    { n: 1 },
  )
  app._data.n = 2
  assert.equal(host.querySelectorAll('.b2').length, 0, 'sync must still be stale')
  await Promise.resolve()
  assert.equal(host.querySelectorAll('.b2').length, 0, 'microtask must still be stale')
  await flush()
  assert.equal(host.querySelectorAll('.b2').length, 1)
  assert.equal(host.querySelectorAll('.b1').length, 0)
  app.destroy()
})

// 落单 v-else（链被普通元素打断）：只清属性 + 告警一次；节点照旧常显（设计：无链即无语义）
test('orphan v-else: attribute stripped, warned once, node kept', async () => {
  const cap = captureOrphanWarns()
  try {
    const { app, host } = await mount(
      `<div class="w">
         <div v-if="outer" class="o">
           <div v-if="n === 1" class="b1">1</div>
           <span class="mid">mid</span>
           <div class="b3" v-else>3</div>
         </div>
       </div>`,
      { outer: true, n: 1 },
    )
    assert.equal(host.querySelector('.b3').hasAttribute('v-else'), false, 'v-else must not leak into DOM')
    assert.equal(cap.warns.length, 1)
    assert.match(cap.warns[0], /orphan v-else/)

    // 分支拆建会反复编译克隆 —— 同一段标记不得重复告警
    for (const outer of [false, true, false, true]) {
      app._data.outer = outer
      await flush()
    }
    assert.equal(cap.warns.length, 1, 'duplicate warns: ' + JSON.stringify(cap.warns))
    assert.equal(host.querySelectorAll('.b3').length, 1)
    app.destroy()
  } finally {
    cap.restore()
  }
})

// 同节点 v-else + v-for：v-for 优先（设计：可组合 v-if，但没有 v-else*）
test('v-for precedence over v-else on the same element', async () => {
  const cap = captureOrphanWarns()
  try {
    const { app, host } = await mount(
      `<div class="w">
         <div v-if="loading" class="sk">loading</div>
         <div class="row" v-else v-for="g in list">{{ g }}</div>
       </div>`,
      { loading: true, list: ['a', 'b'] },
    )
    // v-for 接管：列表无条件渲染（loading 时也渲染）
    assert.equal(cnt(host, ['.sk', '.row']), '1/2')
    assert.equal(host.querySelector('.row').hasAttribute('v-else'), false)
    assert.equal(cap.warns.length, 1)
    assert.match(cap.warns[0], /v-for takes precedence/)
    app._data.loading = false
    await flush()
    assert.equal(cnt(host, ['.sk', '.row']), '0/2')
    app.destroy()
  } finally {
    cap.restore()
  }
})
