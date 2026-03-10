import vproxy from './vproxy.js'
import vget from './vget.js'

// 解析URL字符串，提取路径、查询参数和hash
function parseUrlString(urlString, scoped) {
  let url

  let path
  // 判断是否为完整URL（包含协议）
  if (urlString.startsWith('http://') || urlString.startsWith('https://')) {
    url = new URL(urlString)
    // 如果是外部URL，返回null（不处理外部链接）
    if (url.origin !== window.location.origin) {
      return null
    }
    if (url.pathname.startsWith(scoped)) {
      path = url.pathname.slice(scoped.length) // 去掉根路径
    }
  } else {
    // 相对路径，基于当前origin构建完整URL
    url = new URL(urlString, window.location.href)
    path = url.pathname
  }

  // 解析查询参数
  const query = {}
  url.searchParams.forEach((value, key) => {
    query[key] = value
  })

  return {
    path: path,
    query,
    hash: url.hash
  }
}


class VRouter {
  #stringRoutes = [] // 字符串路径路由，优先匹配
  #regexRoutes = []  // 正则路径路由，后匹配
  #history = []
  #current = vproxy.Wrap({})
  #scoped = ''
  #listeners = []
  #pageCache = new Map()
  #node = null
  #env = null
  #originContent = []
  #loaded = false
  #vhtml = null
  #routesByName = new Map() // 添加按名称索引的路由缓存

  constructor() {
    this.init()
  }

  get routes() { return [...this.#stringRoutes, ...this.#regexRoutes] }
  get history() { return this.#history.slice() }
  get current() { return this.#current }
  get query() { return this.#current?.query || {} }
  get params() { return this.#current?.params || {} }
  get scoped() { return this.#scoped }

  onChange(fc) {
    this.#listeners.push(fc)
  }

  // 判断路径是否包含正则特殊字符
  #isRegexPath(path) {
    // 包含 :param * ? ( ) [ ] { } ^ $ + . 等视为正则路径
    return /[:*?()[\]{}^$+.]/.test(path)
  }

  addRoute(route) {
    if (!route.path) throw new Error('Route must have a path')
    if (route.path != '/' && route.path.endsWith('/')) {
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

    // 根据路径类型分到不同数组（redirect 路由不需要渲染，放哪边都可以）
    if (this.#isRegexPath(route.path)) {
      this.#regexRoutes.push(routeConfig)
    } else {
      this.#stringRoutes.push(routeConfig)
    }
    // 注意：redirect 路由会在 #navigateTo 中处理，不会走到渲染逻辑

    // 如果有名称，添加到名称索引中
    if (route.name) {
      this.#routesByName.set(route.name, routeConfig)
    }

    // 递归处理子路由
    if (route.children?.length > 0) {
      route.children.forEach(child => {
        const childPath = route.path + (child.path.startsWith('/') ? child.path : '/' + child.path)
        const layout = child.layout || route.layout || ''
        const meta = { ...route.meta, ...child.meta }
        this.addRoute({ ...child, path: childPath, parent: routeConfig, layout, meta })
      })
    }
  }

  addRoutes(routes) {
    routes.forEach(route => this.addRoute(route))
  }

  #notifyListeners(to, from) {
    this.#listeners.forEach(listener => {
      if (typeof listener === 'function') {
        try {
          listener(to, from)
        } catch (error) {
          console.error('Error in router listener:', error)
        }
      }
    })
  }

  #setRouterPath(matchedRoute) {
    const oldRoute = this.#current

    this.#current = Object.assign(this.#current, {
      path: matchedRoute.path,
      fullPath: matchedRoute.fullPath,
      params: matchedRoute.params || {},
      query: matchedRoute.query || {},
      hash: new URL(matchedRoute.fullPath, window.location.origin).hash,
      meta: matchedRoute.route?.meta || {},
      description: matchedRoute.route?.description || '',
      layout: matchedRoute.route?.layout || '',
      name: matchedRoute.route?.name,
      matched: matchedRoute.route ? [matchedRoute.route] : []
    })

    this.#history.push(this.#current)
    if (this.#scoped && !matchedRoute.fullPath.startsWith('http')) {
      history.pushState({}, '', this.#scoped + matchedRoute.fullPath)
    } else {
      history.pushState({}, '', matchedRoute.fullPath)
    }
    this.#notifyListeners(this.#current, oldRoute)
  }

  // 优化后的路由匹配方法，支持多种参数类型
  matchRoute(to) {
    // 处理不同类型的路由参数
    const routeInfo = this.normalizeRouteTarget(to)
    if (!routeInfo) return null

    const { path, query, params, name } = routeInfo

    // 如果是按名称匹配
    if (name) {
      const route = this.#routesByName.get(name)
      if (!route) return null

      // 构建带参数的路径
      let resolvedPath = route.path
      Object.entries(params).forEach(([key, value]) => {
        resolvedPath = resolvedPath.replace(`:${key}`, value)
      })

      const match = route.matcher.match(resolvedPath)
      if (match) {
        return {
          route,
          params: { ...match.params, ...params },
          matched: match.matched,
          path: resolvedPath,
          query,
          name
        }
      }
      return null
    }

    // 1. 先按字符串精确匹配（优先级高）
    for (const route of this.#stringRoutes) {
      if (route.path === path && (route.component || route.redirect)) {
        return {
          route,
          params: { ...params },
          matched: path,
          description: route.description,
          layout: route.layout,
          path,
          query,
          name: route.name
        }
      }
    }

    // 2. 再按正则匹配（优先级低）
    for (const route of this.#regexRoutes) {
      const match = route.matcher.match(path)
      if (match && (route.component || route.redirect)) {
        return {
          route,
          params: { ...match.params, ...params },
          matched: match.matched,
          description: route.description,
          layout: route.layout,
          path,
          query,
          name: route.name
        }
      }
    }
    return null
  }

  // 标准化路由目标参数
  normalizeRouteTarget(to) {
    let path, query = {}, params = {}, hash = '', name

    if (typeof to === 'string') {
      // 字符串类型：解析可能包含的URL、query、hash
      const parsed = parseUrlString(to, this.#scoped)
      if (!parsed) return null // 外部URL或解析失败

      path = parsed.path
      query = { ...parsed.query }
      hash = parsed.hash
    } else if (to && typeof to === 'object') {
      if (to.path) {
        // {path} 类型：path可能也包含query和hash
        const parsed = parseUrlString(to.path, this.#scoped)
        if (!parsed) return null

        path = parsed.path
        // 合并query参数，对象中的query优先级更高
        query = { ...parsed.query, ...(to.query || {}) }
        hash = to.hash || parsed.hash
        params = to.params || {}
      } else if (to.name) {
        // {name} 类型
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

    // 标准化路径
    if (path && !path.startsWith('/')) {
      path = '/' + path
    }
    if (this.#scoped) {
      path = path.startsWith(this.#scoped) ? path.slice(this.#scoped.length) : path
    }

    if (!path.startsWith('/')) {
      path = '/' + path
    }

    if (path != '/' && path.endsWith('/')) {
      path = path.slice(0, -1)
    }

    return { path, query, params, hash, name }
  }

  matchTo(to) {
    const matchResult = this.matchRoute(to)
    if (!matchResult) return null

    const { route, params, query, path, name } = matchResult

    // 构建查询字符串
    let search = ''
    if (query && Object.keys(query).length > 0) {
      search = '?' + Object.entries(query)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join('&')
    }

    const fullPath = (path || matchResult.path) + search

    return {
      route,
      params,
      query,
      name: name || route.name,
      path: path || matchResult.path,
      fullPath,
      matched: [route]
    }
  }

  buildUrl(baseUrl, additionalQuery = {}) {
    const url = new URL(baseUrl, window.location.origin)
    Object.entries(additionalQuery).forEach(([key, value]) => {
      url.searchParams.append(key, value)
    })
    return url
  }

  resolveRoutePath(route, params = {}) {
    let path = route.component || route.path

    Object.entries(params).forEach(([key, value]) => {
      path = path.replace(`:${key}`, value)
    })

    if (path === '/' || path === '') path = '/index'
    if (!path.startsWith('/')) path = '/' + path
    if (path.endsWith('.html')) path = path.slice(0, -5)
    if (path.endsWith('/')) path = path.slice(0, -1)

    return path
  }

  // 解析缓存键
  resolveCacheKey(route, matchedRoute) {
    const config = route.cacheKey

    // 禁用缓存
    if (config === false) {
      return null
    }

    // 默认或 true：按完整路径缓存
    if (config === undefined || config === true) {
      return matchedRoute.fullPath
    }

    // 字符串：固定 key 共享
    if (typeof config === 'string') {
      return config
    }

    // 函数：动态计算
    if (typeof config === 'function') {
      return config(matchedRoute)
    }

    return matchedRoute.fullPath
  }

  async #navigateTo(matchedRoute) {
    if (!matchedRoute) {
      console.warn(`No route matched`)
      return
    }

    const { route, params, query } = matchedRoute

    // Handle redirect
    if (route.redirect) {
      const redirectTarget = typeof route.redirect === 'function'
        ? route.redirect(matchedRoute)
        : route.redirect
      this.push(redirectTarget)
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
      matched: [route]
    }

    if (this.beforeEnter) {
      try {
        let shouldContinue = true
        const result = await this.beforeEnter(to, this.#current, (next) => {
          if (next) {
            shouldContinue = false
            this.push(next)
          }
        })
        if (result === false || !shouldContinue) return
      } catch (error) {
        console.error('Error in beforeEnter guard:', error)
        return
      }
    }

    // 计算缓存键
    const cacheKey = this.resolveCacheKey(route, matchedRoute)

    this.#setRouterPath(matchedRoute)

    // 检查是否已存在该缓存页面
    if (cacheKey && this.#pageCache.has(cacheKey)) {
      const page = this.#pageCache.get(cacheKey)
      // 判断是否是共享页面（相同的 cacheKey 但不同的 fullPath）
      const isSharedPage = page.matchedRoute.fullPath !== matchedRoute.fullPath
      if (isSharedPage) {
        // 共享页面：只更新 router 状态，让组件自治
        page.updateRouter(matchedRoute)
      } else {
        // 普通缓存页面：重新激活显示
        page.activate()
      }
      return
    }

    // 创建新页面
    const page = new Page(this.#vhtml, this.#node, matchedRoute, cacheKey)

    if (cacheKey) {
      this.#pageCache.set(cacheKey, page)
    }

    await page.mount(this.#env, this.#originContent, to.layout)

  }

  async push(to) {
    const matchedRoute = this.matchTo(to)

    if (!matchedRoute) {
      const target = typeof to === 'string' ? to : (to.path || `name: ${to.name}`)
      console.warn(`No route matched for ${target}`)
      return
    }

    await this.#navigateTo(matchedRoute)
  }

  replace(to) {
    this.push(to)
    if (this.#history.length > 1) {
      this.#history.splice(-2, 1)
    }
  }

  go(n) { history.go(n) }
  back() { history.back() }
  forward() { history.forward() }

  init() {
    if (this.#loaded) return
    this.#loaded = true

    document.body.addEventListener('click', (event) => {
      const linkElement = event.target.closest('a')
      if (!linkElement) return

      const href = linkElement.getAttribute('href')
      if (!href || href.startsWith('http') || href.startsWith('#')) return


      event.preventDefault()
      const reload = linkElement.hasAttribute('reload')
      if (reload) {
        window.location.href = href
      } else {
        this.push(href)
      }
    }, true)

    window.addEventListener('popstate', () => {
      this.push(window.location.href)
    })
  }

  ParseVrouter($vhtml, $node, env) {
    this.#node = $node
    this.#env = env
    this.#scoped = env.scoped || ''
    this.#originContent = Array.from($node.childNodes)
    this.#vhtml = $vhtml;
    (async () => {
      let routesUrl = '/routes.js'
      if (env.scoped) {
        routesUrl = env.scoped + routesUrl
      }
      try {
        let routes = (await import(routesUrl)).default
        this.addRoutes(routes)
      } catch (e) {
        console.warn(`loading ${routesUrl} failed: ` + e)
      } finally {
        this.push(window.location.href)
      }
    })();
  }
}

// 优化后的路由匹配器
class RouteMatcher {
  constructor(path, name) {
    this.originalPath = path
    this.name = name
    this.keys = []
    this.regexp = this.pathToRegexp(path)
  }

  pathToRegexp(path) {
    // 支持可选参数 :param? 和普通参数 :param
    // 先处理可选参数及其前面的 /
    // 将 /:param? 或 :param? 转换为 (?:/(?<param>[^/]+))?
    const optionalParamPattern = /\/:([^(/?]+)\?/g
    let regexpStr = path.replace(optionalParamPattern, (_, key) => {
      this.keys.push(key)
      return `(?:/(?<${key}>[^/]+))?`
    })

    // 处理普通参数（非可选）
    const paramPattern = /:([^(/?]+)/g
    regexpStr = regexpStr.replace(paramPattern, (_, key) => {
      this.keys.push(key)
      return `(?<${key}>[^/]+)`
    })

    // 处理 *path 形式的通配符
    regexpStr = regexpStr.replace(/\*(\w+)/g, (match, key) => {
      this.keys.push(key)
      return `(?<${key}>.*)`
    });

    // 如果有未处理的*号，将其替换为允许匹配任意数量字符的正则表达式
    regexpStr = regexpStr.replace(/\*/g, '.*')
    return new RegExp(`^${regexpStr}$`)
  }

  // 优化的匹配方法，支持多种参数类型
  match(target) {
    let path

    // 处理不同类型的输入
    if (typeof target === 'string') {
      path = target
    } else if (target && typeof target === 'object') {
      if (target.path) {
        path = target.path
      } else if (target.name && target.name === this.name) {
        // 如果按名称匹配且名称相符，返回基本匹配
        return {
          path: this.originalPath,
          params: target.params || {},
          matched: this.originalPath
        }
      } else {
        return null
      }
    } else {
      return null
    }

    const match = this.regexp.exec(path)
    if (!match) return null

    const params = {}
    this.keys.forEach(key => {
      if (match.groups?.[key]) {
        params[key] = match.groups[key]
      }
    })

    return {
      path: this.originalPath,
      params,
      matched: match[0]
    }
  }
}

const layoutCache = new Map()

class Page {
  constructor(vhtml, node, matchedRoute, cacheKey) {
    this.vhtml = vhtml
    this.node = node
    this.layoutDom = undefined
    this.matchedRoute = matchedRoute
    this.cacheKey = cacheKey
    this.htmlPath = this.resolveHtmlPath(matchedRoute)
    this.dom = null
  }

  // 更新 router 状态（共享页面复用时调用）
  updateRouter(matchedRoute) {
    this.matchedRoute = matchedRoute

    // 获取页面内的环境
    const pageEnv = this.dom?.$env
    if (!pageEnv) return

    // 更新 $router.current 对象（响应式，会触发 $watch）
    const router = pageEnv.$router
    if (!router) return

    Object.assign(router.current, {
      path: matchedRoute.path,
      fullPath: matchedRoute.fullPath,
      params: matchedRoute.params,
      query: matchedRoute.query,
      hash: new URL(matchedRoute.fullPath, window.location.origin).hash,
      meta: matchedRoute.route?.meta || {},
      name: matchedRoute.route?.name
    })
  }

  resolveHtmlPath(matchedRoute) {
    let path = matchedRoute.route.component || matchedRoute.route.path
    if (typeof path === 'function') {
      path = path(matchedRoute.path)
    }

    Object.entries(matchedRoute.params).forEach(([key, value]) => {
      path = path.replace(`:${key}`, value)
    })

    if (!path.startsWith('/')) path = '/' + path
    if (path.endsWith('/')) path = path.slice(0, -1)
    if (!path.endsWith('.html')) path = path + '.html'

    return path
  }

  async mount(env, originContent, layout) {

    const parser = await vget.FetchUI(this.htmlPath, env)
    if (parser.err) {
      console.warn(parser.err)
      this.dom = document.createElement('div')
      Object.assign(this.dom.style, { width: '100%', height: '100%' })
      this.dom.append(...originContent)
      this.node.innerHTML = ''
      this.node.append(this.dom)
      this.vhtml.parseRef(this.htmlPath, this.dom, {}, env, null, true)
      return
    }
    this.title = parser.title || ''


    const slots = {}
    this.dom = document.createElement("div")
    this.dom.setAttribute('vsrc', this.htmlPath)
    slots[''] = [this.dom]
    this.slots = slots

    if (!layout) {
      this.node.innerHTML = ''
      this.node.append(this.dom)
      this.vhtml.parseRef(this.htmlPath, this.dom, {}, env, null)
      return
    }

    let layoutDom = layoutCache.get(layout)
    if (!layoutDom) {
      let layoutUrl = layout
      if (!layoutUrl.startsWith('/')) {
        layoutUrl = '/' + layout
      }
      if (!layoutUrl.endsWith('.html')) {
        layoutUrl += '.html'
      }
      if (!layoutUrl.startsWith('/layout')) {
        layoutUrl = '/layout' + layoutUrl
      }
      const layoutParser = await vget.FetchUI(layoutUrl, env)
      if (layoutParser.err) {
        console.warn(`get layout ${layoutUrl} failed.`, layoutParser.err)
        this.node.innerHTML = ''
        this.node.append(this.dom)
        this.vhtml.parseRef(this.htmlPath, this.dom, {}, env, null)
        return
      }
      layoutDom = layoutParser.body.cloneNode(true)
      layoutCache.set(layout, layoutDom)
      this.dom.$ref = vproxy.Wrap({})
      layoutDom.$refSlots = vproxy.Wrap({ ...slots })
      this.node.innerHTML = ''
      this.node.append(layoutDom)
      this.layoutDom = layoutDom
      this.vhtml.parseRef('/layout/' + layout, layoutDom, {}, env, null, true)
    } else {

      this.layoutDom = layoutDom
      this.activate()
    }
  }

  activate() {
    if (this.title) {
      let title = this.title.trim()
      if (title.indexOf("{{") >= 0) {
        let target = this.layoutDom || this.dom
        let match
        let nstart = 0
        let start = -1;
        let txtItems = []
        const varRegex = /{{|}}/g;
        while ((match = varRegex.exec(title)) !== null) {
          if (match[0] === '{{') {
            start = match.index
          } else if (match[0] === '}}' && start >= 0) {
            if (nstart !== start) {
              txtItems.push(title.slice(nstart, start))
            }
            txtItems.push('')
            let valStr = title.slice(start + 2, match.index)
            let valIdx = txtItems.length
            start = -1
            nstart = match.index + 2
            vproxy.Watch(() => {
              let valVal = vproxy.Run(valStr, {}, target.$env)
              txtItems[valIdx - 1] = valVal
              if (typeof valVal === 'function') {
                txtItems[valIdx - 1] = valVal()
              } else if (typeof valVal === 'object') {
                txtItems[valIdx - 1] = JSON.stringify(valVal)
              }
              document.title = txtItems.join('')
            })
          }
        }
        txtItems.push(title.slice(nstart))
        document.title = txtItems.join('')
      } else {
        document.title = title
      }
    }
    const layoutDom = this.layoutDom

    if (layoutDom) {
      layoutDom.querySelectorAll("vslot").forEach(e => {
        if (e.closest('[vref]') === layoutDom && this.slots[e.getAttribute('name') || '']) {
          e.innerHTML = ''
        }
      })
      Object.keys(layoutDom.$refSlots).forEach(key => {
        delete layoutDom.$refSlots[key]
      })
      Object.assign(layoutDom.$refSlots, this.slots)
      if (!layoutDom.isConnected) {
        this.node.innerHTML = ''
      }
      this.node.append(layoutDom)
    } else if (this.dom) {
      // 无 layout 的页面，直接显示 this.dom
      if (!this.dom.isConnected) {
        this.node.innerHTML = ''
        this.node.append(this.dom)
      }
    }
  }
}

const $router = new VRouter()

const DefaultRoutes = [
  {
    path: '/',
    component: '/page/index.html',
    name: 'home',
  },
  {
    path: '/404',
    component: '/page/404.html',
    name: '404'
  },
  {
    path: '*',
    component: (path) => {
      if (path.endsWith('.html')) return path
      return '/page' + path + '.html'
    },
  }
]

export default { $router, DefaultRoutes }
