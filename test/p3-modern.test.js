/*
 * p3-modern.test.js — P3 现代化改造回归
 *
 * 1. v-for 重排：支持 moveBefore 时走原生移动（保状态），不拆解范围
 * 2. scheduling：连续编译超过 50ms 才让出主线程，不让每次挂载都多一跳
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setupDom } from './harness.js'
setupDom()

const { default: VHTML } = await import('../src/index.js')
const {
  yieldIfNeeded,
  resetScheduleDeadline,
} = await import('../src/scheduling.js')

const flush = () => new Promise((resolve) => setTimeout(resolve, 60))

async function mount(template, data) {
  const host = document.createElement('div')
  host.innerHTML = template
  document.body.appendChild(host)
  const app = new VHTML({ target: host, data })
  await app.ready
  await flush()
  return { app, host }
}

test('v-for reorder uses moveBefore when available and keeps row identity', async () => {
  const { app, host } = await mount(
    `<ul><li v-for="o in list">{{ o.name }}</li></ul>`,
    { list: [{ id: 1, name: 'a' }, { id: 2, name: 'b' }, { id: 3, name: 'c' }] },
  )
  const ul = host.querySelector('ul')
  const before = [...ul.querySelectorAll('li')]
  let moves = 0
  // happy-dom 尚未实现 moveBefore：用等效 insertBefore 记录调用，验证框架分支
  ul.moveBefore = function (node, ref) {
    moves++
    this.insertBefore(node, ref)
  }
  app._data.list = [app._data.list[2], app._data.list[0], app._data.list[1]]
  await flush()
  assert.ok(moves > 0, 'native moveBefore path used')
  assert.deepEqual(
    [...ul.querySelectorAll('li')].map((n) => n.textContent),
    ['c', 'a', 'b'],
  )
  const after = [...ul.querySelectorAll('li')]
  assert.equal(after[0], before[2], 'row c moved, not rebuilt')
  assert.equal(after[1], before[0], 'row a moved, not rebuilt')
  assert.equal(after[2], before[1], 'row b moved, not rebuilt')
  app.destroy()
})

test('scheduling: yields only after the shared 50ms deadline', async () => {
  resetScheduleDeadline()
  const first = await yieldIfNeeded(performance.now() + 100)
  assert.equal(first, true, 'expired deadline yields')
  const second = await yieldIfNeeded(performance.now())
  assert.equal(second, false, 'within budget stays synchronous')
  resetScheduleDeadline()
})
