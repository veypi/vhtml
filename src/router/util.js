/*
 * router/util.js — 路径与路由目标纯函数工具（无状态；仅依赖 module.js 的
 * normalizeScoped 字符串归一）
 */

import { normalizeScoped } from '../module.js'

export const protocolPattern = /^[a-zA-Z][a-zA-Z\d+.-]*:/

export function hasProtocol(url) {
  return protocolPattern.test(url)
}

export function isHttpUrl(url) {
  return /^https?:\/\//i.test(url)
}

export function normalizeHistoryHref(to = '/', baseHref = window.location.href, origin = window.location.origin) {
  try {
    const url = new URL(to || '/', baseHref || `${origin}/`)
    if (url.origin !== origin) return null
    return url.href
  } catch (error) {
    return null
  }
}

export function pathFromHref(href, baseHref = window.location.href) {
  try {
    const url = new URL(href, baseHref)
    return `${url.pathname}${url.search}${url.hash}`
  } catch (error) {
    return href || '/'
  }
}

export function hasRouterEscape(to) {
  return typeof to === 'string' && to.startsWith('@')
}

export function stripRouterEscape(to) {
  if (!hasRouterEscape(to)) return to
  return to.slice(1) || '/'
}

// 路由配置中的 redirect/next 允许返回字符串或 {path, params, query, hash} 对象，
// 统一拆成 (path, data) 供 push/replace 使用
export function splitRouteTarget(target) {
  if (target && typeof target === 'object') {
    return {
      path: target.path,
      data: { params: target.params, query: target.query, hash: target.hash },
    }
  }
  return { path: target, data: null }
}

export function hasPathPrefix(path, prefix) {
  return !!(path && prefix && (path === prefix || path.startsWith(`${prefix}/`)))
}

export function ensureAbsolutePath(path) {
  if (!path) return '/'
  return path.startsWith('/') ? path : `/${path}`
}

export function normalizePathname(path) {
  if (!path) return '/'
  if (path !== '/' && path.endsWith('/')) return path.slice(0, -1)
  return path
}

export function normalizeRouteInputPath(path) {
  if (
    typeof path === 'string' &&
    path &&
    !hasProtocol(path) &&
    !path.startsWith('/') &&
    !path.startsWith('//') &&
    !path.startsWith('?') &&
    !path.startsWith('#')
  ) {
    return `/${path}`
  }
  return path
}

export function joinRoutePath(base, path) {
  if (!base || base === '/') return ensureAbsolutePath(path)
  return `${base}${ensureAbsolutePath(path)}`
}

export function routeDebugList(routes) {
  return routes.map(route => ({
    path: route.path,
    component: typeof route.component === 'function' ? '[function]' : route.component,
    redirect: typeof route.redirect === 'function' ? '[function]' : route.redirect,
    layout: route.layout || '',
  }))
}

export function normalizeRoutePrefix(prefix = '') {
  return normalizeScoped(prefix || '')
}

export function normalizeFixedParams(params) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return {}
  return { ...params }
}

export function matchedRouteDebugInfo(matchedRoute) {
  if (!matchedRoute) return null
  const route = matchedRoute.route || {}
  return {
    path: matchedRoute.path,
    fullPath: matchedRoute.fullPath,
    matched: matchedRoute.matched?.map(item => item.path),
    routePath: route.path,
    component: typeof route.component === 'function' ? '[function]' : route.component,
    redirect: typeof route.redirect === 'function' ? '[function]' : route.redirect,
    bypassRouterPrefix: matchedRoute.bypassRouterPrefix,
    params: matchedRoute.params,
    query: matchedRoute.query,
    hash: matchedRoute.hash,
  }
}

export function isCatchAllRoute(route) {
  return route?.path === '*' || route?.path === '/*'
}

export function routeHash(fullPath, nav) {
  try {
    return new URL(fullPath, nav?.href || window.location.href).hash
  } catch (error) {
    return ''
  }
}
