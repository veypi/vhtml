// 独立进程运行：node --expose-gc scripts/check-reactive-gc.mjs
import assert from 'node:assert/strict'
import { Wrap, Watch, Cancel } from '../src/reactive.js'

assert.equal(typeof global.gc, 'function', 'run with --expose-gc')
const shared = Wrap({ n: 0 })
const handles = [] // 故意保留取消后的 handle，模拟外部持有取消令牌。
const refs = []
for (let i = 0; i < 20; i++) {
  const payload = { bytes: new Uint8Array(1024 * 1024) }
  refs.push(new WeakRef(payload))
  const h = Watch(() => { shared.n; return payload }, () => payload.bytes.byteLength)
  Cancel(h)
  handles.push(h)
}
for (let i = 0; i < 10; i++) {
  await new Promise(resolve => setTimeout(resolve, 10))
  global.gc()
}
assert.equal(refs.filter(ref => ref.deref()).length, 0, 'canceled effects must release payload without notifying dependencies')
assert.equal(shared.n, 0)
assert.equal(handles.length, 20)
console.log('PASS: 20 canceled effects collected without dependency mutation; handles retained')
