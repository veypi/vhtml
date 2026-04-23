const protocolPattern = /^[a-zA-Z][a-zA-Z\d+.-]*:/

export function hasProtocol(href) {
  return protocolPattern.test(href)
}

export function isHttpProtocol(href) {
  return href.startsWith('http://') || href.startsWith('https://')
}

export function isRelativeHref(href) {
  return !hasProtocol(href) && !href.startsWith('//')
}

export function isRouterNavigableHref(href) {
  if (!href || href.startsWith('#')) {
    return false
  }
  if (!isRelativeHref(href)) {
    if (!isHttpProtocol(href)) {
      return false
    }
    try {
      return new URL(href, window.location.href).origin === window.location.origin
    } catch (error) {
      return false
    }
  }
  return true
}
