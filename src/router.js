/*
 * router.js — 客户端路由器
 * Copyright (C) 2024 veypi <i@veypi.com>
 *
 * 合并原 vrouter.js + routes.js + navigation.js。
 * 支持动态路由、页面缓存、路由守卫、布局。
 */

import { Wrap, Watch, Cancel } from './reactive.js'
import { Run } from './sandbox.js'
import { templateLoader } from './loader.js'
import { createRuntimeContext, getModulePath, resolveScopedUrl } from './env.js'
import { isRouterNavigableHref } from './url.js'
import {
  instanceOf, setInstance,
  createInstance, detachInstance,
} from './component.js'

// ---- NavigationRuntime (原 navigation.js) ----

class NavigationRuntime {
  #listeners = new Set()
  #loaded = false
  #handleBodyClick = null
  #handlePopstate = null

  onChange(listener) {
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }

  notify(payload) {
    for (const listener of this.#listeners) listener(payload)
  }

  init() {
    if (this.#loaded) return
    this.#loaded = true
    this.#handleBodyClick = (event) => {
      const linkElement = event.target.closest('a')
      if (!linkElement) return
      const href = linkElement.getAttribute('href')
      if (!isRouterNavigableHref(href)) return
      if (linkElement.getAttribute('target') == '_blank') {
        window.open(linkElement.getAttribute('href'), '_blank')
      } else if (linkElement.hasAttribute('reload')) {
        event.preventDefault()
        window.location.href = href
      } else {
        event.preventDefault()
        this.push(href)
      }
    }
    this.#handlePopstate = () => {
      this.notify({ type: 'popstate', url: window.location.href })
    }
    document.body.addEventListener('click', this.#handleBodyClick, true)
    window.addEventListener('popstate', this.#handlePopstate)
  }

  push(to) { this.notify({ type: 'push', to }) }
  replace(to) { this.notify({ type: 'replace', to }) }
  go(n) { history.go(n) }
  back() { history.back() }
  forward() { history.forward() }
}

// ---- RouteMatcher (原 routes.js) ----

export class RouteMatcher {
  constructor(path, name) {
    this.originalPath = path
    this.name = name
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
    else if (target?.name === this.name) {
      return { path: this.originalPath, params: target.params || {}, matched: this.originalPath }
    } else return null
    const match = this.regexp.exec(path)
    if (!match) return null
    const params = {}
    this.keys.forEach(key => {
      if (match.groups?.[key] !== undefined) params[key] = match.groups[key]
    })
    return { path: this.originalPath, params, matched: match[0] }
  }
}

export function parseUrlString(urlString, scoped) {
  let url
  let path = ''
  if (urlString.startsWith('http://') || urlString.startsWith('https://')) {
    url = new URL(urlString)
    if (url.origin !== window.location.origin) return null
    path = url.pathname
  } else {
    url = new URL(urlString, window.location.href)
    path = url.pathname
  }
  if (scoped && path.startsWith(scoped)) {
    path = path.slice(scoped.length) || '/'
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

function toNormalizedRoutes(moduleExports) {
  if (Array.isArray(moduleExports)) {
    return { routes: moduleExports, beforeEnter: null, afterEnter: null }
  }
  if (Array.isArray(moduleExports?.routes)) {
    return {
      routes: moduleExports.routes,
      beforeEnter: moduleExports.beforeEnter || null,
      afterEnter: moduleExports.afterEnter || null,
    }
  }
  return { routes: [], beforeEnter: moduleExports?.beforeEnter || null, afterEnter: moduleExports?.afterEnter || null }
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

// ---- 生命周期辅助 ----

function runRuntimeTreeLifecycle(root, method) {
  if (!root || typeof method !== 'string') return
  const rootInstance = instanceOf(root)
  if (rootInstance) {
    const visited = new Set()
    const runInstance = (instance) => {
      if (!instance || visited.has(instance)) return
      visited.add(instance)
      const host = instance.host
      if (host) instance.scope?.[method]?.(host)
      instance.children.forEach(child => runInstance(child))
    }
    runInstance(rootInstance)
    return
  }
  instanceOf(root)?.scope?.[method]?.(root)
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
    let path = matchedRoute.route.component || matchedRoute.route.path
    if (typeof path === 'function') path = path(matchedRoute.path, matchedRoute.params)
    Object.entries(matchedRoute.params).forEach(([key, value]) => {
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
      params: matchedRoute.params,
      query: matchedRoute.query,
      hash: new URL(matchedRoute.fullPath, window.location.origin).hash,
      meta: matchedRoute.route?.meta || {},
      name: matchedRoute.route?.name,
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
      if (this.dom && this.dom.parentNode !== outlet) {
        outlet.innerHTML = ''
        outlet.append(this.dom)
      }
      this.layoutInstance.host = this.layoutDom
      this.instance.host = this.dom
      return
    }
    if (this.dom && !this.dom.isConnected) {
      this.node.innerHTML = ''
      this.node.append(this.dom)
    }
    this.instance.host = this.dom
  }

  async mount(runtime, layout) {
    const parser = await templateLoader.fetchUI(this.htmlPath, runtime)
    if (parser.err) {
      const redirectTarget = this.resolveErrorRedirect(parser.err)
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
    this.updateTitle()
    this.attach()
    if (!this._meta.didInitialActivation) { this._meta.didInitialActivation = true; return }
    this.roots().forEach(root => runRuntimeTreeLifecycle(root, 'activate'))
  }

  deactive() {
    this.clearTitleWatchers()
    if (!this._meta.didInitialActivation) return
    this.roots().forEach(root => runRuntimeTreeLifecycle(root, 'deactive'))
  }

  destroy() {
    this.clearTitleWatchers()
    detachInstance(this.layoutInstance)
    detachInstance(this.instance)
    this.layoutInstance = null
  }
}

// ---- RouterView ----

class RouterView {
  #stringRoutes = []
  #regexRoutes = []
  #routesByName = new Map()
  #nav = null
  #history = []
  #pageCache = new Map()
  #routesSource = '/routes.js'
  #beforeEnter = null
  #afterEnter = null
  #listeners = new Set()
  #hostNode = null
  #renderer = null
  #disposeNavListener = null
  #currentPage = null

  constructor(nav) {
    this.#nav = nav
    this.instance = createInstance(null, null, 'router-view')
    this.instance.data = Wrap({})
    this.instance.route = this.instance.data
    this.instance.router = this
  }

  get routes() { return [...this.#stringRoutes, ...this.#regexRoutes] }
  get history() { return this.#history.slice() }
  get current() { return this.instance.data }
  get query() { return this.instance.data?.query || {} }
  get params() { return this.instance.data?.params || {} }
  get modulePath() {
    const mod = instanceOf(this.#hostNode)?.runtime?.$mod
    return mod?.url_prefix || mod?.scoped || ''
  }
  get routesSource() { return this.#routesSource }
  get runtime() { return this.#hostNode ? instanceOf(this.#hostNode)?.runtime : null }
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
      description: routeState.description || '',
      layout: routeState.layout || '',
      name: routeState.name,
      matched: [...(routeState.matched || [])],
    }
  }

  #setRouterPath(matchedRoute, mode = 'push') {
    const previousSnapshot = this.#snapshot(this.current)
    const nextSnapshot = this.#snapshot({
      path: matchedRoute.path,
      fullPath: matchedRoute.fullPath,
      params: matchedRoute.params || {},
      query: matchedRoute.query || {},
      hash: new URL(matchedRoute.fullPath, window.location.origin).hash,
      meta: matchedRoute.route?.meta || {},
      description: matchedRoute.route?.description || '',
      layout: matchedRoute.route?.layout || '',
      name: matchedRoute.route?.name,
      matched: matchedRoute.route ? [matchedRoute.route] : [],
    })
    Object.assign(this.current, nextSnapshot)
    if (mode === 'replace' && this.#history.length > 0) {
      this.#history[this.#history.length - 1] = nextSnapshot
    } else {
      this.#history.push(nextSnapshot)
    }
    const targetUrl = this.modulePath && !matchedRoute.fullPath.startsWith('http')
      ? `${this.modulePath}${matchedRoute.fullPath}`
      : matchedRoute.fullPath
    if (mode === 'replace') history.replaceState({}, '', targetUrl)
    else history.pushState({}, '', targetUrl)
    this.#notifyListeners(this.current, previousSnapshot)
  }

  #isRegexPath(path) {
    return /[:*?()[\]{}^$+.]/.test(path)
  }

  addRoute(route) {
    if (!route.path) throw new Error('Route must have a path')
    if (route.path !== '/' && route.path.endsWith('/')) route.path = route.path.slice(0, -1)
    const routeConfig = {
      path: route.path,
      component: route.component,
      redirect: route.redirect,
      error_redirect: route.error_redirect,
      name: route.name,
      meta: route.meta || {},
      children: route.children || [],
      matcher: new RouteMatcher(route.path, route.name),
      description: route.description || '',
      layout: route.layout || '',
      cacheKey: route.cacheKey,
    }
    if (this.#isRegexPath(route.path)) this.#regexRoutes.push(routeConfig)
    else this.#stringRoutes.push(routeConfig)
    if (route.name) this.#routesByName.set(route.name, routeConfig)
    if (route.children?.length > 0) {
      route.children.forEach(child => {
        const childPath = route.path + (child.path.startsWith('/') ? child.path : `/${child.path}`)
        const layout = child.layout || route.layout || ''
        const meta = { ...route.meta, ...child.meta }
        this.addRoute({ ...child, path: childPath, parent: routeConfig, layout, meta })
      })
    }
  }

  addRoutes(routes) { routes.forEach(route => this.addRoute(route)) }

  resetRoutes() {
    this.activePage?.deactive()
    this.#pageCache.forEach(page => page.destroy())
    this.#stringRoutes = []
    this.#regexRoutes = []
    this.#routesByName = new Map()
    this.#history = []
    this.#pageCache = new Map()
    this.activePage = null
  }

  normalizeRouteTarget(to) {
    let path, query = {}, params = {}, hash = '', name
    if (typeof to === 'string') {
      const parsed = parseUrlString(to, this.modulePath)
      if (!parsed) return null
      path = parsed.path; query = { ...parsed.query }; hash = parsed.hash
    } else if (to && typeof to === 'object') {
      if (to.path) {
        const parsed = parseUrlString(to.path, this.modulePath)
        if (!parsed) return null
        path = parsed.path; query = { ...parsed.query, ...(to.query || {}) }
        hash = to.hash || parsed.hash; params = to.params || {}
      } else if (to.name) {
        name = to.name; query = to.query || {}; params = to.params || {}; hash = to.hash || ''
      } else return null
    } else return null
    if (path && !path.startsWith('/')) path = `/${path}`
    if (this.modulePath && path?.startsWith(this.modulePath)) path = path.slice(this.modulePath.length) || '/'
    if (path && !path.startsWith('/')) path = `/${path}`
    if (path !== '/' && path?.endsWith('/')) path = path.slice(0, -1)
    return { path, query, params, hash, name }
  }

  matchRoute(to) {
    const routeInfo = this.normalizeRouteTarget(to)
    if (!routeInfo) return null
    const { path, query, params, name } = routeInfo
    if (name) {
      const route = this.#routesByName.get(name)
      if (!route) return null
      let resolvedPath = route.path
      Object.entries(params).forEach(([key, value]) => {
        resolvedPath = resolvedPath.replace(`:${key}`, value)
      })
      const match = route.matcher.match(resolvedPath)
      if (!match) return null
      return { route, params: { ...match.params, ...params }, matched: match.matched, path: resolvedPath, query, name }
    }
    for (const route of this.#stringRoutes) {
      if (route.path === path && (route.component || route.redirect)) {
        return { route, params: { ...params }, matched: path, path, query, name: route.name }
      }
    }
    for (const route of this.#regexRoutes) {
      const match = route.matcher.match(path)
      if (match && (route.component || route.redirect)) {
        return { route, params: { ...match.params, ...params }, matched: match.matched, path, query, name: route.name }
      }
    }
    return null
  }

  matchTo(to) {
    const matchResult = this.matchRoute(to)
    if (!matchResult) return null
    const { route, params, query, path, name } = matchResult
    let search = ''
    if (query && Object.keys(query).length > 0) {
      search = `?${Object.entries(query).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')}`
    }
    const fullPath = `${path || matchResult.path}${search}`
    return { route, params, query, name: name || route.name, path: path || matchResult.path, fullPath, matched: [route] }
  }

  resolveCacheKey(route, matchedRoute) {
    const config = route.cacheKey
    if (config === false) return null
    if (config === undefined || config === true) return matchedRoute.fullPath
    if (typeof config === 'string') return config
    if (typeof config === 'function') return config(matchedRoute)
    return matchedRoute.fullPath
  }

  async #navigateTo(matchedRoute, mode = 'push') {
    if (!matchedRoute) return
    const { route, params, query } = matchedRoute
    if (route.redirect) {
      const redirectTarget = typeof route.redirect === 'function' ? route.redirect(matchedRoute) : route.redirect
      this.push(redirectTarget)
      return
    }
    if (this.activePage && this.current?.fullPath === matchedRoute.fullPath) return
    const to = {
      path: matchedRoute.path, fullPath: matchedRoute.fullPath,
      params, query,
      hash: new URL(matchedRoute.fullPath, window.location.origin).hash,
      meta: route.meta, description: route.description,
      layout: route.layout, name: route.name, matched: [route],
    }
    if (this.#beforeEnter) {
      let shouldContinue = true
      const result = await this.#beforeEnter(to, this.current, (next) => {
        if (next) { shouldContinue = false; this.push(next) }
      })
      if (result === false || !shouldContinue) return
    }
    const cacheKey = this.resolveCacheKey(route, matchedRoute)
    this.activePage?.deactive()
    this.#setRouterPath(matchedRoute, mode)
    if (cacheKey && this.#pageCache.has(cacheKey)) {
      const page = this.#pageCache.get(cacheKey)
      const isSharedPage = page.matchedRoute.fullPath !== matchedRoute.fullPath
      if (isSharedPage) page.updateRouter(matchedRoute)
      page.activate()
      this.activePage = page
      if (typeof this.#afterEnter === 'function') this.#afterEnter(to, this.current)
      return
    }
    const page = new Page(this, this.#renderer, this.#hostNode, matchedRoute, cacheKey)
    if (cacheKey) this.#pageCache.set(cacheKey, page)
    let mountResult
    try {
      mountResult = await page.mount(this.runtime, to.layout)
    } catch (error) {
      if (cacheKey) this.#pageCache.delete(cacheKey)
      page.destroy()
      throw error
    }
    if (mountResult?.redirect) {
      if (cacheKey) this.#pageCache.delete(cacheKey)
      page.destroy()
      this.replace(mountResult.redirect)
      return
    }
    this.activePage = page
    if (typeof this.#afterEnter === 'function') this.#afterEnter(to, this.current)
  }

  async push(to) { this.#nav.push(to) }
  replace(to) { this.#nav.replace(to) }
  go(n) { this.#nav.go(n) }
  back() { this.#nav.back() }
  forward() { this.#nav.forward() }

  resolveRoutesUrl(source = this.#routesSource, runtime = this.runtime || {}) {
    const routesSource = source || '/routes.js'
    if (/^https?:\/\//.test(routesSource)) return routesSource
    if (routesSource.startsWith('/')) return resolveScopedUrl(routesSource, getModulePath(runtime))
    return resolveScopedUrl(`/${routesSource.replace(/^\.?\//, '')}`, getModulePath(runtime))
  }

  async loadRoutes() {
    const routesUrl = this.resolveRoutesUrl(this.#routesSource, this.runtime || {})
    return normalizeRoutesModule(await import(routesUrl), {
      $mod: this.runtime?.$mod || null,
      router: this,
    })
  }

  async handleNavigation(event) {
    const target = event?.type === 'popstate' ? event.url : event?.to
    const method = event?.type === 'replace' || event?.type === 'popstate' ? 'replace' : 'push'
    if (!target) return
    const matchedRoute = this.matchTo(target)
    if (!matchedRoute) return
    await this.#navigateTo(matchedRoute, method)
  }

  async mount(renderer, node, runtime) {
    this.#hostNode = node
    this.#renderer = renderer
    const routerRuntime = createRuntimeContext(runtime || null, runtime?.$mod || runtime || null, { $router: this })
    setInstance(node, this.instance)
    this.instance.host = node
    this.instance.runtime = routerRuntime
    this.#routesSource = node.getAttribute('routes') || '/routes.js'
    this.resetRoutes()
    this.#disposeNavListener?.()
    this.#disposeNavListener = this.#nav.onChange((event) => {
      this.handleNavigation(event)
    })
    const routeModule = await this.loadRoutes()
    this.#beforeEnter = routeModule.beforeEnter || null
    this.#afterEnter = routeModule.afterEnter || null
    this.addRoutes(routeModule.routes)
    await this.handleNavigation({ type: 'replace', to: window.location.href })
  }
}

// ---- RouterRuntime ----

class RouterRuntime {
  #nav = new NavigationRuntime()
  #views = new WeakMap()

  constructor() { this.#nav.init() }

  push(to) { this.#nav.push(to) }
  replace(to) { this.#nav.replace(to) }
  go(n) { this.#nav.go(n) }
  back() { this.#nav.back() }
  forward() { this.#nav.forward() }

  mountView(renderer, node, runtime) {
    let view = this.#views.get(node)
    if (!view) {
      view = new RouterView(this.#nav)
      this.#views.set(node, view)
    }
    view.mount(renderer, node, runtime)
    return view
  }
}

export const $router = new RouterRuntime()
