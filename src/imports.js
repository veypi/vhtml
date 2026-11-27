import { moduleRecord } from './execution/context.js'
import { resourcesFor } from './resource.js'
import { prepareSource } from './execution/source.js'
import { withTimeout } from './utils.js'

// ESM 缓存穿透令牌：浏览器原生模块表按完整 URL 缓存、无任何 API 可驱逐，
// clearScoped/clear 管不到它。令牌随清缓存递增，import 点（imports.js 静态/
// 动态、env.js）在令牌非 0 时给 URL 追加 ?__ve={n}——新 URL 即新模块表条目，
// 强制走网络重取（服务端对 query 无感，etag 协商仍生效）。跨令牌同模块并存
// 两个实例（旧页面实例持旧引用），与 invalidation 语义一致，不是 HMR。
let importEpoch = 0
export function bumpImportEpoch() {
  importEpoch++
}
export function withImportBust(url) {
  if (!importEpoch) return url
  if (url.startsWith('blob:') || url.startsWith('data:')) return url
  // 外部 http(s)（CDN 三方库）不穿透；同源绝对 URL（env.js、动态 import 的
  // origin 绝对化产物）照常穿透
  if (
    /^https?:\/\//.test(url) &&
    typeof window !== 'undefined' &&
    window.location &&
    !url.startsWith(window.location.origin)
  )
    return url
  return url + (url.includes('?') ? '&' : '?') + '__ve=' + importEpoch
}

// All native import sites share transport, cache busting and error propagation.

// 单次 import 的超时预算（毫秒）。失败后允许再试一次（仅网络类失败），
// 总代价 = 2×预算 + 退避，远小于「一次卡顿整页白屏」的代价。
const IMPORT_TIMEOUT = 8000
const IMPORT_RETRY_DELAY = 300

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// 只重试网络类失败：模块求值错误（语法错、模块内抛错）重试仍是同样结果；
// 4xx（404 之类）也是永久失败，不重试。
function isRetryableImportError(error) {
  const message = error?.message || ''
  if (/timeout after/i.test(message)) return true
  if (/\b4\d\d\b/.test(message)) return false
  return /Failed to fetch|NetworkError|load failed|fetch failed/i.test(message)
}

// 重试必须换一个 URL：浏览器模块表按完整 URL 缓存，同一 URL 的 import()
// 复用同一个在途请求——重试等于继续等那个卡死的请求，等于没重试。
// __vr 是重试序号（服务端对 query 无感，etag 协商照旧）。跨源 http(s)
// （CDN 三方库）不加参数：外部资源的失败多半不是网络卡顿，改 URL 还可能
// 打穿对方的缓存策略。
function withRetryParam(url, attempt) {
  if (attempt <= 1) return url
  if (
    /^https?:\/\//.test(url) &&
    typeof window !== 'undefined' &&
    window.location &&
    !url.startsWith(window.location.origin)
  ) {
    return url
  }
  return `${url}${url.includes('?') ? '&' : '?'}__vr=${attempt}`
}

export function importNative(url, timeout = IMPORT_TIMEOUT) {
  const attempt = (index) => {
    const target = withImportBust(withRetryParam(url, index))
    return withTimeout(import(target), timeout, `import ${url}`).catch((error) => {
      if (index > 1 || !isRetryableImportError(error)) throw error
      return delay(IMPORT_RETRY_DELAY).then(() => attempt(index + 1))
    })
  }
  return attempt(1)
}

export function importModule(specifier, runtime = {}, source = '') {
  const resources = resourcesFor(runtime)
  const from = new URL(source || resources.meta.root, window.location.origin)
    .href
  const url = new URL(resources.resolve(specifier, { from }).href)
  if (!/\.[^/]+$/.test(url.pathname)) url.pathname += '.js'
  return importNative(url.href)
}

export async function parseImports(code, data = {}, runtime = {}, source = '') {
  const compiled = prepareSource(
    code,
    source || moduleRecord(runtime)?.meta.root || window.location.href,
    { setup: true }
  )
  // 并发加载：串行 import 把 N 个往返拉成 N×RTT，任何一次卡顿都会拖垮整页
  // （os.html 的 setup 有 17 个 import）。装配仍按语句顺序，报错也取第一条
  // 失败语句（与串行语义一致）；allSettled 避免其余请求的 rejection 变成
  // 未处理拒绝。
  const results = await Promise.allSettled(
    compiled.imports.map((statement) =>
      importModule(statement.source, runtime, source)
    )
  )
  const failed = results.findIndex((result) => result.status === 'rejected')
  if (failed >= 0) throw results[failed].reason
  compiled.imports.forEach((statement, index) => {
    const namespace = results[index].value
    for (const binding of statement.bindings) {
      data[binding.local] =
        binding.imported === '*' ? namespace : namespace[binding.imported]
    }
  })
  return compiled.source
}
