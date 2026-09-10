/*
 * vif_zombie.test.js — 嵌套结构指令 watcher 泄漏（僵尸 watcher）回归
 *
 * 锁定 2026-09-08 aic explorer 实案（manager.html/preview.html 点击列表报错
 * 「Cannot read properties of null (reading 'insertBefore')」，compiler.js
 * showBranch ← v-if 链 watch 回调）：
 *
 *   v-if 链 / v-for 的 watcher 注册在「编译期最近祖先实例 scope」上
 *   （compileVif: instanceOf(startMark.parentNode)?.scope）。
 *   当它们位于一个可拆除区域（外层 v-if 分支 / v-for 行）的顶层时，
 *   区域拆除（外层链 clearContent / removeVforItem）会把它们的标记注释
 *   一并从 DOM 移除——注释节点不走 dispose，watcher 随祖先 scope 存活，
 *   成为僵尸：其条件依赖（组件级数据）再次变化时，showBranch/reconcile
 *   对已脱落的 endMark/vforEnd 执行 insertBefore → parentNode 为 null 崩溃。
 *   僵尸不被回收，反复触发且随操作累积（explorer 中每次点文件报错递增）。
 *
 * 修复后期望：区域拆除时连带取消区域内顶层结构 watcher（本测试即行为契约）。
 *
 * happy-dom 提供 DOM 全局；src 模块加载期即触碰 window，统一走 harness。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mount, flush, texts } from './harness.js'

/** 捕获 flush 期间 watcher 异常（reactive.js flushUpdates console.error('watcher error')） */
function captureWatcherErrors() {
  const errors = []
  const orig = console.error
  console.error = (...args) => {
    if (args[0] === 'watcher error') errors.push(args[1])
    else orig.apply(console, args)
  }
  return { errors, restore: () => { console.error = orig } }
}

// preview.html 原型：外层 loading/fileUrl 链的 template 分支内含内层 kind 链。
// 外层切走时内层链标记被移除；kind 再变 → 僵尸 showBranch 崩溃。
test('vif: outer branch teardown cancels nested chain watcher (preview pattern)', async () => {
  const cap = captureWatcherErrors()
  try {
    const { app, host } = await mount(
      `<div class="pv">
         <div v-if="loading" class="st">loading</div>
         <template v-else-if="fileUrl">
           <span v-if="kind === 'text'" class="tx">{{ text }}</span>
           <span v-else class="bn">binary</span>
         </template>
       </div>`,
      { loading: false, fileUrl: '', kind: '', text: '' },
    )

    // 打开文件 A（text）
    app._data.fileUrl = '/a.txt'
    app._data.kind = 'text'
    app._data.text = 'hello'
    await flush()
    assert.deepEqual(texts(host, '.tx'), ['hello'])

    // 切到 loading：外层分支拆除，内层 kind 链标记注释被移除
    app._data.loading = true
    await flush()
    assert.equal(host.querySelectorAll('.st').length, 1)
    assert.equal(host.querySelectorAll('.tx').length, 0)

    // 打开文件 B（binary）：外层回到 fileUrl 分支（新建内层链）
    app._data.loading = false
    app._data.kind = 'binary'
    app._data.text = ''
    await flush()
    assert.equal(host.querySelectorAll('.bn').length, 1)

    // 再改 kind：旧内层链 watcher 若成僵尸则对脱落 endMark insertBefore 崩溃
    app._data.kind = 'text'
    app._data.text = 'world'
    await flush()

    assert.equal(cap.errors.length, 0,
      '僵尸 watcher 触发: ' + cap.errors.map(e => e?.message).join(' | '))
    assert.deepEqual(texts(host, '.tx'), ['world'])
    app.destroy()
  } finally {
    cap.restore()
  }
})

// manager.html 原型：template v-if/v-else 的 else 分支顶层含 v-for 与两条 v-if 链。
// 搜索切换拆除分支后，rows/spin 再变 → 僵尸 reconcile / showBranch 崩溃。
test('vif: v-else branch teardown cancels nested v-for + v-if watchers (tree pattern)', async () => {
  const cap = captureWatcherErrors()
  try {
    const { app, host } = await mount(
      `<div class="tree">
         <template v-if="searching"><div class="hit">hit</div></template>
         <template v-else>
           <div v-for="r in rows" class="row">{{ r }}</div>
           <div v-if="!rows.length" class="empty">empty</div>
           <div v-if="spin" class="spin">spin</div>
         </template>
       </div>`,
      { searching: false, rows: ['a', 'b'], spin: false },
    )
    assert.deepEqual(texts(host, '.row'), ['a', 'b'])

    // 进入搜索：v-else 分支拆除（v-for 标记 + 两条 v-if 链标记被移除）
    app._data.searching = true
    await flush()
    assert.equal(host.querySelectorAll('.hit').length, 1)
    assert.equal(host.querySelectorAll('.row').length, 0)

    // 退出搜索：分支重建
    app._data.searching = false
    await flush()
    assert.deepEqual(texts(host, '.row'), ['a', 'b'])

    // rows 清空：僵尸「empty 链」触发 showBranch；僵尸 v-for reconcile 移除过期条目
    app._data.rows = []
    await flush()
    assert.equal(host.querySelectorAll('.empty').length, 1)

    // rows 回填：僵尸 v-for reconcile 对脱落 vforEnd insertBefore 崩溃
    app._data.rows = ['x']
    await flush()
    assert.deepEqual(texts(host, '.row'), ['x'])
    assert.equal(host.querySelectorAll('.empty').length, 0)

    // spin 翻转：僵尸 spin 链触发
    app._data.spin = true
    await flush()
    assert.equal(host.querySelectorAll('.spin').length, 1)

    assert.equal(cap.errors.length, 0,
      '僵尸 watcher 触发: ' + cap.errors.map(e => e?.message).join(' | '))
    app.destroy()
  } finally {
    cap.restore()
  }
})
