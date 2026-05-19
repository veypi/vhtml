/*
 * sandbox.js — 沙盒执行引擎
 * Copyright (C) 2024 veypi <i@veypi.com>
 *
 * 基于 with + Proxy 的沙盒作用域，用于执行用户脚本和表达式。
 */

const expose = {
  'console': console,
  'window': window,
  'prompt': prompt.bind(window),
  'alert': alert.bind(window),
  'confirm': confirm.bind(window),
  'RegExp': RegExp,
  'document': document,
  'Array': Array,
  'Object': Object,
  'Math': Math,
  'Date': Date,
  'JSON': JSON,
  'Symbol': Symbol,
  'Number': Number,
  'isNaN': isNaN,
  'parseInt': parseInt,
  'parseFloat': parseFloat,
  'setTimeout': setTimeout.bind(window),
  'setInterval': setInterval.bind(window),
  'clearTimeout': clearTimeout.bind(window),
  'clearInterval': clearInterval.bind(window),
  'encodeURIComponent': encodeURIComponent,
  'btoa': btoa.bind(window),
  'fetch': fetch.bind(window),
  'TextDecoder': TextDecoder,
  'history': history,
  'requestAnimationFrame': requestAnimationFrame.bind(window),
  'getComputedStyle': getComputedStyle.bind(window),
}

/**
 * 创建沙盒作用域 Proxy。
 * 属性查找链: data -> sys -> ctx -> mod -> execArgs -> expose -> window
 */
export function createScopeProxy(data, runtime = {}, execArgs = {}) {
  const runtimeState = runtime || {}
  const runtimeExecArgs = execArgs || {}
  const runtimeSys = runtimeState?.$sys || null
  const runtimeCtx = runtimeState?.$ctx || null
  const runtimeMod = runtimeState?.$mod || null
  return new Proxy(data, {
    has(target, key) {
      return true
    },
    get(target, key, receiver) {
      let v
      if (key === '$data') v = data
      else if (key === '$sys') v = runtimeSys
      else if (key === '$ctx') v = runtimeCtx
      else if (key === '$mod') v = runtimeMod
      else if (runtimeSys && key in runtimeSys) v = runtimeSys[key]
      else if (key in target) v = Reflect.get(target, key, receiver)
      else if (runtimeCtx && key in runtimeCtx) v = runtimeCtx[key]
      else if (runtimeMod && key in runtimeMod) v = runtimeMod[key]
      else if (runtimeExecArgs && key in runtimeExecArgs) v = runtimeExecArgs[key]
      else if (key in expose) v = expose[key]
      else if (key in window) v = window[key]
      return v
    },
    set(target, key, newValue, receiver) {
      return Reflect.set(target, key, newValue, receiver)
    }
  })
}

function toPreview(value, maxLength = 400) {
  if (typeof value !== 'string') return ''
  const text = value.trim()
  if (text.length <= maxLength) return text
  return `${text.slice(0, maxLength)}...`
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

function logSandboxError(originCode, data, runtime, execArgs, label, error) {
  console.error(`${label} error`, buildErrorContext(originCode, data, runtime, execArgs, label, error))
}

function compileSandboxCode(originCode, cache, compiler, options = {}) {
  let fn = cache.get(originCode)
  if (fn) return fn

  let code = originCode.trim()
  const cleanCode = code.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '').trim()
  const isStatement = /^(var|let|const|if|for|while|switch|try|throw|class|function|return|debugger)\b/.test(cleanCode)
  const wrapCode = (body) => `\nwith (sandbox) {\n${body}\n}`
  const tryCompile = (body) => compiler(wrapCode(body))

  if (options.returnExpression !== false && !isStatement) {
    try {
      fn = tryCompile(`return (\n${code}\n)`)
      cache.set(originCode, fn)
      return fn
    } catch (error) {
      // Fall through to statement compilation
    }
  }

  try {
    fn = tryCompile(code)
    cache.set(originCode, fn)
    return fn
  } catch (error) {
    console.warn(`${options.label || 'Run'} compile error:`, originCode, '\n', error)
    return null
  }
}

function executeSandboxCode(fn, originCode, data, runtime, execArgs, label) {
  if (!fn) return undefined
  try {
    return fn(createScopeProxy(data, runtime, execArgs))
  } catch (error) {
    logSandboxError(originCode, data, runtime, execArgs, label, error)
  }
  return undefined
}

async function executeSandboxCodeAsync(fn, originCode, data, runtime, execArgs, label) {
  if (!fn) return undefined
  try {
    return await fn(createScopeProxy(data, runtime, execArgs))
  } catch (error) {
    logSandboxError(originCode, data, runtime, execArgs, label, error)
    throw error
  }
}

const runCache = new Map()

/**
 * 同步执行表达式（用于 DOM 属性绑定等小代码片段）。
 */
export function Run(originCode, data, runtime, execArgs) {
  const fn = compileSandboxCode(originCode, runCache, (code) => new Function('sandbox', code), { label: 'Run' })
  return executeSandboxCode(fn, originCode, data, runtime, execArgs, 'Run')
}

const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor
const asyncRunCache = new Map()

/**
 * 异步执行大段代码（用于 setup 脚本等）。
 */
export async function AsyncRun(originCode, data, runtime, execArgs) {
  const fn = compileSandboxCode(originCode, asyncRunCache, (code) => new AsyncFunction('sandbox', code), {
    label: 'AsyncRun',
    returnExpression: true,
  })
  return await executeSandboxCodeAsync(fn, originCode, data, runtime, execArgs, 'AsyncRun')
}
