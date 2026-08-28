/*
 * compile.js — 纯编译核（v0.10.2 任务 0：编译器边界界定）
 * Copyright (C) 2024 veypi <i@veypi.com>
 *
 * 从 sandbox.js 剥离的零 DOM 依赖编译路径：compileCode / stripComments /
 * 语句分类 / 编译缓存 / 编译上下文。浏览器沙盒与 vhtml check（node 端）
 * 共用同一文件，保证「检查语义 = 运行时语义」，零 shim 零漂移。
 * 约束：本文件不得引用 window/document 等任何 DOM API（check 在 node 执行）。
 */

import { reportError } from './errors.js'

// ============================================================
// 编译上下文（表达式错误定位，v0.10.3）
// ============================================================
// 编译期由 parseRef/runScript 设置（组件 tag/vref/vsrc），compileCode 的
// 编译错误与 sandbox 运行期错误的 buildErrorContext / 未命中标识符警告取用。
// 模块级单例：运行期错误发生时它代表「当时正在编译的组件」，可能为 null
//（组件外模板）或无关组件（事件回调期），仅作辅助定位线索。
let compileContext = null

/** 设置当前编译上下文；返回恢复函数（支持嵌套，调用方必须在 finally 恢复） */
export function setCompileContext(ctx) {
  const prev = compileContext
  compileContext = ctx || null
  return () => { compileContext = prev }
}

/** 当前编译上下文（运行期错误定位线索；可能为 null 或无关组件） */
export function getCompileContext() {
  return compileContext
}

// ============================================================
// 编译缓存
// ============================================================

const syncCache = new Map()
const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor
const asyncCache = new Map()

// LRU 上限：模板表达式有限，但 AI 动态 parseRaw 的代码串单调增长
//（v0.10.0 缓存治理：Map 迭代序=插入序，get 重插实现 touch）
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

export function toPreview(value, maxLength = 400) {
  if (typeof value !== 'string') return ''
  const text = value.trim()
  return text.length <= maxLength ? text : `${text.slice(0, maxLength)}...`
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

export function compileCode(originCode, { async: isAsync, label } = {}) {
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
