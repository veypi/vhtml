/*
 * sandbox.js — 沙盒执行引擎
 * Copyright (C) 2024 veypi <i@veypi.com>
 *
 * 基于 with + Proxy 的沙盒作用域。
 * unsafe 模式下拒绝 DOM、网络、全局对象访问。
 * 变量查找优先级：$data → data → $mod → $sys → expose → execArgs → window(仅非 unsafe)
 */

import { recordError } from './errors.js'
import { compileCode, toPreview, setCompileContext, getCompileContext } from './compile.js'

// 编译核（compileCode / stripComments / 编译缓存 / 编译上下文）已剥离至
// compile.js（v0.10.2 任务 0：零 DOM 依赖，node 端 vhtml check 共用同一路径）；
// setCompileContext 于此 re-export，lifecycle.js / component.js 导入路径不变。
export { setCompileContext } from './compile.js'

// ============================================================
// API 分层
// ============================================================

const boundWindowMethods = new WeakMap()

const WINDOW_METHOD_NAMES = new Set([
  'addEventListener',
  'removeEventListener',
  'dispatchEvent',
  'alert',
  'prompt',
  'confirm',
  'setTimeout',
  'setInterval',
  'clearTimeout',
  'clearInterval',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'requestIdleCallback',
  'cancelIdleCallback',
  'queueMicrotask',
  'fetch',
  'btoa',
  'atob',
  'getComputedStyle',
  'matchMedia',
  'open',
  'close',
  'focus',
  'blur',
  'postMessage',
  'print',
  'scroll',
  'scrollTo',
  'scrollBy',
  'moveTo',
  'moveBy',
  'resizeTo',
  'resizeBy',
  'createImageBitmap',
  'structuredClone',
])

function bindWindowMethod(value) {
  if (typeof value !== 'function') return value
  let bound = boundWindowMethods.get(value)
  if (!bound) {
    bound = value.bind(window)
    boundWindowMethods.set(value, bound)
  }
  return bound
}

function windowValue(key) {
  let value
  try {
    value = window[key]
  } catch (_) {
    return undefined
  }
  if (WINDOW_METHOD_NAMES.has(key)) return bindWindowMethod(value)
  return value
}

// Tier 1: 纯原生 API（始终可用）
const nativeExpose = Object.create(null)
Object.assign(nativeExpose, {
  console, Array, Object, Math, Date, JSON, Symbol, Number,
  isNaN, parseInt, parseFloat, encodeURIComponent,
  RegExp, TextDecoder, Map, Set, WeakMap, WeakSet,
  Promise, Error, TypeError, RangeError, SyntaxError,
  Infinity, NaN, undefined,
})

// Tier 2: 框架管理的浏览器 API（始终可用，window 绑定）
const frameworkExpose = Object.create(null)
Object.assign(frameworkExpose, {
  alert: alert.bind(window),
  prompt: prompt.bind(window),
  confirm: confirm.bind(window),
  setTimeout: setTimeout.bind(window),
  setInterval: setInterval.bind(window),
  clearTimeout: clearTimeout.bind(window),
  clearInterval: clearInterval.bind(window),
  requestAnimationFrame: requestAnimationFrame.bind(window),
})

// Tier 3: 全局 DOM / 网络 API（unsafe 模式下不可用）
const globalExpose = Object.create(null)
Object.assign(globalExpose, {
  window,
  globalThis: window,
  self: window,
  document,
  history,
  fetch: windowValue('fetch'),
  btoa: windowValue('btoa'),
  atob: windowValue('atob'),
  getComputedStyle: windowValue('getComputedStyle'),
  createImageBitmap: windowValue('createImageBitmap'),
})

// ============================================================
// 构造函数安全包装（阻止 .constructor → Function 逃逸链）
// ============================================================

const safeFunctionCache = new WeakMap()

function safeFunction(fn) {
  let safe = safeFunctionCache.get(fn)
  if (safe) return safe
  safe = new Proxy(fn, {
    get(target, key, receiver) {
      if (key === 'constructor' || key === '__proto__') return undefined
      return Reflect.get(target, key, receiver)
    },
  })
  safeFunctionCache.set(fn, safe)
  return safe
}

function safeValue(value) {
  return typeof value === 'function' ? safeFunction(value) : value
}

// Proxy 不变式：目标的只读不可配置数据属性，get 陷阱必须原值返回。
// module.js lockProperty 把 $mod.$t/$bus/fetch 等锁成该形态，包装会抛 TypeError——
// 此类属性不包（防误触让位于正确性）
function wrapAllowed(target, key) {
  if (!target || typeof target !== 'object') return true
  const desc = Object.getOwnPropertyDescriptor(target, key)
  return !(desc && !desc.configurable && !desc.writable)
}

// $data/$mod/$sys 的视图代理：只把函数成员包成 safeFunction（堵 .constructor 逃逸链），
// 其余陷阱全部透传 target——经响应式代理的读取照常注册依赖，身份/枚举语义不变。
// 注意：这是「防误触层」不是安全边界——字符串字面量 "x".constructor.constructor
// 直达 Function（原始值自动装箱不走任何 proxy），真隔离需 ShadowRealm/iframe 级方案。
const safeViewCache = new WeakMap()

function safeView(target) {
  if (!target || typeof target !== 'object') return target
  let view = safeViewCache.get(target)
  if (view) return view
  view = new Proxy(target, {
    get(t, key, receiver) {
      const value = Reflect.get(t, key, receiver)
      if (typeof value !== 'function') return value
      return wrapAllowed(t, key) ? safeFunction(value) : value
    },
  })
  safeViewCache.set(target, view)
  return view
}

// ============================================================
// 沙盒 Proxy 创建
// ============================================================

/**
 * 创建沙盒作用域 Proxy。
 */
export function createScopeProxy(data, runtime = {}, execArgs = {}, options = {}) {
  const unsafe = options.unsafe ?? runtime?.__unsafe ?? false
  const runtimeSys = runtime?.$sys || null
  const runtimeMod = runtime?.$mod || null

  let expose = Object.assign(Object.create(null), nativeExpose, frameworkExpose)
  if (!unsafe) {
    expose = Object.assign(Object.create(expose), globalExpose)
  }

  let fallback = expose
  if (execArgs && typeof execArgs === 'object') {
    fallback = Object.assign(Object.create(fallback), execArgs)
  }

  return new Proxy(data, {
    has(_target, _key) { return true },
    get(target, key, receiver) {
      // 阻止原型链逃逸：constructor / __proto__
      if (key === 'constructor' || key === '__proto__') return undefined

      if (key === '$data') return safeView(data)
      if (key === '$sys')  return safeView(runtimeSys)
      if (key === '$mod')  return safeView(runtimeMod)

      if (key in target) {
        const value = Reflect.get(target, key, receiver)
        if (typeof value === 'function' && wrapAllowed(target, key)) return safeFunction(value)
        return value
      }

      if (runtimeMod && key in runtimeMod) {
        if (key === 'fetch' && unsafe) return runtimeMod.restrictedFetch
        return safeValue(runtimeMod[key])
      }

      if (runtimeSys && key in runtimeSys) return safeValue(runtimeSys[key])

      if (key in fallback) {
        const value = fallback[key]
        // 包装暴露的构造函数，阻止 Object.constructor → Function 逃逸链
        if (typeof value === 'function') return safeFunction(value)
        return value
      }

      if (!unsafe) {
        const value = windowValue(key)
        if (value === undefined) warnMissedIdentifier(key)
        return value
      }

      warnMissedIdentifier(key)
      return undefined
    },
    set(target, key, newValue, receiver) {
      return Reflect.set(target, key, newValue, receiver)
    },
  })
}

// has 恒 true 使未声明标识符静默 undefined（拼写错误不可见）。
// v0.10.3：任何层都未命中时按 key 去重打一次警告（不改默认行为）。
const missedIdentifierKeys = new Set()

function warnMissedIdentifier(key) {
  if (typeof key === 'symbol') return
  if (missedIdentifierKeys.has(key)) return
  missedIdentifierKeys.add(key)
  const ctx = getCompileContext()
  console.warn(
    `[vhtml] sandbox: identifier "${key}" is not defined in data/$mod/$sys/window — reads as undefined (spelling?)` +
    (ctx ? ` [${ctx.tag || 'component'}${ctx.vref ? ` vref='${ctx.vref}'` : ''}${ctx.vsrc ? ` ${ctx.vsrc}` : ''}]` : ''))
}

// ============================================================
// 执行 & 错误定位（编译核已剥离至 compile.js）
// ============================================================

function buildErrorContext(originCode, data, runtime, execArgs, label, error) {
  return {
    label,
    code: toPreview(originCode),
    dataKeys: Object.keys(data || {}),
    runtimeKeys: Object.keys(runtime || {}),
    execArgKeys: Object.keys(execArgs || {}),
    component: getCompileContext() || undefined,
    message: error?.message || String(error),
    stack: error?.stack || '',
  }
}

function logError(originCode, data, runtime, execArgs, label, error) {
  const ctx = buildErrorContext(originCode, data, runtime, execArgs, label, error)
  recordError({ kind: 'expression', ...ctx })
  console.error(`${label} error`, ctx)
}

function executeFn(fn, originCode, data, runtime, execArgs, options, label) {
  try {
    return fn(createScopeProxy(data, runtime, execArgs, options))
  } catch (error) {
    logError(originCode, data, runtime, execArgs, label, error)
  }
  return undefined
}

async function executeAsyncFn(fn, originCode, data, runtime, execArgs, options, label) {
  try {
    return await fn(createScopeProxy(data, runtime, execArgs, options))
  } catch (error) {
    logError(originCode, data, runtime, execArgs, label, error)
  }
  return undefined
}

// ============================================================
// 公开 API
// ============================================================

/**
 * 同步执行表达式（DOM 属性绑定等小代码片段）。
 */
export function Run(originCode, data, runtime, execArgs, options = {}) {
  const fn = compileCode(originCode, { async: false, label: 'Run' })
  return executeFn(fn, originCode, data, runtime, execArgs, options, 'Run')
}

/**
 * 异步执行大段代码（setup 脚本等）。
 */
export async function AsyncRun(originCode, data, runtime, execArgs, options = {}) {
  const fn = compileCode(originCode, { async: true, label: 'AsyncRun' })
  return await executeAsyncFn(fn, originCode, data, runtime, execArgs, options, 'AsyncRun')
}
