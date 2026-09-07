/*
 * error-contract.test.js — v0.10.3 沙箱与错误契约
 *
 * 覆盖：
 *   1. unsafe 防误触加固：$data/$mod/$sys 与裸 data 函数的 .constructor 逃逸封堵，
 *      且 safeView 不破坏响应式依赖注册
 *   2. $emit 冲突名 fail-fast（DOM 内置事件名 throw）
 *   3. 编译失败必须暴露（throw + 登记表），不再返回 null 静默失效
 *   4. 运行期表达式错误登记（__vhtml_dev.errors）
 *   5. 未命中标识符拼写警告（按 key 去重）
 *   6. 字符串感知注释剥离（"http://..." 不再误伤分类）
 *   7. watch 延迟队列（单元 + setup props 绑定时序集成）
 *   8. keepOnDetach 经 parseRef options 声明（data-keep 属性通道已废）
 *   9. 挂载失败可见占位（不再静默空白）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadSrc, flush } from './harness.js'

await loadSrc()
const { Wrap, Watch, Cancel } = await import('../src/reactive.js')
const { Run, createScopeProxy } = await import('../src/sandbox.js')
const { errorLog } = await import('../src/errors.js')
const { parseRef } = await import('../src/component.js')
const { ComponentScope } = await import('../src/component-scope.js')
const { instanceOf } = await import('../src/component-instance.js')

function captureConsole() {
  const captured = { error: [], warn: [] }
  const origError = console.error
  const origWarn = console.warn
  console.error = (...args) => captured.error.push(args)
  console.warn = (...args) => captured.warn.push(args)
  return {
    captured,
    restore() { console.error = origError; console.warn = origWarn },
  }
}

// parseRef 直调夹具：stub ctx + stub target（无 fetch 依赖）
function stubCtx() {
  return {
    compileAttrs() {},
    compileAttr() { return false },
    compileVif(nodes) { return nodes },
    compileNode() {},
    suspendMO() {},
    resumeMO() {},
    findLastAccess() { return null },
  }
}

function stubTarget(setupCode = null) {
  return {
    url: 'test://stub',
    body: document.createElement('div'),
    scripts: [],
    setup: setupCode ? { code: setupCode } : null,
  }
}

async function mountStub(setupCode = null, options = {}) {
  const dom = document.createElement('div')
  document.body.appendChild(dom)
  await parseRef('', dom, {}, {}, stubTarget(setupCode), options, stubCtx())
  return { dom, instance: instanceOf(dom, false) }
}

// ====================================================================
// 1. unsafe 防误触加固
// ====================================================================

test('safeFunction covers $data/$mod/$sys and bare data functions', () => {
  const data = Wrap({ n: 1, fn: (x) => x * 2 })
  const runtime = {
    $mod: { helper: () => 'mod' },
    $sys: { emit: () => 'sys' },
  }
  const scope = createScopeProxy(data, runtime)

  // 正常调用不受影响
  assert.equal(scope.fn(2), 4)
  assert.equal(scope.n, 1)
  assert.equal(scope.$data.n, 1)
  assert.equal(scope.helper(), 'mod')
  assert.equal(scope.emit(), 'sys')

  // .constructor / __proto__ 逃逸链全部封堵
  assert.equal(scope.fn.constructor, undefined, 'bare data function')
  assert.equal(scope.$data.fn.constructor, undefined, '$data view function')
  assert.equal(scope.helper.constructor, undefined, '$mod function')
  assert.equal(scope.emit.constructor, undefined, '$sys function')
  assert.equal(scope.fn.__proto__, undefined)
})

test('safeView preserves reactive dependency registration', async () => {
  const data = Wrap({ n: 1 })
  let seen = []
  const cap = captureConsole()
  const h = Watch(() => Run('n', data, {}), (v) => seen.push(v))
  cap.restore()
  assert.deepEqual(seen, [1], 'initial evaluation through sandbox registers the dep')
  data.n = 2
  await flush(40)
  assert.deepEqual(seen, [1, 2], 'mutation notifies the watcher registered via sandbox read')
  Cancel(h)
})

test('locked (read-only, non-configurable) function props: no proxy invariant violation', () => {
  // module.js lockProperty 把 $mod.$t 等锁成只读不可配置；包装会触发
  // "get on proxy must return actual value" TypeError（2026-08-28 4000 回归实测）
  const mod = {}
  mod.$t = (k) => `t:${k}`
  Object.defineProperty(mod, '$t', { value: mod.$t, writable: false, configurable: false, enumerable: true })
  const scope = createScopeProxy(Wrap({}), { $mod: mod })
  assert.equal(scope.$mod.$t('a'), 't:a', 'locked function callable through $mod view')
  assert.equal(scope.$t('b'), 't:b', 'locked function callable through bare $mod branch')

  const rawData = {}
  rawData.fn = () => 7
  Object.defineProperty(rawData, 'fn', { value: rawData.fn, writable: false, configurable: false, enumerable: true })
  const scope2 = createScopeProxy(Wrap(rawData), {})
  assert.equal(scope2.fn(), 7, 'locked data function callable through scope proxy')
})

// ====================================================================
// 2. $emit fail-fast
// ====================================================================

test('$emit with DOM builtin event name throws; custom name passes', async () => {
  const cap = captureConsole()
  const { instance } = await mountStub()
  cap.restore()
  assert.ok(instance?.runtime?.$sys?.$emit, 'emit installed')
  assert.throws(() => instance.runtime.$sys.$emit('click'), /DOM 内置事件名/)
  assert.doesNotThrow(() => instance.runtime.$sys.$emit('my-custom-event'))
})

// ====================================================================
// 3+4. 编译失败暴露 + 运行期错误登记
// ====================================================================

test('compile failure throws and lands in the error registry', () => {
  const cap = captureConsole()
  const before = errorLog.length
  assert.throws(() => Run('if (', {}), SyntaxError)
  cap.restore()
  const entry = errorLog.find((e, i) => i >= before && e.kind === 'compile')
  assert.ok(entry, 'compile error recorded')
  assert.match(entry.message, /./)
  assert.ok(entry.code.includes('if ('))
})

test('runtime expression error is recorded, Run returns undefined', () => {
  const cap = captureConsole()
  const before = errorLog.length
  const value = Run('missingFnXyz()', {})
  cap.restore()
  assert.equal(value, undefined)
  const entry = errorLog.find((e, i) => i >= before && e.kind === 'expression')
  assert.ok(entry, 'expression error recorded')
  assert.equal(entry.label, 'Run')
})

test('__vhtml_dev.errors exposes the registry', () => {
  assert.equal(window.__vhtml_dev.errors, errorLog)
})

// ====================================================================
// 5. 未命中标识符拼写警告（按 key 去重）
// ====================================================================

test('missed identifier warns once per key', () => {
  const cap = captureConsole()
  Run('totallyMissingIdent', {})
  Run('totallyMissingIdent + 1', {})
  cap.restore()
  const warns = cap.captured.warn
    .flat()
    .filter((s) => typeof s === 'string' && s.includes('totallyMissingIdent'))
  assert.equal(warns.length, 1, 'deduped per identifier')
})

// ====================================================================
// 6. 字符串感知注释剥离
// ====================================================================

test('strings containing // survive classification', () => {
  const cap = captureConsole()
  assert.equal(Run('"http://a/b"', {}), 'http://a/b', 'pure url expression')
  assert.equal(Run("'http://x' // trailing comment", {}), 'http://x')
  assert.equal(Run('var u = "http://q/z"\nreturn u', {}), 'http://q/z', 'statement with url string')
  cap.restore()
})

// ====================================================================
// 7. watch 延迟队列
// ====================================================================

test('scope watch queue: enqueue during queue mode, immediate otherwise', () => {
  const scope = new ComponentScope()
  let ran = 0
  scope.beginWatchQueue()
  assert.equal(scope.queueWatch(() => ran++), null)
  assert.equal(ran, 0, 'queued, not executed')
  scope.flushWatchQueue()
  assert.equal(ran, 1, 'drained on flush')
  const handle = scope.queueWatch(() => { ran++; return 'h' })
  assert.equal(ran, 2, 'immediate outside queue mode')
  assert.equal(handle, 'h', 'immediate mode returns the register result')
  scope.dispose()
})

test('setup $watch first evaluation sees bound props (no timer needed)', async () => {
  window.__seen = []
  const dom = document.createElement('div')
  dom.setAttribute(':greeting', 'parent.msg')
  document.body.appendChild(dom)
  const cap = captureConsole()
  await parseRef('', dom, { parent: { msg: 'hello' } }, {}, stubTarget(
    '$data.greeting = ""\n$watch(() => $data.greeting, v => window.__seen.push(v))',
  ), {}, stubCtx())
  cap.restore()
  // 同步断言：排空发生在 props 绑定之后、同帧之内（旧实现需等 50ms 定时器）
  assert.deepEqual(window.__seen, ['hello'], 'first callback fires with the bound prop value')
  delete window.__seen
})

// ====================================================================
// 8. keepOnDetach 经 parseRef options 声明
// ====================================================================

test('parseRef options.keepOnDetach marks the instance; data-keep attribute is dead', async () => {
  const cap = captureConsole()
  const { dom, instance } = await mountStub(null, { keepOnDetach: true })
  cap.restore()
  assert.equal(instance.keepOnDetach, true)

  const dom2 = document.createElement('div')
  dom2.setAttribute('data-keep', '')
  document.body.appendChild(dom2)
  const cap2 = captureConsole()
  await parseRef('', dom2, {}, {}, stubTarget(), {}, stubCtx())
  cap2.restore()
  const inst2 = instanceOf(dom2, false)
  assert.equal(inst2.keepOnDetach, false, 'attribute channel removed')
  assert.equal(dom2.hasAttribute('data-keep'), true, 'attribute left untouched')
  void dom
})

// ====================================================================
// 9. 挂载失败可见占位
// ====================================================================

test('mount failure renders a visible error placeholder instead of blank', async () => {
  const cap = captureConsole()
  const before = errorLog.length
  const { dom, instance } = await mountStub('this is ((( broken')
  cap.restore()
  const pre = dom.querySelector('pre.vhtml-error')
  assert.ok(pre, 'placeholder rendered')
  assert.match(pre.textContent, /\[vhtml\]/)
  assert.equal(instance._error?.kind, 'mount', 'instance error carries mount kind')
  assert.equal(instance.scope.phase, 'disposed', 'failed mount disposes the new scope (props watchers cleaned, async segments killed)')
  const kinds = errorLog.slice(before).map((e) => e.kind)
  assert.ok(kinds.includes('compile'), 'compile error recorded at the source')
  assert.ok(kinds.includes('mount'), 'mount error recorded in parseRef catch')
})
