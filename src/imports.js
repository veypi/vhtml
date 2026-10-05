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
export function importNative(url) {
  return withTimeout(import(withImportBust(url)), 10000, `import ${url}`)
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
  for (const statement of compiled.imports) {
    const namespace = await importModule(statement.source, runtime, source)
    for (const binding of statement.bindings) {
      data[binding.local] =
        binding.imported === '*' ? namespace : namespace[binding.imported]
    }
  }
  return compiled.source
}
