/*
 * sandbox.js — 沙盒执行引擎
 * Copyright (C) 2024 veypi <i@veypi.com>
 *
 * 基于 with + Proxy 的沙盒作用域。
 * unsafe 模式下拒绝 DOM、网络、全局对象访问。
 * 变量查找优先级：$data → data → $mod → $sys → expose → execArgs → window(仅非 unsafe)
 */

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

      if (key === '$data') return data
      if (key === '$sys')  return runtimeSys
      if (key === '$mod')  return runtimeMod

      if (key in target) return Reflect.get(target, key, receiver)

      if (runtimeMod && key in runtimeMod) {
        if (key === 'fetch' && unsafe) return runtimeMod.restrictedFetch
        return runtimeMod[key]
      }

      if (runtimeSys && key in runtimeSys) return runtimeSys[key]

      if (key in fallback) {
        const value = fallback[key]
        // 包装暴露的构造函数，阻止 Object.constructor → Function 逃逸链
        if (typeof value === 'function') return safeFunction(value)
        return value
      }

      if (!unsafe) return windowValue(key)

      return undefined
    },
    set(target, key, newValue, receiver) {
      return Reflect.set(target, key, newValue, receiver)
    },
  })
}

// ============================================================
// 编译 & 执行
// ============================================================

const syncCache = new Map()
const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor
const asyncCache = new Map()

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
    message: error?.message || String(error),
    stack: error?.stack || '',
  }
}

function logError(originCode, data, runtime, execArgs, label, error) {
  console.error(`${label} error`, buildErrorContext(originCode, data, runtime, execArgs, label, error))
}

function compileCode(originCode, { async: isAsync, label } = {}) {
  const cache = isAsync ? asyncCache : syncCache
  let fn = cache.get(originCode)
  if (fn) return fn

  const code = originCode.trim()
  const cleanCode = code.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '').trim()
  const isStatement = /^(var|let|const|if|for|while|switch|try|throw|class|function|return|debugger)\b/.test(cleanCode)
  const wrap = (body) => `\nwith (sandbox) {\n${body}\n}`
  const Compiler = isAsync ? AsyncFunction : Function

  const tryCompile = (body) => new Compiler('sandbox', wrap(body))

  if (!isStatement) {
    try {
      fn = tryCompile(`return (\n${code}\n)`)
      cache.set(originCode, fn)
      return fn
    } catch (_) {}
  }

  try {
    fn = tryCompile(code)
    cache.set(originCode, fn)
    return fn
  } catch (error) {
    console.warn(`${label || 'compile'} error:`, originCode, '\n', error)
    return null
  }
}

function executeFn(fn, originCode, data, runtime, execArgs, options, label) {
  if (!fn) return undefined
  try {
    return fn(createScopeProxy(data, runtime, execArgs, options))
  } catch (error) {
    logError(originCode, data, runtime, execArgs, label, error)
  }
  return undefined
}

async function executeAsyncFn(fn, originCode, data, runtime, execArgs, options, label) {
  if (!fn) return undefined
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
