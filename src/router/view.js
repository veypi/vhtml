/*
 * router/view.js — RouterView：导航状态机（idle → resolving → commit）、
 * layout 外壳缓存（视图所有）、页缓存 LRU、路由表与事件源注册
 */

import { Wrap } from '../reactive.js'
import { createRuntimeContext, getModulePath, normalizeScoped, resolveScopedUrl, resolveScope, withImportBust } from '../module.js'
import { isRouterNavigableHref } from '../url.js'
import { debug as logDebug, warn as logWarn } from '../debug.js'
import { reportError } from '../errors.js'
import { createGenToken } from '../lifecycle.js'
import { normalizeFetchUrl, templateLoader } from '../loader.js'
import { instanceOf, setInstance, createInstance, disposeRuntimeSubtree } from '../component-instance.js'
import {
  isHttpUrl, hasRouterEscape, stripRouterEscape, splitRouteTarget,
  hasPathPrefix, ensureAbsolutePath, normalizePathname, normalizeRouteInputPath,
  joinRoutePath, routeDebugList, normalizeRoutePrefix, normalizeFixedParams,
  matchedRouteDebugInfo, isCatchAllRoute, routeHash,
} from './util.js'
import { getBrowserHistory, resolveRouterHistory } from './history.js'
import { RouteMatcher, parseUrlString, normalizeRoutesModule } from './matcher.js'
import { AnchorClickRuntime } from './anchor.js'
import { Page, prepareLayoutDom, normalizeLayoutUrl } from './page.js'

const routerRoutesSources = new WeakMap()
const routerPrefixSources = new WeakMap()
const routerParamsSources = new WeakMap()

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

// ---- RouterView ----

export class RouterView {
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
  // 导航状态机：token 作废在途导航（与组件 generation token 同一原语）；
  // #navInFlight 记录 resolving 中的票根，commit 同步完成不单独占态
  #navToken = createGenToken()
  #navInFlight = null
  // 在途导航的目标 fullPath（issue 前去重用，见 #navigateTo）
  #stagedFullPath = null
  // 页缓存 LRU 上限（per-RouterView：OS 多窗口每窗一个 memory vrouter，
  // 互不驱逐）；Map 插入序即最近使用序，命中时 delete+set 提升
  #pageCacheLimit = 8
  // 最近一次提交的路由快照：staging 中间态被作废/阻断时回滚到此（而非
  // 导航进入时的 current —— 那可能已是前一个在途导航写入的中间态）
  #lastCommitted = null
  // vrouter 标题（双源）：路由注册 title（字符串/函数/async 函数，函数收 params，
  // 优先）→ 页面 <title>（兜底）。系统 vrouter（affectsDocument）同步 document.title；
  // 所有 vrouter 都写宿主 DOM 对象 __title 属性（OS 窗口名等外部消费），支持订阅。
  #title = ''
  #routeTitle = ''
  #pageTitle = ''
  #titleSeq = 0
  #titleListeners = new Set()

  get title() { return this.#title }

  // 汇总生效标题并落定三处出口（DOM 属性 / document.title / 订阅者）
  #applyTitle() {
    const t = this.#routeTitle || this.#pageTitle
    if (t === this.#title) return
    this.#title = t
    if (this.instance?.host) this.instance.host.__title = t
    if (this.affectsDocument) document.title = t
    for (const fn of this.#titleListeners) fn(t)
  }

  // 路由源：导航 commit 时结算——路由节点的 nav.instances 按当前 params 匹配
  // 出实例名（实例路由的 name 由此自然带出；launcher 同一份 instances 数据）。
  // 无实例源/未命中/解析失败 → 清空路由源（落页面 <title>）；seq 作废旧导航迟到结果。
  #setRouteTitle(matchedRoute) {
    const instances = matchedRoute?.route?.nav?.instances
    const seq = ++this.#titleSeq
    const finish = (name) => {
      if (seq !== this.#titleSeq) return
      this.#routeTitle = typeof name === 'string' ? name.trim() : ''
      this.#applyTitle()
    }
    if (typeof instances !== 'function') {
      finish('')
      return
    }
    const params = matchedRoute?.params || {}
    const $mod = this.runtime?.$mod || {}
    Promise.resolve()
      .then(() => instances({ $mod, params }))
      .then((items) => {
        const hit = (items || []).find((it) => it?.params
          && Object.entries(it.params).every(([k, v]) => params[k] === v))
        finish(hit ? (hit.name || '') : '')
      })
      .catch(() => finish(''))
  }

  // 页面源：Page.updateTitle 回写（页面 <title>，含 {{}} 动态 watcher 更新）
  setPageTitle(str) {
    this.#pageTitle = String(str || '').trim()
    this.#applyTitle()
  }

  onTitleChange(fn) {
    this.#titleListeners.add(fn)
    return () => this.#titleListeners.delete(fn)
  }

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
  get prefix() { return this.#routerPrefix }
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
  get navigationState() { return this.#navInFlight === null ? 'idle' : 'resolving' }
  get beforeEnter() { return this.#beforeEnter }
  set beforeEnter(value) { this.#beforeEnter = typeof value === 'function' ? value : null }
  get afterEnter() { return this.#afterEnter }
  set afterEnter(value) { this.#afterEnter = typeof value === 'function' ? value : null }
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
      return { value: this.#routerPrefix, source: '$router.prefix', raw: this.#routerPrefix }
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

  /** 与 #snapshot 同构的目标路由快照（staging 写入与 commit 写入同一来源）。 */
  #snapshotFromMatched(matchedRoute) {
    return this.#snapshot({
      path: matchedRoute.path,
      fullPath: matchedRoute.fullPath,
      params: this.mergeParams(matchedRoute.params || {}),
      query: matchedRoute.query || {},
      hash: routeHash(matchedRoute.fullPath, this.#nav),
      meta: matchedRoute.route?.meta || {},
      layout: matchedRoute.route?.layout || '',
      matched: matchedRoute.route ? [matchedRoute.route] : [],
    })
  }

  /** staging 期写入目标快照：只动 current（响应式），不推历史/不提交 URL/不通知监听者。 */
  #stageApplyState(matchedRoute) {
    Object.assign(this.current, this.#snapshotFromMatched(matchedRoute))
  }

  /** 回滚 current 到导航前的提交快照：删除快照不存在的 key、跳过 undefined。 */
  #restoreSnapshot(snapshot) {
    const target = this.current
    const keys = new Set([...Object.keys(target), ...Object.keys(snapshot)])
    for (const key of keys) {
      if (!(key in snapshot)) {
        if (key in target) delete target[key]
      } else if (snapshot[key] !== undefined) {
        target[key] = snapshot[key]
      }
    }
  }

  #setRouterPath(matchedRoute, mode = 'push', options = {}) {
    const previousSnapshot = this.#snapshot(this.current)
    const nextSnapshot = this.#snapshotFromMatched(matchedRoute)
    this.#lastCommitted = nextSnapshot
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
      nav: route.nav || null,   // 路由节点导航元数据（name/icon/keywords/instances；instances 是 vrouter title 的实例名源）
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
    // layout 外壳为视图所有：缓存表整体重置前必须显式销毁存活条目，
    // 否则实例/watchers 随 Map 丢弃泄漏（reloadRoutes 每次热更新丢一份）
    for (const [, entry] of this.#layoutCache) {
      if (this.#isLayoutCacheAlive(entry)) disposeRuntimeSubtree(entry.dom)
    }
    this.#stringRoutes = []
    this.#regexRoutes = []
    this.#history = []
    this.#pageCache = new Map()
    this.#layoutCache = new Map()
    this.activePage = null
    this.#routeTitle = ''
    this.#pageTitle = ''
    this.#applyTitle()
  }

  /**
   * 规范化路由目标。
   * to: 路径字符串（支持 @ 前缀跳过 prefix、?query、#hash 简写）
   * data: { params, query, hash }；path 含 :key/*key 占位符时用 params 填充生成最终路径
   */
  normalizeRouteTarget(to, data = null, options = {}) {
    // 空目标不是合法导航（空串经 new URL('', 当前地址) 会解析成当前路径，
    // 曾把无 href 锚点的目标解析成当前页导致 href/active 污染）
    if (!to || typeof to !== 'string') return null
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

  // ---- layout 外壳：视图所有，按 URL 缓存 ----

  // 活性校验：disposeRuntimeSubtree 只销毁实例不移除 DOM，死壳条目必须
  // 剔除，否则后续导航会接入已销毁的外壳
  #isLayoutCacheAlive(entry) {
    if (!entry?.dom) return false
    const inst = instanceOf(entry.dom, false)
    return Boolean(inst) && inst.scope?.phase !== 'disposed'
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

  /**
   * 取或建 layout 缓存条目（resolving 阶段调用）。
   * 新建与页面内容一样在游离 staging 完成，commit 接入活动树；
   * 被作废导航新建的条目留在缓存中供后续导航复用——其 plain script
   * 在后续导航 commit 的 tryMount 树遍历时才执行（挂载钩子资格制，
   * 未接入文档前永不执行），缓存未提交的外壳无脚本副作用。
   */
  async #ensureLayoutEntry(layout, runtime) {
    if (!layout) return null
    const cached = this.#getCachedLayout(layout)
    if (cached) return cached
    const url = normalizeLayoutUrl(layout)
    const layoutParser = await templateLoader.fetchUI(url, runtime)
    if (layoutParser.err) throw new Error(`load layout failed: ${url} ${layoutParser.err}`)
    const dom = prepareLayoutDom(layoutParser.body.cloneNode(true))
    await this.#renderer.parseRef(`/layout/${layout}`, dom, {}, runtime, null, { single: true, keepOnDetach: true })
    const entry = { dom, instance: instanceOf(dom, false) }
    this.#layoutCache.set(url, entry)
    return entry
  }

  /**
   * 引用计数式回收：页面被删除/驱逐时，若活动页与全部缓存页都不再
   * 引用该外壳则销毁并出缓存（保留「删页释放外壳」的旧内存语义）。
   * 必须在 page.destroy() 之前调用（destroy 会置空 layoutEntry 引用）。
   */
  #releaseLayoutIfUnreferenced(page) {
    const entry = page?.layoutEntry
    if (!entry?.dom) return
    if (this.#currentPage && this.#currentPage !== page &&
        this.#currentPage.layoutDom === entry.dom) return
    for (const [, other] of this.#pageCache) {
      if (other !== page && other.layoutDom === entry.dom) return
    }
    disposeRuntimeSubtree(entry.dom)
    for (const [url, cached] of this.#layoutCache) {
      if (cached.dom === entry.dom) this.#layoutCache.delete(url)
    }
  }

  /**
   * 缓存页列表（供标签页/页面管理 UI）。
   * 每项: { key, title, path, fullPath, isActive, active(), del() }
   * - key: cacheKey（默认 = path 不含 query/hash）
   * - title: 一次性求值后的标题（{{}} 模板按页面 runtime 计算）
   * - fullPath: 该缓存项最近一次激活的完整路径（含 query/hash）
   * - active(): 切到该缓存页（等价 push(fullPath)，返回 promise）
   * - del(): 删除该缓存页（等价 dropPage(key)，返回 boolean）
   */
  cachedPages() {
    const list = []
    for (const [key, page] of this.#pageCache) {
      const fullPath = page.matchedRoute?.fullPath || ''
      list.push({
        key,
        title: page.evalTitle(),
        path: page.matchedRoute?.path || '',
        fullPath,
        isActive: page === this.#currentPage,
        active: () => this.push(fullPath),
        del: () => this.dropPage(key),
      })
    }
    return list
  }

  /**
   * 删除指定 cacheKey 的缓存页。
   * - 当前活动页：销毁后以 replace 重挂当前路由（等价刷新当前页，含外壳）
   * - 其余缓存页：直接销毁；外壳无引用时一并释放
   * 页面只在 commit 后才进缓存，故不存在半成品可删。
   */
  dropPage(key) {
    const page = this.#pageCache.get(key)
    if (!page) return false
    this.#pageCache.delete(key)
    const isActive = page === this.#currentPage
    if (isActive) {
      const matchedRoute = page.matchedRoute
      page.deactive()
      // 先置空：绕过 #navigateTo 的 already-active 短路，同时让外壳
      // 引用计数不命中（活动页删除 = 连外壳一起刷新重建的语义）
      this.activePage = null
      this.#releaseLayoutIfUnreferenced(page)
      page.destroy()
      if (matchedRoute) this.#swallowNav(this.#navigateTo(matchedRoute, 'replace'))
      return true
    }
    this.#releaseLayoutIfUnreferenced(page)
    page.destroy()
    return true
  }

  /** LRU 命中提升：Map 插入序即最近使用序 */
  #touchCache(key) {
    const page = this.#pageCache.get(key)
    if (!page) return
    this.#pageCache.delete(key)
    this.#pageCache.set(key, page)
  }

  /** 超限驱逐最旧的非活动页（活动页不驱逐；驱逐即销毁） */
  #trimPageCache() {
    while (this.#pageCache.size > this.#pageCacheLimit) {
      let evictKey = null
      for (const [key, page] of this.#pageCache) {
        if (page === this.#currentPage) continue
        evictKey = key
        break
      }
      if (evictKey === null) break
      const page = this.#pageCache.get(evictKey)
      this.#pageCache.delete(evictKey)
      this.#releaseLayoutIfUnreferenced(page)
      page.destroy()
    }
  }

  /**
   * fire-and-forget 导航收口：页面加载/构建失败的 rejection 在此登记吃掉——
   * 不产生 unhandled rejection，且错误进入 __vhtml_dev.errors 登记表；
   * 直接 await push()/replace() 的调用方仍会收到 rejection，可自行处理。
   */
  #swallowNav(promise) {
    Promise.resolve(promise).catch((error) => {
      reportError('navigation', error?.message || String(error), {
        ...this.#logContext(),
        stack: error?.stack || '',
      })
    })
  }

  /**
   * 导航状态机（v0.10.2）：idle → resolving → commit → idle。
   * - 新导航 issue() 即作废全部在途导航（与组件 generation token 同一原语）；
   * - resolving 的一切产物（layout/页面组件）都在游离 staging 构建，被作废
   *   的导航不产生任何可见副作用（不换页、不改地址、不跑生命周期）；
   * - commit 同步原子完成：旧页退场 → URL 提交 → 新页进场 → 缓存登记。
   */
  async #navigateTo(matchedRoute, mode = 'push', options = {}) {
    if (!matchedRoute) return
    // 去重必须在 issue() 之前：issue() 作废在途票据。staging 写入目标快照后，
    // 正在构建的页面自身 setup 的 URL 同步 watcher（首轮立即回调）会发起同目标
    // 导航——若进入 #navigateTo 领票会作废正在构建的导航，构建静默中止永不提交；
    // 直接加载该路由时 activePage 为空、无任何短路可兜底，退化成无限构建循环卡死页面。
    // 同目标导航直接吸收，不同目标照常作废在途导航（真实用户意图优先）
    if (this.#navInFlight && this.#stagedFullPath === matchedRoute.fullPath) {
      this.#debug('navigation skipped: same target as in-flight', matchedRouteDebugInfo(matchedRoute))
      return
    }
    if (this.activePage && this.current?.fullPath === matchedRoute.fullPath) {
      this.#debug('navigation skipped: already active', matchedRouteDebugInfo(matchedRoute))
      return
    }
    const ticket = this.#navToken.issue()
    this.#navInFlight = ticket
    this.#stagedFullPath = matchedRoute.fullPath
    const isCurrent = () => this.#navToken.alive(ticket)
    // current 是提交态，但 staging 构建的页面 setup/模板要在构建时读到
    // 目标路由的 params/query（v0.10.2 曾把 #setRouterPath 移到 commit，
    // 导致新页面首次构建读到的路由参数恒为空）。修法：进入 staging 前先
    // 写入目标快照（不提交 URL/历史/监听者），导航被作废/阻断/redirect 时
    // 回滚到进入前的提交快照；正常 commit 由 #setRouterPath 覆盖（同值）。
    // 回滚目标 = 最近一次 commit 的快照；尚无提交时回落当前状态（mount 初始态）
    const prevSnapshot = this.#lastCommitted || this.#snapshot(this.current)
    let staged = null
    let committed = false
    try {
      staged = await this.#stageNavigation(matchedRoute, mode, options, isCurrent)
      if (staged?.committed === true) {
        // query-only 快速路径已在 #stageNavigation 内完成提交，无 commit
        committed = true
      } else if (staged) {
        this.#commitNavigation(staged, matchedRoute, mode, options)
        committed = true
      }
    } finally {
      if (this.#navInFlight === ticket) {
        this.#navInFlight = null
        this.#stagedFullPath = null
        // 未提交的终止（作废/阻断/redirect）：回滚 staging 写入的中间态
        if (!committed) this.#restoreSnapshot(prevSnapshot)
      }
    }
  }

  /** resolving 阶段：路由守卫与页面构建。返回 { page, fromCache, to, cacheKey } 或 null。 */
  async #stageNavigation(matchedRoute, mode, options, isCurrent) {
    const { route, params, query } = matchedRoute
    const mergedParams = this.mergeParams(params || {})
    if (route.redirect) {
      const redirectTarget = typeof route.redirect === 'function' ? route.redirect(matchedRoute) : route.redirect
      this.#debug('route redirect', {
        from: matchedRouteDebugInfo(matchedRoute),
        redirectTarget,
      })
      const { path: redirectPath, data: redirectData } = splitRouteTarget(redirectTarget)
      this.#swallowNav(this.push(redirectPath, redirectData, options))
      return null
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
          this.#swallowNav(this.push(nextPath, nextData, options))
        }
      })
      if (!isCurrent()) return null
      if (result === false || !shouldContinue) {
        this.#debug('beforeEnter blocked navigation', {
          target: matchedRouteDebugInfo(matchedRoute),
          result,
          shouldContinue,
        })
        return null
      }
    }
    const cacheKey = this.resolveCacheKey(route, matchedRoute)

    // staging 期写入目标路由状态（见 #navigateTo 注释）：页面/外壳构建时
    // 读到目标 params/query；URL/历史/监听者留到 commit。
    this.#stageApplyState(matchedRoute)

    // —— query/hash-only 快速路径 ——
    // cacheKey 相同、path 相同、layout 相同且页面已激活：仅 query/hash 变化，
    // 页面与 layout 均已就绪，只需同步 URL 与路由状态（current 是响应式 Wrap，
    // 组件经 $router.current.query 自动感知），跳过 deactive/activate/commit，
    // 避免生命周期抖动（定时器/订阅被短暂停掉再恢复）及与首次导航的竞态。
    const currentPage = this.activePage
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
      this.#touchCache(cacheKey)
      if (typeof this.#afterEnter === 'function') this.#afterEnter(to, this.current)
      return { committed: true }
    }

    // —— 缓存命中：直接作为 staged 产物（页面已完整 commit 过） ——
    if (cacheKey && this.#pageCache.has(cacheKey)) {
      const page = this.#pageCache.get(cacheKey)
      this.#touchCache(cacheKey)
      return { page, fromCache: true, to, cacheKey }
    }

    // —— 缓存未命中：确保外壳就绪后游离构建新页面 ——
    const page = new Page(this, this.#renderer, this.#hostNode, matchedRoute, cacheKey)
    this.#debug('build page', {
      matched: matchedRouteDebugInfo(matchedRoute),
      component: typeof route.component === 'function' ? '[function]' : route.component,
      htmlPath: page.htmlPath,
      fetchUrl: normalizeFetchUrl(page.htmlPath, this.modulePath),
      cacheKey,
      modulePath: this.modulePath,
    })
    let buildResult
    let layoutEntry = null
    try {
      layoutEntry = await this.#ensureLayoutEntry(to.layout, this.runtime)
      if (!isCurrent()) { page.destroy(); return null }
      buildResult = await page.build(this.runtime, layoutEntry)
    } catch (error) {
      this.#warn('mount page failed', {
        matched: matchedRouteDebugInfo(matchedRoute),
        htmlPath: page.htmlPath,
        fetchUrl: normalizeFetchUrl(page.htmlPath, this.modulePath),
        modulePath: this.modulePath,
        error,
      })
      if (!this.#currentPage) {
        // 首 mount（无在显页面）：降级为错误盒页照常 commit——初始 deep link
        // 组件 404 不再抛穿杀整个应用（白屏 = 视觉静默空白）；错误暴露走
        // 红盒 + warn + errors 登记表。在应用内导航失败仍走下方抛穿：
        // #swallowNav 登记吃掉、当前页保持不变。
        if (!isCurrent()) { page.destroy(); return null }
        reportError('navigation', error?.message || String(error), {
          ...this.#logContext(),
          stack: error?.stack || '',
        })
        page.buildError(layoutEntry)
        return { page, fromCache: false, to, cacheKey: null }
      }
      page.destroy()
      throw error
    }
    if (!isCurrent()) { page.destroy(); return null }
    if (buildResult?.redirect) {
      page.destroy()
      const { path: redirectPath, data: redirectData } = splitRouteTarget(buildResult.redirect)
      this.#swallowNav(this.replace(redirectPath, redirectData, options))
      return null
    }
    return { page, fromCache: false, to, cacheKey }
  }

  /** commit 阶段：同步原子切换。 */
  #commitNavigation({ page, fromCache, to, cacheKey }, matchedRoute, mode, options) {
    const oldPage = this.#currentPage
    // 同外壳导航只退场内容，layout 保持在树上（省去拆装与生命周期抖动）
    const sharesLayout = !!(oldPage && oldPage !== page &&
      page.layoutDom && oldPage.layoutDom === page.layoutDom)
    oldPage?.deactive({ skipLayout: sharesLayout })
    this.#setRouterPath(matchedRoute, mode, options)
    if (fromCache && page.matchedRoute.fullPath !== matchedRoute.fullPath) {
      page.updateRouter(matchedRoute)
    }
    if (cacheKey && !fromCache) this.#pageCache.set(cacheKey, page)
    page.activate()
    this.#setRouteTitle(matchedRoute)   // 路由注册名优先于页面 <title>（page.activate 已回写页面源）
    this.#trimPageCache()
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
      const rawRoutesModule = isInlineRoutes ? await source : await import(withImportBust(routesUrl))
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
      this.#swallowNav(this.handleNavigation(event))
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
    this.#lastCommitted = this.#snapshot(this.current)
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
      this.#swallowNav(this.handleNavigation(event))
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

export class RouterRuntime {
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
