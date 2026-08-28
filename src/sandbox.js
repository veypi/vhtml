/*
 * sandbox.js — 沙盒执行引擎
 * Copyright (C) 2024 veypi <i@veypi.com>
 *
 * 基于 with + Proxy 的沙盒作用域。
 * unsafe 模式下拒绝 DOM、网络、全局对象访问。
 * 变量查找优先级：$data → data → $mod → $sys → expose → execArgs → window(仅非 unsafe)
 */

import { recordError, reportError } from './errors.js'

// ============================================================
// 编译上下文（表达式错误定位，v0.10.3）
// ============================================================
// 编译期由 parseRef/runScript 设置（组件 tag/vref/vsrc），buildErrorContext
// 与未命中标识符警告取用。模块级单例：运行期错误发生时它代表「当时正在编译的组件」，
// 可能为 null（组件外模板）或无关组件（事件回调期），仅作辅助定位线索。
let compileContext = null

/** 设置当前编译上下文；返回恢复函数（支持嵌套，调用方必须在 finally 恢复） */
export function setCompileContext(ctx) {
  const prev = compileContext
  compileContext = ctx || null
  return () => { compileContext = prev }
}

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
  const ctx = compileContext
  console.warn(
    `[vhtml] sandbox: identifier "${key}" is not defined in data/$mod/$sys/window — reads as undefined (spelling?)` +
    (ctx ? ` [${ctx.tag || 'component'}${ctx.vref ? ` vref='${ctx.vref}'` : ''}${ctx.vsrc ? ` ${ctx.vsrc}` : ''}]` : ''))
}

// ============================================================
// 编译 & 执行
// ============================================================

const syncCache = new Map()
const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor
const asyncCache = new Map()

// LRU 上限：模板表达式有限，但 AI 动态 parseRaw 的代码串单调增长
// （v0.10.0 缓存治理：Map 迭代序=插入序，get 重插实现 touch）
const MAX_CODE_CACHE = 512
function cacheGet(cache, key) {
  if (!cache.has(key)) return undefined
  const fn = cache.get(key)
  cache.delete(key)
  cache.set(key, fn)
  return fn
}
function cachePut(cache, key, fn) {
  if (cache.has(key)) cache.delete(key)
  cache.set(key, fn)
  if (cache.size > MAX_CODE_CACHE) cache.delete(cache.keys().next().value)
}

function toPreview(value, maxLength = 400) {
  if (typeof value !== 'string') return ''
  const text = value.trim()
  return text.length <= maxLength ? text : `${text.slice(0, maxLength)}...`
}

function buildErrorContext(originCode, data, runtime, execArgs, label, error) {
  return {
    label,
    code: toPreview(originCode),
    dataKeys: Object.keys(data || {}),
    runtimeKeys: Object.keys(runtime || {}),
    execArgKeys: Object.keys(execArgs || {}),
    component: compileContext || undefined,
    message: error?.message || String(error),
    stack: error?.stack || '',
  }
}

function logError(originCode, data, runtime, execArgs, label, error) {
  const ctx = buildErrorContext(originCode, data, runtime, execArgs, label, error)
  recordError({ kind: 'expression', ...ctx })
  console.error(`${label} error`, ctx)
}

/** 字符串感知的注释剥离：仅供 isStatement 分类（旧正则会误剥 "http://..." 中的 //） */
function stripComments(code) {
  let out = ''
  let i = 0
  const n = code.length
  while (i < n) {
    const c = code[i]
    if (c === '"' || c === "'" || c === '`') {
      const quote = c
      out += c
      i++
      while (i < n) {
        const ch = code[i]
        out += ch
        if (ch === '\\') { out += code[i + 1] ?? ''; i += 2; continue }
        i++
        if (ch === quote) break
      }
      continue
    }
    if (c === '/' && code[i + 1] === '/') {
      while (i < n && code[i] !== '\n') i++
      continue
    }
    if (c === '/' && code[i + 1] === '*') {
      i += 2
      while (i < n && !(code[i] === '*' && code[i + 1] === '/')) i++
      i += 2
      continue
    }
    out += c
    i++
  }
  return out
}

function compileCode(originCode, { async: isAsync, label } = {}) {
  const cache = isAsync ? asyncCache : syncCache
  let fn = cacheGet(cache, originCode)
  if (fn) return fn

  const code = originCode.trim()
  const cleanCode = stripComments(code).trim()
  const isStatement = /^(var|let|const|if|for|while|switch|try|throw|class|function|return|debugger)\b/.test(cleanCode)
  const wrap = (body) => `\nwith (sandbox) {\n${body}\n}`
  const Compiler = isAsync ? AsyncFunction : Function

  const tryCompile = (body) => new Compiler('sandbox', wrap(body))

  if (!isStatement) {
    try {
      fn = tryCompile(`return (\n${code}\n)`)
      cachePut(cache, originCode, fn)
      return fn
    } catch (_) {}
  }

  try {
    fn = tryCompile(code)
    cachePut(cache, originCode, fn)
    return fn
  } catch (error) {
    // fail-fast：编译失败必须暴露（旧行为返回 null 使绑定无声失效）
    reportError('compile', error?.message || String(error), {
      label,
      code: toPreview(originCode),
      component: compileContext || undefined,
      stack: error?.stack || '',
    })
    throw error
  }
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
