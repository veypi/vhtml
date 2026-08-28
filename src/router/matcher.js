/*
 * router/matcher.js — 路由匹配与路由模块归一化
 */

import { hasProtocol, isHttpUrl } from './util.js'

// ---- RouteMatcher (原 routes.js) ----

export class RouteMatcher {
  constructor(path) {
    this.originalPath = path
    this.keys = []
    this.regexp = this.pathToRegexp(path)
  }

  pathToRegexp(path) {
    let regexpStr = path.replace(/\/:([^(/?]+)\?/g, (_, key) => {
      this.keys.push(key)
      return `(?:/(?<${key}>[^/]+))?`
    })
    regexpStr = regexpStr.replace(/:([^(/?]+)/g, (_, key) => {
      this.keys.push(key)
      return `(?<${key}>[^/]+)`
    })
    regexpStr = regexpStr.replace(/\/\*(\w+)\?/g, (_, key) => {
      this.keys.push(key)
      return `(?:/(?<${key}>.*))?`
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
    if (typeof target === 'string') path = target
    else if (target?.path) path = target.path
    else return null
    const match = this.regexp.exec(path)
    if (!match) return null
    const params = {}
    this.keys.forEach(key => {
      if (match.groups?.[key] !== undefined) params[key] = match.groups[key]
    })
    return { path: this.originalPath, params, matched: match[0] }
  }
}

export function parseUrlString(urlString, nav = null) {
  let url
  let path = ''
  if (hasProtocol(urlString) && !isHttpUrl(urlString)) return null
  if (isHttpUrl(urlString)) {
    url = new URL(urlString)
    if (url.origin !== (nav?.origin || window.location.origin)) return null
    path = url.pathname
  } else {
    url = new URL(urlString, nav?.href || window.location.href)
    path = url.pathname
  }
  const query = {}
  url.searchParams.forEach((value, key) => { query[key] = value })
  return { path, query, hash: url.hash }
}

export function toNormalizedRoutes(moduleExports) {
  if (Array.isArray(moduleExports)) {
    return { routes: moduleExports, path_prefix: undefined, component_prefix: undefined, beforeEnter: null, afterEnter: null }
  }
  if (Array.isArray(moduleExports?.routes)) {
    return {
      routes: moduleExports.routes,
      path_prefix: moduleExports.path_prefix,
      component_prefix: moduleExports.component_prefix,
      beforeEnter: moduleExports.beforeEnter || null,
      afterEnter: moduleExports.afterEnter || null,
    }
  }
  return {
    routes: [],
    path_prefix: moduleExports?.path_prefix,
    component_prefix: moduleExports?.component_prefix,
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
        path_prefix: normalized.path_prefix !== undefined ? normalized.path_prefix : resolvedExports.path_prefix,
        component_prefix: normalized.component_prefix !== undefined ? normalized.component_prefix : resolvedExports.component_prefix,
        beforeEnter: normalized.beforeEnter || resolvedExports.beforeEnter || null,
        afterEnter: normalized.afterEnter || resolvedExports.afterEnter || null,
      }
    }
  }
  return toNormalizedRoutes(resolvedExports)
}
