export function parseUrlString(urlString, scoped) {
  let url
  let path = ''
  if (urlString.startsWith('http://') || urlString.startsWith('https://')) {
    url = new URL(urlString)
    if (url.origin !== window.location.origin) {
      return null
    }
    path = url.pathname
  } else {
    url = new URL(urlString, window.location.href)
    path = url.pathname
  }
  if (scoped && path.startsWith(scoped)) {
    path = path.slice(scoped.length) || '/'
  }
  const query = {}
  url.searchParams.forEach((value, key) => {
    query[key] = value
  })
  return { path, query, hash: url.hash }
}

export class RouteMatcher {
  constructor(path, name) {
    this.originalPath = path
    this.name = name
    this.keys = []
    this.regexp = this.pathToRegexp(path)
  }

  pathToRegexp(path) {
    const optionalParamPattern = /\/:([^(/?]+)\?/g
    let regexpStr = path.replace(optionalParamPattern, (_, key) => {
      this.keys.push(key)
      return `(?:/(?<${key}>[^/]+))?`
    })
    const paramPattern = /:([^(/?]+)/g
    regexpStr = regexpStr.replace(paramPattern, (_, key) => {
      this.keys.push(key)
      return `(?<${key}>[^/]+)`
    })
    regexpStr = regexpStr.replace(/\*(\w+)/g, (_, key) => {
      this.keys.push(key)
      return `(?<${key}>.*)`
    })
    regexpStr = regexpStr.replace(/\*/g, '.*')
    return new RegExp(`^${regexpStr}$`)
  }

  match(target) {
    let path
    if (typeof target === 'string') {
      path = target
    } else if (target?.path) {
      path = target.path
    } else if (target?.name === this.name) {
      return {
        path: this.originalPath,
        params: target.params || {},
        matched: this.originalPath,
      }
    } else {
      return null
    }
    const match = this.regexp.exec(path)
    if (!match) {
      return null
    }
    const params = {}
    this.keys.forEach((key) => {
      if (match.groups?.[key] !== undefined) {
        params[key] = match.groups[key]
      }
    })
    return {
      path: this.originalPath,
      params,
      matched: match[0],
    }
  }
}

export function prepareLayoutDom(layoutRoot) {
  if (!layoutRoot) {
    return null
  }
  const outlet = layoutRoot.querySelector('vslot:not([name])') || layoutRoot.querySelector('vslot')
  if (!outlet) {
    return layoutRoot
  }
  outlet.setAttribute('data-vrouter-outlet', '')
  outlet.setAttribute('data-vrouter-managed', '')
  return layoutRoot
}

function toNormalizedRoutes(moduleExports) {
  if (Array.isArray(moduleExports)) {
    return {
      routes: moduleExports,
      beforeEnter: null,
      afterEnter: null,
    }
  }
  if (Array.isArray(moduleExports?.routes)) {
    return {
      routes: moduleExports.routes,
      beforeEnter: moduleExports.beforeEnter || null,
      afterEnter: moduleExports.afterEnter || null,
    }
  }
  return {
    routes: [],
    beforeEnter: moduleExports?.beforeEnter || null,
    afterEnter: moduleExports?.afterEnter || null,
  }
}

export async function normalizeRoutesModule(moduleExports, context = {}) {
  let resolvedExports = moduleExports
  if (typeof resolvedExports?.default === 'function') {
    resolvedExports = await resolvedExports.default(context)
  } else if (typeof resolvedExports === 'function') {
    resolvedExports = await resolvedExports(context)
  } else if (resolvedExports?.default) {
    const normalized = toNormalizedRoutes(resolvedExports.default)
    if (normalized.routes.length || normalized.beforeEnter || normalized.afterEnter) {
      return {
        routes: normalized.routes,
        beforeEnter: normalized.beforeEnter || resolvedExports.beforeEnter || null,
        afterEnter: normalized.afterEnter || resolvedExports.afterEnter || null,
      }
    }
  }
  return toNormalizedRoutes(resolvedExports)
}

export default {
  parseUrlString,
  RouteMatcher,
  prepareLayoutDom,
  normalizeRoutesModule,
}
