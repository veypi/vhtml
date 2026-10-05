/* DOM-free native compiler. Syntax preparation is shared with the isolated realm and CLI. */
import { expressionBody } from './execution/source.js'
export { prepareSource, parseAccessChain } from './execution/source.js'
import { compileStats, now } from './compile-stats.js'

const syncCache = new Map()
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
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

export function compileCode(originCode, { async: isAsync } = {}) {
  const t0 = now()
  try {
    const cache = isAsync ? asyncCache : syncCache
    let fn = cacheGet(cache, originCode)
    if (fn) return fn

    const body = expressionBody(originCode)
    const Compiler = isAsync ? AsyncFunction : Function
    fn = new Compiler('sandbox', `with(sandbox){\n${body}\n}`)
    cachePut(cache, originCode, fn)
    return fn
  } finally {
    compileStats.codeCompiles++
    compileStats.codeMs += now() - t0
  }
}
