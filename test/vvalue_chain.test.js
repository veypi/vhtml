/*
 * vvalue_chain.test.js — v:value 双向绑定「对象整体替换后失效」缺陷复现（TDD）
 *
 * 缺陷（v0.10.4）：findLastAccess 固化「解析时刻的中间对象引用 + 最后 key」。
 * v0.10.0 起赋值是纯替换语义（Reflect.set），当绑定目标形如 user.nickname、
 * 而 user 被整体替换（如 profile.html 的 user = await fetchUser()）时：
 *   - 读方向：getter 仍读旧对象 → 输入框不显示/不回显新值
 *   - 写方向：输入内容写回旧对象 → 提交读新对象时拿到旧值/空值
 *
 * 本文件先锁定四个故障场景（red），修复后转绿：
 *   R1 组件标签 v:value="user.nickname"，user 整体替换后输入 → 写回新对象
 *   R2 DOM input v:value="form.name"，form 整体替换后输入 → 写回新对象
 *   R3 读方向跟随：对象替换后不回显新值 → 输入框显示新值
 *   R4 动态字面量键 settings['app.name']（回归：现状已好，不得回退）
 *
 * 注意：node --test 每文件独立进程；fetch stub 必须在首次 mount 前设置。
 */
import { test } from 'node:test'
import assert from 'node:assert'
import { loadSrc, mount, flush } from './harness.js'

// ---- 组件库 stub（真实链路：compileNode → parseRef → loader.fetchUI → stub fetch）
const fixtures = {
  '/mock/input.html': `<html>
<body>
  <input class="inner" :value="value" @input="handleInput" />
</body>
<script setup>
  value = ''
  handleInput = (e) => { value = e.target.value }
</script>
</html>`,
}

const origFetch = globalThis.fetch
globalThis.fetch = async (url) => {
  const body = fixtures[String(url)] || '<html><body>not found</body></html>'
  return new Response(body, {
    status: fixtures[String(url)] ? 200 : 404,
    headers: { 'content-type': 'text/html', 'vhtml-scoped': '' },
  })
}

// 兜底恢复（进程内仅一份，防御性）
process.on('exit', () => { globalThis.fetch = origFetch })

const type = async (el, value) => {
  el.value = value
  el.dispatchEvent(new Event('input', { bubbles: true }))
  await flush()
}

await loadSrc()

// ====================================================================
// R1: 组件标签 v:value — user 整体替换后输入写回丢失（profile.html 场景）
// ====================================================================
test('R1: 组件 v:value 在 user 整体替换后输入仍写回新对象', async () => {
  const { app, host } = await mount(
    '<mock-input v:value="user.nickname"></mock-input>',
    { user: { nickname: 'old' } },
  )
  const input = host.querySelector('input.inner')
  assert.ok(input, '组件已挂载')

  // 初次键入：绑定当前对象（替换前）→ 应写入 user.nickname
  await type(input, 'typed1')
  assert.equal(app._data.user.nickname, 'typed1', '替换前输入写回 user.nickname')

  // 模拟 loadUser 整体替换（profile.html 第 393 行 user = await fetchUser()）
  app._data.user = { nickname: 'fresh' }
  await flush()

  // 用户继续输入新昵称 → 必须写回【新】user 对象
  await type(input, 'typed2')
  assert.equal(app._data.user.nickname, 'typed2', '替换后输入写回新 user')
  assert.equal(app._data.user.nickname, 'typed2', '新对象字段不得仍是旧值')

  app.destroy()
})

// ====================================================================
// R2: DOM input v:value — form 整体替换后输入写回丢失
// ====================================================================
test('R2: DOM input v:value 在 form 整体替换后输入仍写回新对象', async () => {
  const { app, host } = await mount(
    '<input class="plain" v:value="form.name" />',
    { form: { name: 'a' } },
  )
  const input = host.querySelector('input.plain')
  assert.ok(input, 'input 已挂载')

  await type(input, 'b')
  assert.equal(app._data.form.name, 'b', '替换前输入写回 form.name')

  app._data.form = { name: 'c' }
  await flush()

  await type(input, 'd')
  assert.equal(app._data.form.name, 'd', '替换后输入写回新 form')

  app.destroy()
})

// ====================================================================
// R3: 读方向 — 对象替换后输入框应回显新对象的值
// ====================================================================
test('R3: 组件 v:value 读方向跟随对象替换（回显新值）', async () => {
  const { app, host } = await mount(
    '<mock-input v:value="user.nickname"></mock-input>',
    { user: { nickname: 'display1' } },
  )
  const input = host.querySelector('input.inner')
  assert.equal(input.value, 'display1', '初次回显')

  app._data.user = { nickname: 'display2' }
  await flush()
  assert.equal(input.value, 'display2', '替换后输入框回显新对象值')

  app.destroy()
})

// ====================================================================
// R4: 动态字面量键 settings['app.name']（当前已工作，回归防线）
// ====================================================================
test('R4: 动态字面量键 settings[\'app.name\'] 绑定正常', async () => {
  const { app, host } = await mount(
    '<input class="dyn" v:value="settings[\'app.name\']" />',
    { settings: { 'app.name': 'v1' } },
  )
  const input = host.querySelector('input.dyn')
  assert.equal(input.value, 'v1', '动态键回显')

  await type(input, 'v2')
  assert.equal(app._data.settings['app.name'], 'v2', '动态键写回')

  app.destroy()
})

// ====================================================================
// R5: 含转义序列的字符串键必须回退旧语义（新 Function 求值），
//     不得静默绑到错误的键上（如 'anb'/'a b'/'xny'）
// ====================================================================
test('R5: 含转义序列的字符串键回退旧语义（不静默绑错键）', async () => {
  const nl = 'a\nb'
  const { app, host } = await mount(
    `<input class="esc" v:value="settings['a\\nb']" />`,
    { settings: { [nl]: 'v1' } },
  )
  const input = host.querySelector('input.esc')
  assert.equal(input.value, 'v1', '转义键按 JS 语义回显（换行键）')

  await type(input, 'v2')
  assert.equal(app._data.settings[nl], 'v2', '转义键写回到真实键（换行键）')
  assert.equal(app._data.settings['anb'], undefined, '不得绑到误解析的 anb 键')

  app.destroy()
})

// ====================================================================
// R6: __proto__ 链拒绝静态解析（回退旧语义），不得触发原型改写
// ====================================================================
test('R6: __proto__ 链不回退为静态路径（原型不被污染）', async () => {
  const { app, host } = await mount(
    '<input class="proto" v:value="obj.__proto__.x" />',
    { obj: { a: 1 } },
  )
  const input = host.querySelector('input.proto')
  await type(input, 'polluted')
  // 写入应被拒绝或落在旧语义对象上；全局原型绝不能被改写
  assert.equal(Object.prototype.x, undefined, 'Object.prototype 不得被污染')
  assert.equal(app._data.obj?.x, undefined, 'obj 自身无 x 字段（__proto__ 不参与 getPath/setPath）')

  app.destroy()
})

// ====================================================================
// R7: 保留字/字面量作根标识符拒绝静态解析（旧语义为 warn 放弃）
// ====================================================================
test('R7: 保留字根标识符不静默绑定（v:value="true" 安全 no-op）', async () => {
  const { app, host } = await mount(
    '<input class="kw" v:value="true" />',
    { data: {} },
  )
  const input = host.querySelector('input.kw')
  await type(input, 'x')
  assert.equal(app._data['true'], undefined, '不得绑定到 data["true"]')

  app.destroy()
})
