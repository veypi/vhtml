import vproxy from './vproxy.js'
import vget from './vget.js'
import { createRuntimeEnv } from './runtime/env.js'
import { resolveScopedUrl } from './runtime/env.js'
import { getModulePath } from './runtime/context.js'
import { createInstance, detachInstance } from './runtime/instance.js'
import NavigationRuntime from './runtime/navigation.js'
import { normalizeRoutesModule, parseUrlString, prepareLayoutDom, RouteMatcher } from './runtime/routes.js'
import { findNearestInstance, getRuntime, getScope, setRouter } from './runtime/dom.js'

function runRuntimeTreeLifecycle(root, method) {
  if (!root || typeof method !== 'string') {
    return
  }
  const rootInstance = findNearestInstance(root, null)
  if (rootInstance) {
    const visited = new Set()
    const runInstance = (instance) => {
      if (!instance || visited.has(instance)) {
        return
      }
      visited.add(instance)
      const scope = instance.scope
      if (scope && typeof scope[method] === 'function') {
        scope[method](instance.host)
      }
      instance.children.forEach((child) => {
        runInstance(child)
      })
    }
    runInstance(rootInstance)
    return
  }
  const scope = getScope(root)
  if (scope && typeof scope[method] === 'function') {
    scope[method](root)
  }
}

class Page {
  constructor(ownerView, vhtml, node, matchedRoute, cacheKey) {
    this.ownerView = ownerView
    this.vhtml = vhtml
    this.node = node
    this.instance = createInstance(node, ownerView.instance, 'page')
    this.instance.meta = {
      htmlPath: this.resolveHtmlPath(matchedRoute),
      title: '',
      titleWatchers: [],
      didInitialActivation: false,
      layoutOutlet: null,
    }
    this.instance.route = matchedRoute
    this.instance.cacheKey = cacheKey
    this.layoutInstance = null
  }

  get meta() {
    return this.instance.meta
  }

  get matchedRoute() {
    return this.instance.route
  }

  set matchedRoute(value) {
    this.instance.route = value || null
  }

  get cacheKey() {
    return this.instance.cacheKey
  }

  get htmlPath() {
    return this.meta.htmlPath
  }

  get dom() {
    return this.instance.host
  }

  set dom(value) {
    this.instance.host = value || null
  }

  get layoutDom() {
    return this.layoutInstance?.host || null
  }

  set layoutDom(value) {
    if (!value) {
      if (this.layoutInstance) {
        this.layoutInstance.host = null
      }
      return
    }
    if (!this.layoutInstance) {
      this.layoutInstance = createInstance(value, this.instance, 'layout')
    } else {
      this.layoutInstance.host = value
    }
  }

  resolveHtmlPath(matchedRoute) {
    let path = matchedRoute.route.component || matchedRoute.route.path
    if (typeof path === 'function') {
      path = path(matchedRoute.path)
    }
    Object.entries(matchedRoute.params).forEach(([key, value]) => {
      path = path.replace(`:${key}`, value)
    })
    if (!path.startsWith('/')) {
      path = `/${path}`
    }
    if (path.endsWith('/')) {
      path = path.slice(0, -1)
    }
    if (!path.endsWith('.html')) {
      path = `${path}.html`
    }
    return path
  }

  updateRouter(matchedRoute) {
    this.matchedRoute = matchedRoute
    const router = this.runtime()?.$sys?.$router
    if (!router) {
      return
    }
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
    if (this.layoutInstance?.host) {
      return [this.layoutInstance.host]
    }
    return this.instance.host ? [this.instance.host] : []
  }

  runtime() {
    return this.instance.runtime || this.layoutInstance?.runtime || getRuntime(this.dom) || getRuntime(this.layoutDom) || null
  }

  outlet() {
    if (!this.layoutDom) {
      return this.node
    }
    this.meta.layoutOutlet = this.meta.layoutOutlet || this.layoutDom.querySelector('[data-vrouter-outlet]') || this.layoutDom
    return this.meta.layoutOutlet
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
      this.layoutInstance.runtime = getRuntime(this.layoutDom) || this.runtime()
      this.instance.host = this.dom
      this.instance.runtime = getRuntime(this.dom) || this.layoutInstance.runtime
      return
    }
    if (this.dom && !this.dom.isConnected) {
      this.node.innerHTML = ''
      this.node.append(this.dom)
    }
    this.instance.host = this.dom
    this.instance.runtime = getRuntime(this.dom) || this.ownerView.instance.runtime
  }

  async mount(runtime, layout) {
    const parser = await vget.FetchUI(this.htmlPath, runtime)
    if (parser.err) {
      throw new Error(`load page failed: ${this.htmlPath} ${parser.err}`)
    }
    this.meta.title = parser.title || ''
    this.dom = document.createElement('div')
    this.dom.setAttribute('vsrc', this.htmlPath)
    this.dom.setAttribute('data-vrouter-cache', '')
    if (!layout) {
      this.node.innerHTML = ''
      this.node.append(this.dom)
      await this.vhtml.parseRef(this.htmlPath, this.dom, {}, runtime, null)
      this.instance.host = this.dom
      this.instance.runtime = getRuntime(this.dom) || runtime || null
      this.activate()
      return
    }
    let layoutUrl = layout
    if (!layoutUrl.startsWith('/')) {
      layoutUrl = `/${layoutUrl}`
    }
    if (!layoutUrl.endsWith('.html')) {
      layoutUrl += '.html'
    }
    if (!layoutUrl.startsWith('/layout')) {
      layoutUrl = `/layout${layoutUrl}`
    }
    const layoutParser = await vget.FetchUI(layoutUrl, runtime)
    if (layoutParser.err) {
      throw new Error(`load layout failed: ${layoutUrl} ${layoutParser.err}`)
    }
    this.layoutDom = prepareLayoutDom(layoutParser.body.cloneNode(true))
    this.layoutDom?.setAttribute('data-vrouter-layout', '')
    this.node.innerHTML = ''
    this.node.append(this.layoutDom)
    await this.vhtml.parseRef(`/layout/${layout}`, this.layoutDom, {}, runtime, null, true)
    this.layoutInstance.runtime = getRuntime(this.layoutDom) || runtime || null
    this.outlet().innerHTML = ''
    this.outlet().append(this.dom)
    await this.vhtml.parseRef(this.htmlPath, this.dom, {}, runtime, null)
    this.instance.host = this.dom
    this.instance.runtime = getRuntime(this.dom) || this.layoutInstance.runtime
    this.activate()
  }

  updateTitle() {
    this.clearTitleWatchers()
    if (!this.meta.title) {
      return
    }
    const title = this.meta.title.trim()
    if (!title.includes('{{')) {
      document.title = title
      return
    }
    const target = this.dom || this.layoutDom
    if (!target) {
      return
    }
    const titleRuntime = this.runtime() || {}
    const varRegex = /{{|}}/g
    let match
    let nextStart = 0
    let start = -1
    const parts = []
    while ((match = varRegex.exec(title)) !== null) {
      if (match[0] === '{{') {
        start = match.index
      } else if (start >= 0) {
        if (nextStart !== start) {
          parts.push(title.slice(nextStart, start))
        }
        parts.push('')
        const expr = title.slice(start + 2, match.index)
        const partIndex = parts.length - 1
        nextStart = match.index + 2
        start = -1
        const watchId = vproxy.Watch(() => {
          let value = vproxy.Run(expr, {}, titleRuntime || {})
          if (typeof value === 'function') {
            value = value()
          } else if (typeof value === 'object' && value) {
            value = JSON.stringify(value)
          }
          parts[partIndex] = value
          document.title = parts.join('')
        })
        this.meta.titleWatchers.push(watchId)
      }
    }
    parts.push(title.slice(nextStart))
    document.title = parts.join('')
  }

  clearTitleWatchers() {
    while (this.meta.titleWatchers.length > 0) {
      vproxy.Cancel(this.meta.titleWatchers.pop())
    }
  }

  activate() {
    this.updateTitle()
    this.attach()
    if (!this.meta.didInitialActivation) {
      this.meta.didInitialActivation = true
      return
    }
    this.roots().forEach((root) => runRuntimeTreeLifecycle(root, 'activate'))
  }

  deactive() {
    this.clearTitleWatchers()
    if (!this.meta.didInitialActivation) {
      return
    }
    this.roots().forEach((root) => runRuntimeTreeLifecycle(root, 'deactive'))
  }

  destroy() {
    this.clearTitleWatchers()
    detachInstance(this.layoutInstance)
    detachInstance(this.instance)
    this.layoutInstance = null
  }
}

class RouterView {
  #stringRoutes = []
  #regexRoutes = []
  #routesByName = new Map()
  #nav = null

  constructor(nav) {
    this.#nav = nav
    this.instance = createInstance(null, null, 'router-view')
    this.instance.data = vproxy.Wrap({})
    this.instance.route = this.instance.data
    this.instance.meta = {
      history: [],
      pageCache: new Map(),
      routesSource: '/routes.js',
      beforeEnter: null,
      afterEnter: null,
      listeners: new Set(),
      hostNode: null,
      renderer: null,
      disposeNavListener: null,
    }
  }

  get routes() { return [...this.#stringRoutes, ...this.#regexRoutes] }
  get history() { return this.instance.meta.history.slice() }
  get current() { return this.instance.data }
  get query() { return this.instance.data?.query || {} }
  get params() { return this.instance.data?.params || {} }
  get modulePath() { return getModulePath(this.instance.runtime) }
  get routesSource() { return this.instance.meta.routesSource }
  get runtime() { return this.instance.runtime }
  get activePage() { return this.instance.currentPage || null }
  set activePage(value) { this.instance.currentPage = value || null }
  get beforeEnter() { return this.instance.meta.beforeEnter }
  set beforeEnter(value) { this.instance.meta.beforeEnter = typeof value === 'function' ? value : null }
  get afterEnter() { return this.instance.meta.afterEnter }
  set afterEnter(value) { this.instance.meta.afterEnter = typeof value === 'function' ? value : null }
  get pageCache() { return this.instance.meta.pageCache }
  get listeners() { return this.instance.meta.listeners }
  get hostNode() { return this.instance.meta.hostNode }
  set hostNode(value) { this.instance.meta.hostNode = value || null }
  get renderer() { return this.instance.meta.renderer }
  set renderer(value) { this.instance.meta.renderer = value || null }
  get disposeNavListener() { return this.instance.meta.disposeNavListener || null }
  set disposeNavListener(value) { this.instance.meta.disposeNavListener = value || null }

  onChange(listener) {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  #notifyListeners(to, from) {
    for (const listener of this.listeners) {
      listener(to, from)
    }
  }

  #createSnapshot(routeState) {
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
    const previousSnapshot = this.#createSnapshot(this.current)
    const nextSnapshot = this.#createSnapshot({
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
    if (mode === 'replace' && this.instance.meta.history.length > 0) {
      this.instance.meta.history[this.instance.meta.history.length - 1] = nextSnapshot
    } else {
      this.instance.meta.history.push(nextSnapshot)
    }
    const targetUrl = this.modulePath && !matchedRoute.fullPath.startsWith('http')
      ? `${this.modulePath}${matchedRoute.fullPath}`
      : matchedRoute.fullPath
    if (mode === 'replace') {
      history.replaceState({}, '', targetUrl)
    } else {
      history.pushState({}, '', targetUrl)
    }
    this.#notifyListeners(this.current, previousSnapshot)
  }

  #isRegexPath(path) {
    return /[:*?()[\]{}^$+.]/.test(path)
  }

  addRoute(route) {
    if (!route.path) {
      throw new Error('Route must have a path')
    }
    if (route.path !== '/' && route.path.endsWith('/')) {
      route.path = route.path.slice(0, -1)
    }
    const routeConfig = {
      path: route.path,
      component: route.component,
      redirect: route.redirect,
      name: route.name,
      meta: route.meta || {},
      children: route.children || [],
      matcher: new RouteMatcher(route.path, route.name),
      description: route.description || '',
      layout: route.layout || '',
      cacheKey: route.cacheKey,
    }
    if (this.#isRegexPath(route.path)) {
      this.#regexRoutes.push(routeConfig)
    } else {
      this.#stringRoutes.push(routeConfig)
    }
    if (route.name) {
      this.#routesByName.set(route.name, routeConfig)
    }
    if (route.children?.length > 0) {
      route.children.forEach((child) => {
        const childPath = route.path + (child.path.startsWith('/') ? child.path : `/${child.path}`)
        const layout = child.layout || route.layout || ''
        const meta = { ...route.meta, ...child.meta }
        this.addRoute({ ...child, path: childPath, parent: routeConfig, layout, meta })
      })
    }
  }

  addRoutes(routes) {
    routes.forEach((route) => this.addRoute(route))
  }

  resetRoutes() {
    this.activePage?.deactive()
    this.pageCache.forEach((page) => {
      page.destroy()
    })
    this.#stringRoutes = []
    this.#regexRoutes = []
    this.#routesByName = new Map()
    this.instance.meta.history = []
    this.instance.meta.pageCache = new Map()
    this.activePage = null
  }

  normalizeRouteTarget(to) {
    let path
    let query = {}
    let params = {}
    let hash = ''
    let name
    if (typeof to === 'string') {
      const parsed = parseUrlString(to, this.modulePath)
      if (!parsed) {
        return null
      }
      path = parsed.path
      query = { ...parsed.query }
      hash = parsed.hash
    } else if (to && typeof to === 'object') {
      if (to.path) {
        const parsed = parseUrlString(to.path, this.modulePath)
        if (!parsed) {
          return null
        }
        path = parsed.path
        query = { ...parsed.query, ...(to.query || {}) }
        hash = to.hash || parsed.hash
        params = to.params || {}
      } else if (to.name) {
        name = to.name
        query = to.query || {}
        params = to.params || {}
        hash = to.hash || ''
      } else {
        return null
      }
    } else {
      return null
    }
    if (path && !path.startsWith('/')) {
      path = `/${path}`
    }
    if (this.modulePath && path?.startsWith(this.modulePath)) {
      path = path.slice(this.modulePath.length) || '/'
    }
    if (path && !path.startsWith('/')) {
      path = `/${path}`
    }
    if (path !== '/' && path?.endsWith('/')) {
      path = path.slice(0, -1)
    }
    return { path, query, params, hash, name }
  }

  matchRoute(to) {
    const routeInfo = this.normalizeRouteTarget(to)
    if (!routeInfo) {
      return null
    }
    const { path, query, params, name } = routeInfo
    if (name) {
      const route = this.#routesByName.get(name)
      if (!route) {
        return null
      }
      let resolvedPath = route.path
      Object.entries(params).forEach(([key, value]) => {
        resolvedPath = resolvedPath.replace(`:${key}`, value)
      })
      const match = route.matcher.match(resolvedPath)
      if (!match) {
        return null
      }
      return {
        route,
        params: { ...match.params, ...params },
        matched: match.matched,
        path: resolvedPath,
        query,
        name,
      }
    }
    for (const route of this.#stringRoutes) {
      if (route.path === path && (route.component || route.redirect)) {
        return { route, params: { ...params }, matched: path, path, query, name: route.name }
      }
    }
    for (const route of this.#regexRoutes) {
      const match = route.matcher.match(path)
      if (match && (route.component || route.redirect)) {
        return {
          route,
          params: { ...match.params, ...params },
          matched: match.matched,
          path,
          query,
          name: route.name,
        }
      }
    }
    return null
  }

  matchTo(to) {
    const matchResult = this.matchRoute(to)
    if (!matchResult) {
      return null
    }
    const { route, params, query, path, name } = matchResult
    let search = ''
    if (query && Object.keys(query).length > 0) {
      search = `?${Object.entries(query).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')}`
    }
    const fullPath = `${path || matchResult.path}${search}`
    return {
      route,
      params,
      query,
      name: name || route.name,
      path: path || matchResult.path,
      fullPath,
      matched: [route],
    }
  }

  resolveCacheKey(route, matchedRoute) {
    const config = route.cacheKey
    if (config === false) {
      return null
    }
    if (config === undefined || config === true) {
      return matchedRoute.fullPath
    }
    if (typeof config === 'string') {
      return config
    }
    if (typeof config === 'function') {
      return config(matchedRoute)
    }
    return matchedRoute.fullPath
  }

  async #navigateTo(matchedRoute, mode = 'push') {
    if (!matchedRoute) {
      return
    }
    const { route, params, query } = matchedRoute
    if (route.redirect) {
      const redirectTarget = typeof route.redirect === 'function' ? route.redirect(matchedRoute) : route.redirect
      this.push(redirectTarget)
      return
    }
    if (this.activePage && this.current?.fullPath === matchedRoute.fullPath) {
      return
    }
    const to = {
      path: matchedRoute.path,
      fullPath: matchedRoute.fullPath,
      params,
      query,
      hash: new URL(matchedRoute.fullPath, window.location.origin).hash,
      meta: route.meta,
      description: route.description,
      layout: route.layout,
      name: route.name,
      matched: [route],
    }
    if (this.beforeEnter) {
      let shouldContinue = true
      const result = await this.beforeEnter(to, this.current, (next) => {
        if (next) {
          shouldContinue = false
          this.push(next)
        }
      })
      if (result === false || !shouldContinue) {
        return
      }
    }
    const cacheKey = this.resolveCacheKey(route, matchedRoute)
    this.activePage?.deactive()
    this.#setRouterPath(matchedRoute, mode)
    if (cacheKey && this.pageCache.has(cacheKey)) {
      const page = this.pageCache.get(cacheKey)
      const isSharedPage = page.matchedRoute.fullPath !== matchedRoute.fullPath
      if (isSharedPage) {
        page.updateRouter(matchedRoute)
      }
      page.activate()
      this.activePage = page
      if (typeof this.afterEnter === 'function') {
        this.afterEnter(to, this.current)
      }
      return
    }
    const page = new Page(this, this.renderer, this.hostNode, matchedRoute, cacheKey)
    if (cacheKey) {
      this.pageCache.set(cacheKey, page)
    }
    await page.mount(this.runtime, to.layout)
    this.activePage = page
    if (typeof this.afterEnter === 'function') {
      this.afterEnter(to, this.current)
    }
  }

  async push(to) {
    this.#nav.push(to)
  }

  replace(to) {
    this.#nav.replace(to)
  }

  go(n) {
    this.#nav.go(n)
  }

  back() {
    this.#nav.back()
  }

  forward() {
    this.#nav.forward()
  }

  resolveRoutesUrl(source = this.routesSource, runtime = this.runtime || {}) {
    const routesSource = source || '/routes.js'
    if (/^https?:\/\//.test(routesSource)) {
      return routesSource
    }
    if (routesSource.startsWith('/')) {
      return resolveScopedUrl(routesSource, getModulePath(runtime))
    }
    return resolveScopedUrl(`/${routesSource.replace(/^\.?\//, '')}`, getModulePath(runtime))
  }

  async loadRoutes() {
    const routesUrl = this.resolveRoutesUrl(this.routesSource, this.runtime || {})
    return normalizeRoutesModule(await import(routesUrl))
  }

  async handleNavigation(event) {
    const target = event?.type === 'popstate' ? event.url : event?.to
    const method = event?.type === 'replace' || event?.type === 'popstate' ? 'replace' : 'push'
    if (!target) {
      return
    }
    const matchedRoute = this.matchTo(target)
    if (!matchedRoute) {
      return
    }
    await this.#navigateTo(matchedRoute, method)
  }

  async mount(vhtml, node, runtime) {
    this.hostNode = node
    this.instance.runtime = createRuntimeEnv(runtime || null, runtime?.$mod || runtime || null, { $router: this })
    this.instance.host = node
    this.instance.router = this
    setRouter(node, this)
    this.instance.meta.routesSource = node.getAttribute('routes') || '/routes.js'
    this.renderer = vhtml
    this.resetRoutes()
    this.disposeNavListener?.()
    this.disposeNavListener = this.#nav.onChange((event) => {
      this.handleNavigation(event)
    })
    const routeModule = await this.loadRoutes()
    console.log(routeModule)
    this.beforeEnter = routeModule.beforeEnter || null
    this.afterEnter = routeModule.afterEnter || null
    this.addRoutes(routeModule.routes)
    await this.handleNavigation({ type: 'replace', to: window.location.href })
  }
}

class RouterRuntime {
  #nav = new NavigationRuntime()
  #views = new WeakMap()

  constructor() {
    this.#nav.init()
  }

  push(to) {
    this.#nav.push(to)
  }

  replace(to) {
    this.#nav.replace(to)
  }

  go(n) {
    this.#nav.go(n)
  }

  back() {
    this.#nav.back()
  }

  forward() {
    this.#nav.forward()
  }

  mountView(vhtml, node, runtime) {
    let view = this.#views.get(node)
    if (!view) {
      view = new RouterView(this.#nav)
      this.#views.set(node, view)
    }
    view.mount(vhtml, node, runtime)
    return view
  }
}

const $router = new RouterRuntime()

export default { $router }
