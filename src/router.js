/*
 * router.js — 客户端路由器
 * Copyright (C) 2024 veypi <i@veypi.com>
 *
 * 合并原 vrouter.js + routes.js + navigation.js。
 * 支持动态路由、页面缓存、路由守卫、布局。
 */

import { Wrap, Watch, Cancel } from './reactive.js'
import { Run } from './sandbox.js'
import { normalizeFetchUrl, templateLoader } from './loader.js'
import { createRuntimeContext, getModulePath, normalizeScoped, resolveScopedUrl, resolveScope } from './module.js'
import { isRouterNavigableHref } from './url.js'
import { debug as logDebug, warn as logWarn } from './debug.js'
import {
  instanceOf, setInstance,
  createInstance, detachInstance,
  attachChildInstance, disposeRuntimeSubtree,
} from './component-instance.js'

// ---- Navigation / History adapters ----

const anchorRouters = new WeakMap()
const routerRoutesSources = new WeakMap()
const routerPrefixSources = new WeakMap()
const routerParamsSources = new WeakMap()
const routerHistories = new Map()
let browserHistory = null
const protocolPattern = /^[a-zA-Z][a-zA-Z\d+.-]*:/

function hasProtocol(url) {
  return protocolPattern.test(url)
}

function isHttpUrl(url) {
  return /^https?:\/\//i.test(url)
}

function normalizeHistoryHref(to = '/', baseHref = window.location.href, origin = window.location.origin) {
  try {
    const url = new URL(to || '/', baseHref || `${origin}/`)
    if (url.origin !== origin) return null
    return url.href
  } catch (error) {
    return null
  }
}

function pathFromHref(href, baseHref = window.location.href) {
  try {
    const url = new URL(href, baseHref)
    return `${url.pathname}${url.search}${url.hash}`
  } catch (error) {
    return href || '/'
  }
}

function hasRouterEscape(to) {
  return typeof to === 'string' && to.startsWith('@')
}

function stripRouterEscape(to) {
  if (!hasRouterEscape(to)) return to
  return to.slice(1) || '/'
}

// 路由配置中的 redirect/next 允许返回字符串或 {path, params, query, hash} 对象，
// 统一拆成 (path, data) 供 push/replace 使用
function splitRouteTarget(target) {
  if (target && typeof target === 'object') {
    return {
      path: target.path,
      data: { params: target.params, query: target.query, hash: target.hash },
    }
  }
  return { path: target, data: null }
}

function hasPathPrefix(path, prefix) {
  return !!(path && prefix && (path === prefix || path.startsWith(`${prefix}/`)))
}

function ensureAbsolutePath(path) {
  if (!path) return '/'
  return path.startsWith('/') ? path : `/${path}`
}

function normalizePathname(path) {
  if (!path) return '/'
  if (path !== '/' && path.endsWith('/')) return path.slice(0, -1)
  return path
}

function normalizeRouteInputPath(path) {
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

function joinRoutePath(base, path) {
  if (!base || base === '/') return ensureAbsolutePath(path)
  return `${base}${ensureAbsolutePath(path)}`
}

function routeDebugList(routes) {
  return routes.map(route => ({
    path: route.path,
    component: typeof route.component === 'function' ? '[function]' : route.component,
    redirect: typeof route.redirect === 'function' ? '[function]' : route.redirect,
    layout: route.layout || '',
  }))
}

function normalizeRoutePrefix(prefix = '') {
  return normalizeScoped(prefix || '')
}

function normalizeFixedParams(params) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return {}
  return { ...params }
}

function matchedRouteDebugInfo(matchedRoute) {
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

function isCatchAllRoute(route) {
  return route?.path === '*' || route?.path === '/*'
}

function routeHash(fullPath, nav) {
  try {
    return new URL(fullPath, nav?.href || window.location.href).hash
  } catch (error) {
    return ''
  }
}

function notifyHistoryListeners(listeners, payload) {
  Array.from(listeners).forEach(listener => listener(payload))
}

function assignLocation(locationState, href, baseHref = window.location.href) {
  try {
    const url = new URL(href, baseHref)
    Object.assign(locationState, {
      href: url.href,
      origin: url.origin,
      protocol: url.protocol,
      host: url.host,
      hostname: url.hostname,
      port: url.port,
      pathname: url.pathname,
      search: url.search,
      hash: url.hash,
    })
  } catch (error) {
    Object.assign(locationState, {
      href: href || '/',
      origin: window.location.origin,
      protocol: window.location.protocol,
      host: window.location.host,
      hostname: window.location.hostname,
      port: window.location.port,
      pathname: href || '/',
      search: '',
      hash: '',
    })
  }
}

function assertRouterHistory(history, name = 'history') {
  const required = ['href', 'origin', 'push', 'replace', 'go', 'back', 'forward', 'onChange']
  for (const key of required) {
    if (!(key in history) || (['push', 'replace', 'go', 'back', 'forward', 'onChange'].includes(key) && typeof history[key] !== 'function')) {
      throw new Error(`router history "${name}" must provide ${key}`)
    }
  }
  return history
}

export function createMemoryHistory(initial = '/', options = {}) {
  if (initial && typeof initial === 'object') {
    options = initial
    initial = options.initial || '/'
  }
  const origin = options.origin || window.location.origin
  const baseHref = options.baseHref || `${origin}/`
  const listeners = new Set()
  const location = Wrap({})
  let stack = [normalizeHistoryHref(initial, baseHref, origin) || baseHref]
  let states = [options.state || null]
  let index = 0
  assignLocation(location, stack[index], baseHref)

  const emit = (type, source = null) => {
    const href = stack[index]
    assignLocation(location, href, baseHref)
    notifyHistoryListeners(listeners, {
      type,
      to: pathFromHref(href, baseHref),
      url: href,
      state: states[index],
      source,
      committed: true,
    })
  }

  const resolve = (to) => normalizeHistoryHref(to, stack[index] || baseHref, origin)

  const api = {
    type: 'memory',
    affectsDocument: false,
    get href() { return stack[index] },
    get origin() { return origin },
    get index() { return index },
    get entries() { return stack.slice() },
    get location() { return location },
    onChange(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    request(type, to, source = null) {
      notifyHistoryListeners(listeners, { type, to, source, committed: false })
    },
    push(to, source = null, state = null) {
      const href = resolve(to)
      if (!href) return
      stack = stack.slice(0, index + 1)
      states = states.slice(0, index + 1)
      stack.push(href)
      states.push(state)
      index = stack.length - 1
      emit('push', source)
    },
    replace(to, source = null, state = states[index] || null) {
      const href = resolve(to)
      if (!href) return
      stack[index] = href
      states[index] = state
      emit('replace', source)
    },
    go(n) {
      const nextIndex = index + Number(n)
      if (!Number.isFinite(nextIndex) || nextIndex < 0 || nextIndex >= stack.length) return
      index = nextIndex
      emit('popstate')
    },
    back() { this.go(-1) },
    forward() { this.go(1) },
  }
  location.assign = (to) => api.push(to)
  location.replace = (to) => api.replace(to)
  location.reload = () => {}
  const history = {
    get length() { return stack.length },
    get state() { return states[index] || null },
    pushState(state, _title, url) {
      if (url !== undefined && url !== null) api.push(url, null, state)
    },
    replaceState(state, _title, url) {
      if (url !== undefined && url !== null) api.replace(url, null, state)
      else states[index] = state
    },
    go(n) { api.go(n) },
    back() { api.back() },
    forward() { api.forward() },
    push(to) { api.push(to) },
    replace(to) { api.replace(to) },
  }
  api.history = history
  return api
}

function getBrowserHistory() {
  if (browserHistory) return browserHistory
  const listeners = new Set()
  const emit = (payload) => notifyHistoryListeners(listeners, payload)
  window.addEventListener('popstate', () => {
    emit({ type: 'popstate', url: window.location.href, committed: true })
  })
  browserHistory = {
    type: 'browser',
    affectsDocument: true,
    get href() { return window.location.href },
    get origin() { return window.location.origin },
    get location() { return window.location },
    get history() { return window.history },
    onChange(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    request(type, to, source = null) {
      emit({ type, to, source, committed: false })
    },
    push(to, source = null) {
      window.history.pushState({}, '', to)
      emit({ type: 'push', to, url: window.location.href, source, committed: true })
    },
    replace(to, source = null) {
      window.history.replaceState({}, '', to)
      emit({ type: 'replace', to, url: window.location.href, source, committed: true })
    },
    go(n) { window.history.go(n) },
    back() { window.history.back() },
    forward() { window.history.forward() },
  }
  return browserHistory
}

export function registerRouterHistory(name, history) {
  if (!name || typeof name !== 'string') {
    throw new Error('registerRouterHistory: name must be a non-empty string')
  }
  if (name === 'browser' || name === 'window' || name === 'memory') {
    throw new Error(`registerRouterHistory: "${name}" is a built-in history name`)
  }
  routerHistories.set(name, assertRouterHistory(history, name))
  return history
}

function prefixInitial(initial, routerPrefix) {
  if (hasRouterEscape(initial)) return stripRouterEscape(initial)
  if (!initial && routerPrefix) return routerPrefix
  if (!routerPrefix || !initial || isHttpUrl(initial)) return initial
  if (!initial.startsWith('/')) initial = `/${initial}`
  if (initial === routerPrefix || initial.startsWith(`${routerPrefix}/`)) return initial
  return `${routerPrefix}${initial}`
}

function resolveRouterHistory(node, routerPrefix = '') {
  const name = (node.getAttribute('history') || 'browser').trim() || 'browser'
  if (name === 'browser' || name === 'window') return getBrowserHistory()
  const initial = node.hasAttribute('initial') ? node.getAttribute('initial') : routerPrefix || '/'
  if (name === 'memory') return createMemoryHistory(prefixInitial(initial, routerPrefix))
  const history = routerHistories.get(name)
  if (history) return history
  console.warn(`[vhtml] vrouter history "${name}" 未注册，已创建独立 memory history`)
  return createMemoryHistory(prefixInitial(initial, routerPrefix))
}

export function setRouterRoutesSource(node, source) {
  if (!node) return
  const existed = routerRoutesSources.has(node)
  const oldSource = routerRoutesSources.get(node)
  if (existed && oldSource === source) return
  routerRoutesSources.set(node, source)
  node.dispatchEvent?.(new CustomEvent('vhtml-router-routes-change', {
    detail: { source },
  }))
}

function getRouterRoutesSource(node) {
  if (routerRoutesSources.has(node)) return routerRoutesSources.get(node)
  return node?.getAttribute?.('routes') || '/routes.js'
}

export function setRouterPrefixSource(node, source, sourceName = 'vrouter[:prefix]') {
  if (!node) return
  const hadSource = routerPrefixSources.has(node)
  const oldEntry = routerPrefixSources.get(node)
  if (source === undefined || source === null) {
    if (!hadSource) return
    routerPrefixSources.delete(node)
  } else {
    if (hadSource && oldEntry?.value === source && oldEntry?.source === sourceName) return
    routerPrefixSources.set(node, { value: source, source: sourceName })
  }
  node.dispatchEvent?.(new CustomEvent('vhtml-router-prefix-change', {
    detail: { source },
  }))
}

function readRouterPrefixSource(node) {
  if (routerPrefixSources.has(node)) {
    const entry = routerPrefixSources.get(node)
    return { exists: true, value: entry?.value, source: entry?.source || 'vrouter[:prefix]' }
  }
  if (node.hasAttribute('prefix')) {
    return { exists: true, value: node.getAttribute('prefix') || '', source: 'vrouter[prefix]' }
  }
  return { exists: false, value: '', source: '' }
}

export function setRouterParamsSource(node, source, sourceName = 'vrouter[:params]') {
  if (!node) return
  const hadSource = routerParamsSources.has(node)
  const oldEntry = routerParamsSources.get(node)
  if (source === undefined || source === null) {
    if (!hadSource) return
    routerParamsSources.delete(node)
  } else {
    if (hadSource && oldEntry?.value === source && oldEntry?.source === sourceName) return
    routerParamsSources.set(node, { value: source, source: sourceName })
  }
  node.dispatchEvent?.(new CustomEvent('vhtml-router-params-change', {
    detail: { source },
  }))
}

function readRouterParamsSource(node) {
  if (!routerParamsSources.has(node)) return null
  return routerParamsSources.get(node)?.value || null
}

export function bindAnchorRouter(anchor, router, getTarget = null) {
  if (!anchor || !router) return () => {}
  anchorRouters.set(anchor, { router, getTarget })
  return () => {
    if (anchorRouters.get(anchor)?.router === router) anchorRouters.delete(anchor)
  }
}

function normalizeActiveHref(href, router) {
  if (!href) return ''
  if (href.startsWith('#')) return href
  const baseHref = router?.navigation?.href || window.location.href
  const origin = router?.navigation?.origin || window.location.origin
  try {
    const url = new URL(href, baseHref)
    if (url.origin !== origin) return href
    return `${url.pathname}${url.search}${url.hash}`
  } catch (error) {
    return href
  }
}

function isSameActiveHref(href, current, router) {
  if (!href || !current) return false
  if (href === current) return true
  return normalizeActiveHref(href, router) === normalizeActiveHref(current, router)
}

export function syncRouterAnchor(anchor, router) {
  if (!anchor || !router) return
  const binding = anchorRouters.get(anchor)
  if (!binding || binding.router !== router) return
  const target = typeof binding.getTarget === 'function'
    ? binding.getTarget()
    : anchor.getAttribute('href')
  const href = router.resolveHref?.(target) || stripRouterEscape(target || '')
  if (href && href !== anchor.getAttribute('href')) anchor.setAttribute('href', href)
  const active = isSameActiveHref(href, router.current?.fullPath, router)
  if (active) {
    anchor.setAttribute('active', '')
  } else {
    anchor.removeAttribute('active')
  }
  logDebug('anchor', 'anchor active sync', {
    target,
    href,
    currentFullPath: router.current?.fullPath || '',
    currentPath: router.current?.path || '',
    active,
    text: anchor.textContent?.trim?.().slice(0, 80) || '',
  }, {
    modulePath: router.modulePath || '',
    routerPrefix: router.router_prefix || '',
  })
}

class AnchorClickRuntime {
  #loaded = false

  init() {
    if (this.#loaded) return
    this.#loaded = true
    document.body.addEventListener('click', (event) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
      const linkElement = event.target?.closest?.('a')
      if (!linkElement) return
      if (linkElement.hasAttribute('download')) return
      const binding = anchorRouters.get(linkElement)
      const router = binding?.router
      if (!router) return
      const href = linkElement.getAttribute('href')
      const target = typeof binding.getTarget === 'function' ? binding.getTarget() : href
      if (!router.isNavigableHref?.(target)) {
        router.debug?.('anchor skip: non-router href', { href, target })
        return
      }
      const matchedRoute = router.matchTo?.(target)
      if (!matchedRoute) {
        router.debug?.('anchor skip: no route matched', { href, target })
        return
      }
      router.debug?.('anchor navigate', { href, target, matched: matchedRouteDebugInfo(matchedRoute) })

      event.preventDefault()
      if (linkElement.getAttribute('target') === '_blank') {
        window.open(href, '_blank')
      } else if (linkElement.hasAttribute('reload')) {
        if (router.affectsDocument) window.location.href = href
        else router.replace(target)
      } else {
        router.push(target)
      }
    }, true)
  }
}

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

export function prepareLayoutDom(layoutRoot) {
  if (!layoutRoot) return null
  const outlet = layoutRoot.querySelector('vslot:not([name])') || layoutRoot.querySelector('vslot')
  if (!outlet) return layoutRoot
  outlet.setAttribute('data-vrouter-outlet', '')
  outlet.setAttribute('data-vrouter-managed', '')
  return layoutRoot
}

function normalizeLayoutUrl(layout) {
  if (!layout) return ''
  let url = layout
  if (!url.startsWith('/')) url = `/${url}`
  if (!url.endsWith('.html')) url += '.html'
  if (!url.startsWith('/layout')) url = `/layout${url}`
  return url
}

function toNormalizedRoutes(moduleExports) {
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

// ---- 生命周期辅助 ----

function runRuntimeTreeLifecycle(root, method, reason) {
  if (!root || typeof method !== 'string') return
  const rootInstance = instanceOf(root)
  if (rootInstance) {
    const visited = new Set()
    const runInstance = (instance) => {
      if (!instance || visited.has(instance)) return
      visited.add(instance)
      const host = instance.host
      if (host) instance.scope?.[method]?.(host, reason)
      instance.children.forEach(child => runInstance(child))
    }
    runInstance(rootInstance)
    return
  }
  instanceOf(root)?.scope?.[method]?.(root, reason)
}

// ---- Page ----

class Page {
  constructor(ownerView, renderer, node, matchedRoute, cacheKey) {
    this.ownerView = ownerView
    this.renderer = renderer
    this.node = node
    this.instance = createInstance(node, ownerView.instance, 'page')
    this.instance.route = matchedRoute
    this.instance.cacheKey = cacheKey
    this.layoutInstance = null
    this._meta = {
      htmlPath: this.resolveHtmlPath(matchedRoute),
      title: '',
      titleWatchers: [],
      didInitialActivation: false,
      layoutOutlet: null,
    }
  }

  get meta() { return this._meta }
  get matchedRoute() { return this.instance.route }
  set matchedRoute(value) { this.instance.route = value || null }
  get cacheKey() { return this.instance.cacheKey }
  get htmlPath() { return this._meta.htmlPath }
  get dom() { return this.instance.host }
  set dom(value) { this.instance.host = value || null }
  get layoutDom() { return this.layoutInstance?.host || null }
  set layoutDom(value) {
    if (!value) {
      if (this.layoutInstance) this.layoutInstance.host = null
      return
    }
    if (!this.layoutInstance) this.layoutInstance = createInstance(value, this.instance, 'layout')
    else this.layoutInstance.host = value
  }

  resolveHtmlPath(matchedRoute) {
    const params = this.ownerView?.mergeParams?.(matchedRoute.params) || matchedRoute.params || {}
    let path = matchedRoute.route.component || matchedRoute.route.path
    if (typeof path === 'function') path = path(matchedRoute.path, params)
    Object.entries(params).forEach(([key, value]) => {
      path = path.replace(`:${key}`, value)
    })
    if (!path.startsWith('/')) path = `/${path}`
    if (path.endsWith('/')) path = path.slice(0, -1)
    if (!path.endsWith('.html')) path = `${path}.html`
    return path
  }

  resolveErrorRedirect(error) {
    const config = this.matchedRoute.route?.error_redirect
    if (!config) return null
    if (typeof config === 'function') return config(this.matchedRoute, error)
    return config
  }

  updateRouter(matchedRoute) {
    this.matchedRoute = matchedRoute
    const router = this.runtime()?.$sys?.$router
    if (!router) return
    Object.assign(router.current, {
      path: matchedRoute.path,
      fullPath: matchedRoute.fullPath,
      params: this.ownerView?.mergeParams?.(matchedRoute.params) || matchedRoute.params,
      query: matchedRoute.query,
      hash: routeHash(matchedRoute.fullPath, this.ownerView?.navigation),
      meta: matchedRoute.route?.meta || {},
    })
  }

  roots() {
    if (this.layoutInstance?.host) return [this.layoutInstance.host]
    return this.instance.host ? [this.instance.host] : []
  }

  runtime() {
    return instanceOf(this.dom)?.runtime || instanceOf(this.layoutDom)?.runtime || null
  }

  outlet() {
    if (!this.layoutDom) return this.node
    this._meta.layoutOutlet = this._meta.layoutOutlet || this.layoutDom.querySelector('[data-vrouter-outlet]') || this.layoutDom
    return this._meta.layoutOutlet
  }

  attach() {
    if (this.layoutDom) {
      if (!this.layoutDom.isConnected) {
        this.node.innerHTML = ''
        this.node.append(this.layoutDom)
      }
      const outlet = this.outlet()
      if (this.dom && outlet && (this.dom === outlet || this.dom.contains(outlet))) {
        this.ownerView?.debug?.('cached page DOM contains layout outlet, remount required', {
          htmlPath: this.htmlPath,
          routePath: this.matchedRoute?.path,
          fullPath: this.matchedRoute?.fullPath,
        })
        return false
      }
      if (this.dom && this.dom.parentNode !== outlet) {
        outlet.innerHTML = ''
        outlet.append(this.dom)
      }
      this.layoutInstance.host = this.layoutDom
      this.instance.host = this.dom
      const layoutInst = instanceOf(this.layoutDom, false)
      if (layoutInst) attachChildInstance(instanceOf(this.node), layoutInst)
      const contentInst = instanceOf(this.dom, false)
      if (layoutInst && contentInst) attachChildInstance(layoutInst, contentInst)
      return true
    }
    // 不变式：路由声明了 layout 的页面不允许无 layout 激活（缓存页被
    // detachLayout 后从不同 layout 返回时会裸挂内容、外壳丢失且无报错）
    if (this.matchedRoute?.route?.layout) {
      this.ownerView?.debug?.('page route requires layout but layoutDom missing, remount required', {
        htmlPath: this.htmlPath,
        routePath: this.matchedRoute?.path,
        fullPath: this.matchedRoute?.fullPath,
        layout: this.matchedRoute?.route?.layout,
      })
      return false
    }
    if (this.dom && (this.dom === this.node || this.dom.contains(this.node))) {
      this.ownerView?.debug?.('cached page DOM contains router host, remount required', {
        htmlPath: this.htmlPath,
        routePath: this.matchedRoute?.path,
        fullPath: this.matchedRoute?.fullPath,
      })
      return false
    }
    if (this.dom && !this.dom.isConnected) {
      this.node.innerHTML = ''
      this.node.append(this.dom)
    }
    this.instance.host = this.dom
    const contentInst = instanceOf(this.dom, false)
    if (contentInst) attachChildInstance(instanceOf(this.node), contentInst)
    return true
  }

  async mount(runtime, layout, existingLayout = null) {
    const parser = await templateLoader.fetchUI(this.htmlPath, runtime)
    if (parser.err) {
      const redirectTarget = this.resolveErrorRedirect(parser.err)
      const matchedRoute = this.matchedRoute
      this.ownerView?.warn?.('page component load failed', {
        htmlPath: this.htmlPath,
        fetchUrl: normalizeFetchUrl(this.htmlPath, getModulePath(runtime)),
        routePath: matchedRoute.path,
        fullPath: matchedRoute.fullPath,
        component: typeof matchedRoute.route?.component === 'function' ? '[function]' : matchedRoute.route?.component,
        modulePath: this.ownerView?.modulePath,
        redirectTarget,
        error: parser.err,
      })
      if (redirectTarget) return { redirect: redirectTarget }
      throw new Error(`load page failed: ${this.htmlPath} ${parser.err}`)
    }
    this._meta.title = parser.title || ''
    this.dom = document.createElement('div')
    this.dom.setAttribute('vsrc', this.htmlPath)
    this.dom.setAttribute('data-keep', '')
    if (!layout) {
      this.node.innerHTML = ''
      this.node.append(this.dom)
      await this.renderer.parseRef(this.htmlPath, this.dom, {}, runtime, null)
      this.instance.host = this.dom
      this.activate()
      return { mounted: true }
    }
    if (existingLayout?.dom) {
      this.attachLayout(existingLayout.dom, existingLayout.instance)
      const layoutRuntime = instanceOf(this.layoutDom)?.runtime || runtime || null
      const outlet = this.outlet()
      outlet.innerHTML = ''
      outlet.append(this.dom)
      await this.renderer.parseRef(this.htmlPath, this.dom, {}, layoutRuntime, null)
      this.instance.host = this.dom
      this.activate()
      return { mounted: true }
    }
    let layoutUrl = layout
    if (!layoutUrl.startsWith('/')) layoutUrl = `/${layoutUrl}`
    if (!layoutUrl.endsWith('.html')) layoutUrl += '.html'
    if (!layoutUrl.startsWith('/layout')) layoutUrl = `/layout${layoutUrl}`
    const layoutParser = await templateLoader.fetchUI(layoutUrl, runtime)
    if (layoutParser.err) throw new Error(`load layout failed: ${layoutUrl} ${layoutParser.err}`)
    this.layoutDom = prepareLayoutDom(layoutParser.body.cloneNode(true))
    this.layoutDom?.setAttribute('data-keep', '')
    this.node.innerHTML = ''
    this.node.append(this.layoutDom)
    await this.renderer.parseRef(`/layout/${layout}`, this.layoutDom, {}, runtime, null, true)
    const layoutRuntime = instanceOf(this.layoutDom)?.runtime || runtime || null
    this.outlet().innerHTML = ''
    this.outlet().append(this.dom)
    await this.renderer.parseRef(this.htmlPath, this.dom, {}, layoutRuntime, null)
    this.instance.host = this.dom
    this.activate()
    return { mounted: true }
  }

  updateTitle() {
    this.clearTitleWatchers()
    if (!this._meta.title) return
    const title = this._meta.title.trim()
    if (!title.includes('{{')) { document.title = title; return }
    const target = this.dom || this.layoutDom
    if (!target) return
    const titleRuntime = this.runtime() || {}
    const varRegex = /{{|}}/g
    let match, nextStart = 0, start = -1
    const parts = []
    while ((match = varRegex.exec(title)) !== null) {
      if (match[0] === '{{') { start = match.index }
      else if (start >= 0) {
        if (nextStart !== start) parts.push(title.slice(nextStart, start))
        parts.push('')
        const expr = title.slice(start + 2, match.index)
        const partIndex = parts.length - 1
        nextStart = match.index + 2
        start = -1
        const watchId = Watch(() => {
          let value = Run(expr, {}, titleRuntime || {})
          if (typeof value === 'function') value = value()
          else if (typeof value === 'object' && value) value = JSON.stringify(value)
          parts[partIndex] = value
          document.title = parts.join('')
        })
        this._meta.titleWatchers.push(watchId)
      }
    }
    parts.push(title.slice(nextStart))
    document.title = parts.join('')
  }

  clearTitleWatchers() {
    while (this._meta.titleWatchers.length > 0) Cancel(this._meta.titleWatchers.pop())
  }

  activate() {
    if (this.ownerView?.affectsDocument) this.updateTitle()
    else this.clearTitleWatchers()
    if (!this.attach()) return false
    if (!this._meta.didInitialActivation) { this._meta.didInitialActivation = true; return true }
    this.roots().forEach(root => runRuntimeTreeLifecycle(root, 'activate', 'route'))
    return true
  }

  deactive(opts = {}) {
    this.clearTitleWatchers()
    if (!this._meta.didInitialActivation) return
    const skipLayout = opts?.skipLayout ?? false
    if (skipLayout && this.layoutDom && this.dom) {
      runRuntimeTreeLifecycle(this.dom, 'deactive', 'route')
      // 只断开与父实例的连接（保留子树），不能用 detachInstance 因为
      // detachInstance 会清空 children 破坏子树，导致 reactivate 时遍历失败
      const inst = instanceOf(this.dom, false)
      if (inst?.parent) { inst.parent.children.delete(inst); inst.parent = null }
      return
    }
    this.roots().forEach(root => {
      runRuntimeTreeLifecycle(root, 'deactive', 'route')
      // 同上：软断开，保留子树
      const inst = instanceOf(root, false)
      if (inst?.parent) { inst.parent.children.delete(inst); inst.parent = null }
    })
  }

  detachLayout() {
    const result = { dom: this.layoutDom, instance: this.layoutInstance }
    this.layoutInstance = null
    this._meta.layoutOutlet = null
    return result
  }

  attachLayout(layoutDom, layoutInstance) {
    this.layoutInstance = layoutInstance
    // layoutDom 已经在 DOM 树中，无需重新 append
    if (layoutInstance) layoutInstance.host = layoutDom
  }

  destroy(options = {}) {
    const preserveLayout = options?.preserveLayout === true
    const layoutDom = this.layoutDom
    const contentDom = this.dom
    this.clearTitleWatchers()
    if (contentDom && !(preserveLayout && layoutDom && (contentDom === layoutDom || contentDom.contains(layoutDom)))) {
      disposeRuntimeSubtree(contentDom)
    }
    if (layoutDom && !preserveLayout) {
      // 导航竞态下本页可能与活动页共享同一 layout（existingLayout），仍在使用
      // 的外壳不能销毁，否则活动页的 layout 会被 purge 成死壳
      const layoutInUse = this.ownerView?.activePage && this.ownerView.activePage !== this &&
        this.ownerView.activePage.layoutDom === layoutDom
      if (!layoutInUse) {
        disposeRuntimeSubtree(layoutDom)
        // 同步剔除 layout 缓存条目，防止后续 attachLayout 挂上死壳
        this.ownerView?.dropLayoutCache?.(layoutDom)
      }
    }
    if (!preserveLayout) detachInstance(this.layoutInstance)
    detachInstance(this.instance)
    this.layoutInstance = null
  }
}

// ---- RouterView ----

class RouterView {
  #stringRoutes = []
  #regexRoutes = []
  #nav = null
  #history = []
  #pageCache = new Map()
  #layoutCache = new Map()
  #routesSource = '/routes.js'
  #beforeEnter = null
  #afterEnter = null
  #listeners = new Set()
  #hostNode = null
  #renderer = null
  #disposeNavListener = null
  #disposeRoutesSourceListener = null
  #disposePrefixSourceListener = null
  #disposeParamsSourceListener = null
  #currentPage = null
  #routerPrefix = ''
  #routePathPrefix = ''
  #routeComponentPrefix = ''
  #fixedParams = {}
  #modulePath = ''
  #pendingNavId = 0

  constructor() {
    this.instance = createInstance(null, null, 'router-view')
    this.instance.data = Wrap({})
    this.instance.route = this.instance.data
    this.instance.router = this
  }

  get routes() { return [...this.#stringRoutes, ...this.#regexRoutes] }
  get history() { return this.#history.slice() }
  get navigation() { return this.#nav }
  get affectsDocument() { return this.#nav?.affectsDocument !== false }
  get router_prefix() { return this.#routerPrefix }
  get path_prefix() { return this.#routePathPrefix }
  get component_prefix() { return this.#routeComponentPrefix }
  get fixed_params() { return { ...this.#fixedParams } }
  get current() { return this.instance.data }
  get query() { return this.instance.data?.query || {} }
  get params() { return this.instance.data?.params || {} }
  get modulePath() { return this.#modulePath || getModulePath(this.runtime || {}) }
  get routesSource() { return this.#routesSource }
  get runtime() { return this.instance.runtime }
  get activePage() { return this.#currentPage }
  set activePage(value) { this.#currentPage = value || null }
  get beforeEnter() { return this.#beforeEnter }
  set beforeEnter(value) { this.#beforeEnter = typeof value === 'function' ? value : null }
  get afterEnter() { return this.#afterEnter }
  set afterEnter(value) { this.#afterEnter = typeof value === 'function' ? value : null }
  get pageCache() { return this.#pageCache }
  get listeners() { return this.#listeners }
  get hostNode() { return this.#hostNode }
  set hostNode(value) { this.#hostNode = value || null }
  get renderer() { return this.#renderer }
  set renderer(value) { this.#renderer = value || null }
  get disposeNavListener() { return this.#disposeNavListener || null }
  set disposeNavListener(value) { this.#disposeNavListener = value || null }
  get disposeRoutesSourceListener() { return this.#disposeRoutesSourceListener || null }
  set disposeRoutesSourceListener(value) { this.#disposeRoutesSourceListener = value || null }
  get disposePrefixSourceListener() { return this.#disposePrefixSourceListener || null }
  set disposePrefixSourceListener(value) { this.#disposePrefixSourceListener = value || null }
  get disposeParamsSourceListener() { return this.#disposeParamsSourceListener || null }
  set disposeParamsSourceListener(value) { this.#disposeParamsSourceListener = value || null }

  mergeParams(params = {}) {
    return { ...this.#fixedParams, ...(params || {}) }
  }

  #logContext(extra = {}) {
    return {
      modulePath: this.#modulePath || '/',
      routerPrefix: this.#routerPrefix || '/',
      routePathPrefix: this.#routePathPrefix || '',
      routeComponentPrefix: this.#routeComponentPrefix || '',
      ...extra,
    }
  }

  #debug(message, detail = undefined) {
    logDebug('router', message, detail, this.#logContext())
  }

  #warn(message, detail = undefined) {
    logWarn('router', message, detail, this.#logContext())
  }

  debug(message, detail = undefined) {
    this.#debug(message, detail)
  }

  warn(message, detail = undefined) {
    this.#warn(message, detail)
  }

  debugContext(extra = {}) {
    return {
      modulePath: this.#modulePath || '',
      routerPrefix: this.#routerPrefix || '',
      routePathPrefix: this.#routePathPrefix || '',
      routeComponentPrefix: this.#routeComponentPrefix || '',
      fixedParams: this.#fixedParams,
      routesSource: this.#routesSource,
      historyType: this.#nav?.type,
      href: this.#nav?.href,
      routes: routeDebugList(this.routes),
      ...extra,
    }
  }

  resolveRouterPrefixInfo(node, runtime) {
    const nodePrefix = readRouterPrefixSource(node)
    if (nodePrefix.exists) {
      return { value: normalizeScoped(nodePrefix.value || ''), source: nodePrefix.source, raw: nodePrefix.value }
    }
    return { value: '', source: '', raw: '' }
  }

  resolveNavigationPrefixInfo(runtime) {
    if (this.#routerPrefix) {
      return { value: this.#routerPrefix, source: '$router.router_prefix', raw: this.#routerPrefix }
    }
    const mod = runtime?.$mod || runtime || null
    if (mod?.router_prefix !== undefined) {
      return { value: normalizeScoped(mod.router_prefix || ''), source: '$mod.router_prefix', raw: mod.router_prefix }
    }
    const raw = resolveScope(runtime)
    return { value: normalizeScoped(raw), source: '$mod.scoped', raw }
  }

  resolveRouterPrefix(node, runtime) {
    return this.resolveRouterPrefixInfo(node, runtime).value
  }

  resolveNavigationPrefix(runtime) {
    return this.resolveNavigationPrefixInfo(runtime).value
  }

  createRuntimeProxy(runtime) {
    const router = this
    return new Proxy(Object.create(null), {
      get(_target, key) {
        if (key === '__routerView') return router
        if (key === 'push') return (to, data, options = {}) => router.push(to, data, { ...(options || {}), runtime: options?.runtime || runtime })
        if (key === 'replace') return (to, data, options = {}) => router.replace(to, data, { ...(options || {}), runtime: options?.runtime || runtime })
        if (key === 'matchTo') return (to, data, options = {}) => router.matchTo(to, data, { ...(options || {}), runtime: options?.runtime || runtime })
        if (key === 'matchRoute') return (to, data, options = {}) => router.matchRoute(to, data, { ...(options || {}), runtime: options?.runtime || runtime })
        if (key === 'normalizeRouteTarget') return (to, data, options = {}) => router.normalizeRouteTarget(to, data, { ...(options || {}), runtime: options?.runtime || runtime })
        if (key === 'resolveHref') return (to, data, options = {}) => router.resolveHref(to, data, { ...(options || {}), runtime: options?.runtime || runtime })
        if (key === 'setQuery') return (patch, options = {}) => router.setQuery(patch, { ...options, runtime: options.runtime || runtime })
        if (key === 'setParams') return (patch, options = {}) => router.setParams(patch, { ...options, runtime: options.runtime || runtime })
        const value = router[key]
        return typeof value === 'function' ? value.bind(router) : value
      },
      set(_target, key, value) {
        router[key] = value
        return true
      },
    })
  }

  onChange(listener) {
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }

  #notifyListeners(to, from) {
    for (const listener of this.#listeners) listener(to, from)
  }

  #snapshot(routeState) {
    return {
      path: routeState.path,
      fullPath: routeState.fullPath,
      params: { ...(routeState.params || {}) },
      query: { ...(routeState.query || {}) },
      hash: routeState.hash || '',
      meta: { ...(routeState.meta || {}) },
      layout: routeState.layout || '',
      matched: [...(routeState.matched || [])],
    }
  }

  #setRouterPath(matchedRoute, mode = 'push', options = {}) {
    const previousSnapshot = this.#snapshot(this.current)
    const nextSnapshot = this.#snapshot({
      path: matchedRoute.path,
      fullPath: matchedRoute.fullPath,
      params: this.mergeParams(matchedRoute.params || {}),
      query: matchedRoute.query || {},
      hash: routeHash(matchedRoute.fullPath, this.#nav),
      meta: matchedRoute.route?.meta || {},
      layout: matchedRoute.route?.layout || '',
      matched: matchedRoute.route ? [matchedRoute.route] : [],
    })
    Object.assign(this.current, nextSnapshot)
    if (mode === 'replace' && this.#history.length > 0) {
      this.#history[this.#history.length - 1] = nextSnapshot
    } else {
      this.#history.push(nextSnapshot)
    }
    if (options.commit !== false) {
      if (mode === 'replace') this.#nav.replace(matchedRoute.fullPath, this)
      else this.#nav.push(matchedRoute.fullPath, this)
    }
    this.#notifyListeners(this.current, previousSnapshot)
  }

  #isRegexPath(path) {
    return /[:*?()[\]{}^$+.]/.test(path)
  }

  normalizeRouterPath(path, options = {}) {
    if (typeof path !== 'string') return path
    if (!path || path === '*') return path || '/'
    if (isHttpUrl(path)) return path
    const escaped = hasRouterEscape(path) || options.bypassRouterPrefix === true
    if (hasRouterEscape(path)) path = stripRouterEscape(path)
    path = normalizePathname(ensureAbsolutePath(path))
    if (escaped || options.preserveTargetPath) return path
    const prefix = options.prefix === undefined ? this.#routerPrefix : normalizeScoped(options.prefix || '')
    if (prefix && !hasPathPrefix(path, prefix)) {
      return normalizePathname(joinRoutePath(prefix, path))
    }
    return path
  }

  routeComponentPrefix(componentPrefix = this.#routeComponentPrefix) {
    if (!componentPrefix) return ''
    const modulePath = this.#modulePath || ''
    if (modulePath && componentPrefix === modulePath) return ''
    if (modulePath && componentPrefix.startsWith(`${modulePath}/`)) {
      return componentPrefix.slice(modulePath.length) || ''
    }
    return componentPrefix
  }

  normalizeRouteResourcePath(path, componentPrefix = this.#routeComponentPrefix) {
    const prefix = this.routeComponentPrefix(componentPrefix)
    if (!prefix || typeof path !== 'string') return path
    if (!path || path.startsWith('@') || isHttpUrl(path) || path.startsWith('//')) return path
    if (path === prefix || path.startsWith(`${prefix}/`)) return path
    return normalizePathname(joinRoutePath(prefix, path))
  }

  normalizeRouteComponent(component, componentPrefix = this.#routeComponentPrefix) {
    if (!componentPrefix) return component
    if (typeof component === 'string') return this.normalizeRouteResourcePath(component, componentPrefix)
    if (typeof component === 'function') {
      return (path, params) => this.normalizeRouteResourcePath(component(path, params), componentPrefix)
    }
    return component
  }

  addRoute(route, options = {}) {
    if (!route.path) throw new Error('Route must have a path')
    const routePath = this.normalizeRouterPath(route.path, { prefix: options.pathPrefix || '' })
    const routeConfig = {
      path: routePath,
      component: this.normalizeRouteComponent(route.component, options.componentPrefix || ''),
      redirect: route.redirect,
      error_redirect: route.error_redirect,
      meta: route.meta || {},
      children: route.children || [],
      matcher: new RouteMatcher(routePath),
      layout: route.layout || '',
      cacheKey: route.cacheKey,
    }
    if (this.#isRegexPath(routePath)) this.#regexRoutes.push(routeConfig)
    else this.#stringRoutes.push(routeConfig)
    if (route.children?.length > 0) {
      route.children.forEach(child => {
        const childPath = hasRouterEscape(child.path) ? child.path : joinRoutePath(routePath, child.path)
        const layout = child.layout || route.layout || ''
        const meta = { ...route.meta, ...child.meta }
        this.addRoute({ ...child, path: childPath, parent: routeConfig, layout, meta }, options)
      })
    }
  }

  addRoutes(routes, options = {}) {
    routes.forEach(route => this.addRoute(route, options))
    this.#debug('routes registered', this.debugContext({
      count: routes.length,
      pathPrefix: options.pathPrefix || '',
      componentPrefix: options.componentPrefix || '',
    }))
  }

  resetRoutes() {
    this.activePage?.deactive()
    this.#pageCache.forEach(page => page.destroy())
    this.#stringRoutes = []
    this.#regexRoutes = []
    this.#history = []
    this.#pageCache = new Map()
    this.#layoutCache = new Map()
    this.activePage = null
  }

  /**
   * 规范化路由目标。
   * to: 路径字符串（支持 @ 前缀跳过 prefix、?query、#hash 简写）
   * data: { params, query, hash }；path 含 :key/*key 占位符时用 params 填充生成最终路径
   */
  normalizeRouteTarget(to, data = null, options = {}) {
    if (typeof to !== 'string') return null
    let bypassRouterPrefix = false
    if (hasRouterEscape(to)) {
      bypassRouterPrefix = true
      to = stripRouterEscape(to)
    }
    to = normalizeRouteInputPath(to)
    if (isHttpUrl(to) && options.allowHttpUrl !== true) return null
    const parsed = parseUrlString(to, this.#nav)
    if (!parsed) return null
    let path = parsed.path
    const query = { ...parsed.query, ...(data?.query || {}) }
    const params = { ...(data?.params || {}) }
    const hash = data?.hash || parsed.hash
    if (/[:*]/.test(path) && data?.params) {
      path = this.#fillRouteTemplate(path, params)
      // 必填段/通配段未被 params 填充完整：目标非法（可选段标记 ? 会被 URL 解析
      // 当作 query 分隔符，字符串模板无法表达"移除可选段"，请直接写最终路径）
      if (/\/:[A-Za-z_]/.test(path) || /\*[A-Za-z_]/.test(path)) return null
    }
    const navigationPrefix = options.navigationPrefix === undefined
      ? this.resolveNavigationPrefix(options.runtime || this.runtime)
      : options.navigationPrefix
    path = this.normalizeRouterPath(path, {
      prefix: navigationPrefix,
      bypassRouterPrefix,
      preserveTargetPath: options.preserveTargetPath,
    })
    return { path, query, params, hash, bypassRouterPrefix, navigationPrefix }
  }

  matchRoute(to, data = null, options = {}) {
    const routeInfo = this.normalizeRouteTarget(to, data, options)
    if (!routeInfo) return null
    const { path, query, params, hash, bypassRouterPrefix } = routeInfo
    for (const route of this.#stringRoutes) {
      if (route.path === path && (route.component || route.redirect)) {
        return { route, params: { ...params }, matched: path, path, query, hash, bypassRouterPrefix }
      }
    }
    for (const route of this.#regexRoutes) {
      const match = route.matcher.match(path)
      if (match && (route.component || route.redirect)) {
        return { route, params: { ...match.params, ...params }, matched: match.matched, path, query, hash, bypassRouterPrefix }
      }
    }
    return null
  }

  matchTo(to, data = null, options = {}) {
    const matchResult = this.matchRoute(to, data, options)
    if (!matchResult) return null
    const { route, params, query, path, hash } = matchResult
    let search = ''
    if (query && Object.keys(query).length > 0) {
      search = `?${Object.entries(query).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')}`
    }
    const fullPath = `${path || matchResult.path}${search}${hash || ''}`
    return {
      route, params, query, path: path || matchResult.path,
      fullPath, matched: [route],
      bypassRouterPrefix: matchResult.bypassRouterPrefix,
    }
  }

  resolveHref(to, data = null, options = {}) {
    if (typeof to === 'string' && isHttpUrl(stripRouterEscape(to))) return stripRouterEscape(to)
    return this.matchTo(to, data, options)?.fullPath || stripRouterEscape(to)
  }

  isNavigableHref(href) {
    return isRouterNavigableHref(href, this.#nav?.href, this.#nav?.origin)
  }

  resolveCacheKey(route, matchedRoute) {
    const config = route.cacheKey
    if (config === false) return null
    // 默认 key = path（不含 query/hash）：query 变化只更新路由状态，不重挂页面
    if (config === undefined || config === true) return matchedRoute.path || matchedRoute.fullPath.split(/[?#]/)[0]
    if (typeof config === 'string') return config
    if (typeof config === 'function') return config(matchedRoute)
    return matchedRoute.path || matchedRoute.fullPath.split(/[?#]/)[0]
  }

  // layout 缓存活性校验：disposeRuntimeSubtree 只销毁实例不移除 DOM，
  // 死壳条目必须剔除，否则 attachLayout 会挂上已销毁的 layout 外壳
  #isLayoutCacheAlive(entry) {
    if (!entry?.dom) return false
    const inst = instanceOf(entry.dom, false)
    if (!inst) return false
    if (inst.scope?.state === 'disposed') return false
    return true
  }

  #getCachedLayout(layout) {
    const url = normalizeLayoutUrl(layout)
    if (!url) return null
    const entry = this.#layoutCache.get(url)
    if (!entry) return null
    if (this.#isLayoutCacheAlive(entry)) return entry
    this.#layoutCache.delete(url)
    return null
  }

  // Page.destroy 实际 dispose layout 时调用，同步剔除缓存条目防投毒
  dropLayoutCache(layoutDom) {
    if (!layoutDom) return
    for (const [url, entry] of this.#layoutCache) {
      if (entry.dom === layoutDom) this.#layoutCache.delete(url)
    }
  }

  async #navigateTo(matchedRoute, mode = 'push', options = {}) {
    if (!matchedRoute) return
    const navId = ++this.#pendingNavId
    const { route, params, query } = matchedRoute
    const mergedParams = this.mergeParams(params || {})
    if (route.redirect) {
      const redirectTarget = typeof route.redirect === 'function' ? route.redirect(matchedRoute) : route.redirect
      this.#debug('route redirect', {
        from: matchedRouteDebugInfo(matchedRoute),
        redirectTarget,
      })
      const { path: redirectPath, data: redirectData } = splitRouteTarget(redirectTarget)
      this.push(redirectPath, redirectData, options)
      return
    }
    if (this.activePage && this.current?.fullPath === matchedRoute.fullPath) {
      this.#debug('navigation skipped: already active', matchedRouteDebugInfo(matchedRoute))
      return
    }
    const to = {
      path: matchedRoute.path, fullPath: matchedRoute.fullPath,
      params: mergedParams, query,
      hash: routeHash(matchedRoute.fullPath, this.#nav),
      meta: route.meta,
      layout: route.layout, matched: [route],
    }
    if (this.#beforeEnter) {
      let shouldContinue = true
      const result = await this.#beforeEnter(to, this.current, (next) => {
        if (next) {
          shouldContinue = false
          const { path: nextPath, data: nextData } = splitRouteTarget(next)
          this.push(nextPath, nextData, options)
        }
      })
      if (navId !== this.#pendingNavId) return
      if (result === false || !shouldContinue) {
        this.#debug('beforeEnter blocked navigation', {
          target: matchedRouteDebugInfo(matchedRoute),
          result,
          shouldContinue,
        })
        return
      }
    }
    const cacheKey = this.resolveCacheKey(route, matchedRoute)
    const currentPage = this.activePage
    const newLayout = to.layout || ''
    const oldLayout = currentPage?.matchedRoute?.route?.layout || ''
    const reuseLayout = !!(oldLayout && newLayout && oldLayout === newLayout)

    // —— query/hash-only 快速路径 ——
    // cacheKey 相同、path 相同、layout 相同且页面已激活：仅 query/hash 变化，
    // 页面与 layout 均已就绪，只需同步 URL 与路由状态（current 是响应式 Wrap，
    // 组件经 $router.current.query 自动感知），跳过 deactive/activate/mount，
    // 避免生命周期抖动（定时器/订阅被短暂停掉再恢复）及与首次导航的竞态。
    const isQueryOnly = !!(
      currentPage && cacheKey &&
      currentPage.matchedRoute &&
      currentPage.matchedRoute.path === matchedRoute.path &&
      currentPage.matchedRoute.route?.layout === matchedRoute.route?.layout &&
      currentPage.matchedRoute.fullPath !== matchedRoute.fullPath
    )
    if (isQueryOnly) {
      this.#setRouterPath(matchedRoute, mode, options)
      currentPage.updateRouter(matchedRoute)
      this.activePage = currentPage
      if (typeof this.#afterEnter === 'function') this.#afterEnter(to, this.current)
      return
    }

    if (reuseLayout && currentPage?.dom && currentPage?.layoutDom) {
      const outlet = currentPage.outlet()
      if (outlet && currentPage.dom.parentNode === outlet) {
        outlet.removeChild(currentPage.dom)
      }
    }

    currentPage?.deactive({ skipLayout: reuseLayout })

    if (reuseLayout && currentPage?.layoutInstance) {
      currentPage.detachLayout()
    }

    this.#setRouterPath(matchedRoute, mode, options)

    if (cacheKey && this.#pageCache.has(cacheKey)) {
      const page = this.#pageCache.get(cacheKey)
      const isSharedPage = page.matchedRoute.fullPath !== matchedRoute.fullPath
      if (isSharedPage) page.updateRouter(matchedRoute)
      // 路由声明了 layout 而缓存页缺失（曾被同 layout 跳转 detachLayout）时，
      // 无论本次是否复用 layout 都必须补挂——否则 attach() 会把内容裸挂到宿主
      // 节点（无外壳、无报错）；缓存缺失/死壳时不挂，activate 失败转 remount
      if (newLayout && !page.layoutDom) {
        const cachedLayout = this.#getCachedLayout(newLayout)
        if (cachedLayout) page.attachLayout(cachedLayout.dom, cachedLayout.instance)
      }
      if (page.activate()) {
        this.activePage = page
        if (typeof this.#afterEnter === 'function') this.#afterEnter(to, this.current)
        return
      }
      this.#debug('cached page activation failed, remounting page', {
        matched: matchedRouteDebugInfo(matchedRoute),
        htmlPath: page.htmlPath,
        cacheKey,
      })
      this.#pageCache.delete(cacheKey)
      page.destroy({ preserveLayout: reuseLayout })
    }
    const page = new Page(this, this.#renderer, this.#hostNode, matchedRoute, cacheKey)
    if (cacheKey) this.#pageCache.set(cacheKey, page)
    this.#debug('mount page', {
      matched: matchedRouteDebugInfo(matchedRoute),
      component: typeof route.component === 'function' ? '[function]' : route.component,
      htmlPath: page.htmlPath,
      fetchUrl: normalizeFetchUrl(page.htmlPath, this.modulePath),
      cacheKey,
      modulePath: this.modulePath,
    })

    const normalizedLayoutUrl = normalizeLayoutUrl(to.layout)
    const existingLayout = this.#getCachedLayout(to.layout)

    let mountResult
    try {
      mountResult = await page.mount(this.runtime, to.layout, existingLayout || null)
    } catch (error) {
      if (navId !== this.#pendingNavId) return
      this.#warn('mount page failed', {
        matched: matchedRouteDebugInfo(matchedRoute),
        htmlPath: page.htmlPath,
        fetchUrl: normalizeFetchUrl(page.htmlPath, this.modulePath),
        modulePath: this.modulePath,
        error,
      })
      if (cacheKey) this.#pageCache.delete(cacheKey)
      page.destroy()
      throw error
    }

    // 导航锁：若已有更新的导航触发，放弃当前导航
    if (navId !== this.#pendingNavId) {
      if (cacheKey) this.#pageCache.delete(cacheKey)
      // 若本 page 已被更新的导航复用（activePage 仍指向它），不能销毁：
      // destroy 会 disposeRuntimeSubtree(layoutDom)，把正在解析中的子组件
      // （如 layout-header 的 parseRef 还挂在 fetchUI 上）实例 purge 掉，
      // 其 vparsing 标记永久残留导致组件被 display:none 隐藏且永不恢复。
      if (this.activePage !== page) {
        page.destroy({ preserveLayout: reuseLayout })
      }
      return
    }

    if (to.layout && page.layoutDom && !existingLayout) {
      this.#layoutCache.set(normalizedLayoutUrl, { dom: page.layoutDom, instance: page.layoutInstance })
    }

    if (mountResult?.redirect) {
      if (cacheKey) this.#pageCache.delete(cacheKey)
      page.destroy()
      const { path: redirectPath, data: redirectData } = splitRouteTarget(mountResult.redirect)
      this.replace(redirectPath, redirectData, options)
      return
    }
    this.activePage = page
    if (typeof this.#afterEnter === 'function') this.#afterEnter(to, this.current)
  }

  /**
   * 导航到目标路径。
   * to: 路径字符串（如 '/aa/123?b_id=x#s'，支持 @ 前缀跳过 prefix）
   * data: { params, query, hash }；path 含 :key 占位符时用 params 填充，
   *       无占位符时 params 作为附加数据合并进匹配结果
   * options: { runtime, navigationPrefix, bypassRouterPrefix, preserveTargetPath, allowHttpUrl, commit }
   */
  async push(to, data = null, options = {}) {
    const matchedRoute = this.matchTo(to, data, options)
    if (!matchedRoute) {
      this.#warn('push skipped: no route matched', this.debugContext({
        target: to,
        data,
        normalized: this.normalizeRouteTarget(to, data, options),
        navigationPrefix: this.resolveNavigationPrefixInfo(options.runtime || this.runtime),
      }))
      return
    }
    if (isCatchAllRoute(matchedRoute.route)) {
      this.#warn('push matched catch-all route', this.debugContext({
        target: to,
        data,
        matched: matchedRouteDebugInfo(matchedRoute),
      }))
    } else {
      this.#debug('push matched', {
        target: to,
        data,
        matched: matchedRouteDebugInfo(matchedRoute),
      })
    }
    await this.#navigateTo(matchedRoute, 'push', options)
  }
  async replace(to, data = null, options = {}) {
    const matchedRoute = this.matchTo(to, data, options)
    if (!matchedRoute) {
      this.#warn('replace skipped: no route matched', this.debugContext({
        target: to,
        data,
        normalized: this.normalizeRouteTarget(to, data, options),
        navigationPrefix: this.resolveNavigationPrefixInfo(options.runtime || this.runtime),
      }))
      return
    }
    if (isCatchAllRoute(matchedRoute.route)) {
      this.#warn('replace matched catch-all route', this.debugContext({
        target: to,
        data,
        matched: matchedRouteDebugInfo(matchedRoute),
      }))
    } else {
      this.#debug('replace matched', {
        target: to,
        data,
        matched: matchedRouteDebugInfo(matchedRoute),
      })
    }
    await this.#navigateTo(matchedRoute, 'replace', options)
  }

  /**
   * 合并/替换当前路由的 query 并导航，path/params/hash 保持不变。
   * patch 中值为 null/undefined 的 key 会被删除；值为 '' 的 key 会写入为空参数（?key=）。
   * options: { mode: 'replace'(默认)|'push', merge: true(默认)|false, silent: false(默认)|true }
   * silent=true 时只同步 URL 与 current（响应式），不重新挂载页面。
   */
  setQuery(patch = {}, options = {}) {
    const mode = options.mode === 'push' ? 'push' : 'replace'
    const query = options.merge === false ? {} : { ...(this.current.query || {}) }
    Object.entries(patch || {}).forEach(([key, value]) => {
      if (value === null || value === undefined) delete query[key]
      // 空字符串：写入 ?key=（置空）。等价检查中“缺失 === 空串”归一，读取侧语义一致；
      // 若当前已是空串形态（?key=）则跳过导航，避免冗余。
      else query[key] = value
    })
    const target = { path: this.current.path, query, hash: this.current.hash }
    if (options.silent === true) return this.#syncLocation(target, mode, options)
    // 目标 query 与当前等价（空值归一：缺失 === ''）时跳过导航。
    // 否则 $watch 初始化等场景 setQuery 会触发冗余导航，与首次导航形成竞态：
    // 旧导航 mount 完成后 navId 过期销毁 page，把正在解析中的 layout 子组件
    // （vparsing 中）实例 purge 掉，组件永久隐藏。
    const curQuery = this.current.query || {}
    const patchKeys = new Set(Object.keys(patch || {}))
    const keys = new Set([...Object.keys(curQuery), ...Object.keys(query)])
    for (const k of keys) {
      // 显式删除（null/undefined）但当前仍残留（含空串形态 ?key=）→ 必须导航清除。
      // 缺失与 '' 归一相等会掩盖此差异，若不强制导航，?key= 会残留在 URL 上删不掉。
      if (patchKeys.has(k) && query[k] === undefined && curQuery[k] !== undefined) {
        return this[mode](target.path, { query: target.query, hash: target.hash }, options)
      }
      if ((curQuery[k] ?? '') !== (query[k] ?? '')) {
        return this[mode](target.path, { query: target.query, hash: target.hash }, options)
      }
    }
  }

  /**
   * 合并/替换当前路由的 params 并导航，query/hash 保持不变。
   * 用当前路由模板（如 /aa/:a_id）重新填充生成新 path，值原样填入（不编码）。
   * patch 值为 null/undefined 时：可选段 /:key? 整段移除；必填段保留模板原文。
   * options: 同 setQuery。
   */
  setParams(patch = {}, options = {}) {
    const mode = options.mode === 'push' ? 'push' : 'replace'
    const template = this.current.matched?.[0]?.path
    if (!template || !/[:*]/.test(template)) {
      this.#warn('setParams skipped: current route has no param template', this.debugContext({
        patch,
        currentPath: this.current.path,
        routePath: template || '',
      }))
      return
    }
    const source = options.merge === false
      ? { ...(patch || {}) }
      : { ...(this.current.params || {}), ...(patch || {}) }
    const target = {
      path: this.#fillRouteTemplate(template, source),
      query: { ...(this.current.query || {}) },
      hash: this.current.hash,
    }
    if (options.silent === true) return this.#syncLocation(target, mode, options)
    return this[mode](target.path, { query: target.query, hash: target.hash }, options)
  }

  // 用 params 反向填充路由模板生成 path，替换顺序与 RouteMatcher.pathToRegexp 一致
  #fillRouteTemplate(template, params) {
    let path = template
    path = path.replace(/\/:([^(/?]+)\?/g, (match, key) => {
      const value = params[key]
      if (value === null || value === undefined || value === '') return ''
      return `/${value}`
    })
    path = path.replace(/\/\*(\w+)\?/g, (match, key) => {
      const value = params[key]
      if (value === null || value === undefined || value === '') return ''
      return `/${value}`
    })
    path = path.replace(/\*(\w+)/g, (match, key) => {
      const value = params[key]
      if (value === null || value === undefined) return match
      return `${value}`
    })
    path = path.replace(/:([^(/?]+)/g, (match, key) => {
      const value = params[key]
      if (value === null || value === undefined) return match
      return `${value}`
    })
    return normalizePathname(path)
  }

  // 仅同步 URL 与 current（silent 模式），不触发守卫与页面挂载流程
  #syncLocation(target, mode, options = {}) {
    const matchedRoute = this.matchTo(target.path, { query: target.query, hash: target.hash }, options)
    if (!matchedRoute) {
      this.#warn('sync location skipped: no route matched', this.debugContext({
        target,
        normalized: this.normalizeRouteTarget(target.path, { query: target.query, hash: target.hash }, options),
      }))
      return
    }
    if (this.activePage && this.current?.fullPath === matchedRoute.fullPath) {
      this.#debug('sync location skipped: already active', matchedRouteDebugInfo(matchedRoute))
      return
    }
    this.#debug('sync location (silent)', {
      target,
      mode,
      matched: matchedRouteDebugInfo(matchedRoute),
    })
    this.#setRouterPath(matchedRoute, mode, options)
    if (this.activePage) this.activePage.matchedRoute = matchedRoute
  }

  go(n) { this.#nav.go(n) }
  back() { this.#nav.back() }
  forward() { this.#nav.forward() }

  resolveRoutesUrl(source = this.#routesSource, runtime = this.runtime || {}) {
    const routesSource = source || '/routes.js'
    if (/^https?:\/\//.test(routesSource)) return routesSource
    if (routesSource.startsWith('/')) return resolveScopedUrl(routesSource, getModulePath(runtime))
    return resolveScopedUrl(`/${routesSource.replace(/^\.?\//, '')}`, getModulePath(runtime))
  }

  async loadRoutes(source = this.#routesSource) {
    const isInlineRoutes = source && typeof source !== 'string'
    const routesUrl = isInlineRoutes ? '' : this.resolveRoutesUrl(source, this.runtime || {})
    this.#debug('load routes', this.debugContext({
      routesUrl,
      routesSourceType: isInlineRoutes ? typeof source : 'url',
    }))
    try {
      const rawRoutesModule = isInlineRoutes ? await source : await import(routesUrl)
      const routeModule = await normalizeRoutesModule(rawRoutesModule, {
        $mod: this.runtime?.$mod || null,
        router: this,
      })
      this.#debug('routes loaded', {
        routesUrl,
        count: routeModule.routes.length,
        pathPrefix: routeModule.path_prefix,
        componentPrefix: routeModule.component_prefix || '',
        routes: routeDebugList(routeModule.routes),
        hasBeforeEnter: typeof routeModule.beforeEnter === 'function',
        hasAfterEnter: typeof routeModule.afterEnter === 'function',
      })
      return routeModule
    } catch (error) {
      this.#warn('routes load failed', this.debugContext({ routesUrl, error }))
      throw error
    }
  }

  async reloadRoutes(source = this.#routesSource) {
    this.#routesSource = source || '/routes.js'
    this.resetRoutes()
    const routeModule = await this.loadRoutes(this.#routesSource)
    this.#routePathPrefix = routeModule.path_prefix === undefined
      ? normalizeRoutePrefix(resolveScope(this.runtime))
      : normalizeRoutePrefix(routeModule.path_prefix)
    this.#routeComponentPrefix = normalizeRoutePrefix(routeModule.component_prefix || '')
    this.#beforeEnter = routeModule.beforeEnter || null
    this.#afterEnter = routeModule.afterEnter || null
    this.addRoutes(routeModule.routes, {
      pathPrefix: this.#routePathPrefix,
      componentPrefix: this.#routeComponentPrefix,
    })
    await this.handleNavigation({ type: 'replace', to: this.#nav.href, committed: true })
  }

  async reloadPrefix() {
    const routerPrefixInfo = this.resolveRouterPrefixInfo(this.#hostNode, this.runtime)
    const nextPrefix = routerPrefixInfo.value
    if (nextPrefix === this.#routerPrefix) return
    this.#debug('router prefix changed', this.debugContext({
      nextPrefix,
      routerPrefixSource: routerPrefixInfo.source,
      routerPrefixRaw: routerPrefixInfo.raw,
    }))
    this.#routerPrefix = nextPrefix
    this.#disposeNavListener?.()
    this.#nav = resolveRouterHistory(this.#hostNode, this.resolveNavigationPrefix(this.runtime))
    if (this.#nav?.affectsDocument === false) {
      if (this.#nav.location) this.runtime.$sys.location = this.#nav.location
      if (this.#nav.history) this.runtime.$sys.history = this.#nav.history
    }
    this.#disposeNavListener = this.#nav.onChange((event) => {
      this.handleNavigation(event)
    })
    await this.reloadRoutes(this.#routesSource)
  }

  updateFixedParams(source = readRouterParamsSource(this.#hostNode)) {
    const previousSnapshot = this.#snapshot(this.current)
    this.#fixedParams = normalizeFixedParams(source)
    const routeParams = this.activePage?.matchedRoute?.params || {}
    const nextParams = this.mergeParams(routeParams)
    Object.assign(this.current, {
      params: nextParams,
    })
    this.#debug('router params changed', this.debugContext({
      params: nextParams,
    }))
    this.#notifyListeners(this.current, previousSnapshot)
  }

  async handleNavigation(event) {
    if (event?.source === this) return
    const target = event?.type === 'popstate' ? (event.url || event.to) : (event?.to || event?.url)
    const method = event?.type === 'replace' || event?.type === 'popstate' ? 'replace' : 'push'
    if (!target) return
    const normalizeOptions = {
      preserveTargetPath: event?.committed === true,
      allowHttpUrl: event?.committed === true,
    }
    const matchedRoute = this.matchTo(target, null, normalizeOptions)
    if (!matchedRoute) {
      this.#debug('history navigation skipped: no route matched', this.debugContext({
        event,
        target,
        normalized: this.normalizeRouteTarget(target, null, normalizeOptions),
      }))
      return
    }
    this.#debug('history navigation matched', {
      event,
      target,
      method,
      matched: matchedRouteDebugInfo(matchedRoute),
    })
    await this.#navigateTo(matchedRoute, method, { commit: event?.committed !== true })
  }

  async mount(renderer, node, runtime) {
    this.#hostNode = node
    this.#renderer = renderer
    const routerRuntime = createRuntimeContext(runtime || null, runtime?.$mod || runtime || null, { $router: this })
    this.#modulePath = getModulePath(routerRuntime || {})
    const routerPrefixInfo = this.resolveRouterPrefixInfo(node, routerRuntime)
    this.#routerPrefix = routerPrefixInfo.value
    this.#fixedParams = normalizeFixedParams(readRouterParamsSource(node))
    if (!this.#nav) this.#nav = resolveRouterHistory(node, this.resolveNavigationPrefix(routerRuntime))
    if (this.#nav?.affectsDocument === false) {
      if (this.#nav.location) routerRuntime.$sys.location = this.#nav.location
      if (this.#nav.history) routerRuntime.$sys.history = this.#nav.history
    }
    setInstance(node, this.instance)
    this.instance.host = node
    this.instance.runtime = routerRuntime
    this.#routesSource = getRouterRoutesSource(node) || '/routes.js'
    Object.assign(this.current, {
      params: this.mergeParams({}),
    })
    this.#debug('mount router', this.debugContext({
      routerPrefixSource: routerPrefixInfo.source,
      routerPrefixRaw: routerPrefixInfo.raw,
      initial: node.getAttribute('initial') || '',
      history: node.getAttribute('history') || 'browser',
    }))
    this.resetRoutes()
    this.#disposeNavListener?.()
    this.#disposeNavListener = this.#nav.onChange((event) => {
      this.handleNavigation(event)
    })
    this.#disposeRoutesSourceListener?.()
    const onRoutesSourceChange = (event) => {
      this.reloadRoutes(event?.detail?.source).catch(error => {
        this.#warn('routes reload failed', this.debugContext({ error }))
      })
    }
    node.addEventListener('vhtml-router-routes-change', onRoutesSourceChange)
    this.#disposeRoutesSourceListener = () => {
      node.removeEventListener('vhtml-router-routes-change', onRoutesSourceChange)
    }
    this.#disposePrefixSourceListener?.()
    const onPrefixSourceChange = () => {
      this.reloadPrefix().catch(error => {
        this.#warn('router prefix reload failed', this.debugContext({ error }))
      })
    }
    node.addEventListener('vhtml-router-prefix-change', onPrefixSourceChange)
    this.#disposePrefixSourceListener = () => {
      node.removeEventListener('vhtml-router-prefix-change', onPrefixSourceChange)
    }
    this.#disposeParamsSourceListener?.()
    const onParamsSourceChange = (event) => {
      this.updateFixedParams(event?.detail?.source)
    }
    node.addEventListener('vhtml-router-params-change', onParamsSourceChange)
    this.#disposeParamsSourceListener = () => {
      node.removeEventListener('vhtml-router-params-change', onParamsSourceChange)
    }
    await this.reloadRoutes(this.#routesSource)
  }
}

// ---- RouterRuntime ----

class RouterRuntime {
  #anchorClick = new AnchorClickRuntime()
  #browserHistory = getBrowserHistory()
  #views = new WeakMap()

  constructor() { this.#anchorClick.init() }

  push(to) { this.#browserHistory.request('push', to) }
  replace(to) { this.#browserHistory.request('replace', to) }
  go(n) { this.#browserHistory.go(n) }
  back() { this.#browserHistory.back() }
  forward() { this.#browserHistory.forward() }

  mountView(renderer, node, runtime) {
    let view = this.#views.get(node)
    if (!view) {
      view = new RouterView()
      this.#views.set(node, view)
      view.mount(renderer, node, runtime)
    }
    return view
  }
}

export const $router = new RouterRuntime()
