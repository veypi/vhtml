const protocolPattern = /^[a-zA-Z][a-zA-Z\d+.-]*:/

function hasProtocol(href) {
  return protocolPattern.test(href)
}

export function isRelativeHref(href) {
  return !hasProtocol(href) && !href.startsWith('//')
}

// 组件模板 ref（归属标记：vref/vrefof/style 作用域/槽规则键共用）：
// 同源 = 去 .html 的 pathname + query/hash；跨源 = 完整 href。
// 从 loader.js 迁入（module.js 的槽规则注册表同用——勿再复制一份推导）。
export function templateRef(source) {
  const url = new URL(source, window.location.origin)
  url.pathname = url.pathname.replace(/\.html$/, '')
  return url.origin === window.location.origin
    ? url.pathname + url.search + url.hash
    : url.href
}

export function isRouterNavigableHref(href, baseHref = window.location.href, origin = window.location.origin) {
  if (href?.startsWith?.('@')) href = href.slice(1)
  if (!href || href.startsWith('#')) {
    return false
  }
  if (!isRelativeHref(href)) {
    return false
  }
  return true
}
