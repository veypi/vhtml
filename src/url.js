const protocolPattern = /^[a-zA-Z][a-zA-Z\d+.-]*:/

function hasProtocol(href) {
  return protocolPattern.test(href)
}

export function isRelativeHref(href) {
  return !hasProtocol(href) && !href.startsWith('//')
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
