/*
 * router/page.js — 页面与 layout 外壳（游离构建 / commit 接入 / 软断开 / 幂等销毁）
 */

import { Watch, Cancel } from '../reactive.js'
import { Run } from '../sandbox.js'
import { templateLoader } from '../loader.js'
import { getModulePath } from '../module.js'
import {
  instanceOf,
  createInstance,
  detachInstance,
  attachChildInstance,
  disposeRuntimeSubtree,
} from '../component-instance.js'
import { routeHash } from './util.js'

// ---- 缓存页「停车场」：DOM 不拆下，content-visibility:hidden 保留渲染缓存 ----
// 不支持 content-visibility 的浏览器回退 display:none（原行为）。
const cvHiddenSupported =
  typeof CSS !== 'undefined' &&
  typeof CSS.supports === 'function' &&
  CSS.supports('content-visibility', 'hidden')

function parkStyle(el) {
  if (!el) return
  el.setAttribute('inert', '')
  el.setAttribute('aria-hidden', 'true')
  if (cvHiddenSupported) {
    el.style.contentVisibility = 'hidden'
    el.style.position = 'absolute'
    el.style.pointerEvents = 'none'
    // content-visibility:hidden 只跳过子树内容，元素自身的背景/边框仍绘制；
    // 停放页又是 absolute，绘制顺序压过 static 的活动页 → 不透明背景直接盖住
    // 活动页（整窗白屏，仅活动页里自身定位的元素漏出）。visibility:hidden 把
    // 元素自身也一并隐藏，同时保留布局与渲染缓存。
    el.style.visibility = 'hidden'
  } else {
    el.style.display = 'none'
  }
}

function unparkStyle(el) {
  if (!el) return
  el.removeAttribute('inert')
  el.removeAttribute('aria-hidden')
  el.style.contentVisibility = ''
  el.style.position = ''
  el.style.pointerEvents = ''
  el.style.visibility = ''
  el.style.display = ''
}

// 已连接的移动优先 moveBefore：保留焦点/iframe/media 状态；未连接走 append。
function moveAppend(parent, child) {
  if (!child) return
  if (child.isConnected && typeof parent.moveBefore === 'function') {
    parent.moveBefore(child, null)
  } else {
    parent.append(child)
  }
}

export function prepareLayoutDom(layoutRoot) {
  if (!layoutRoot) return null
  const outlet =
    layoutRoot.querySelector('vslot:not([name])') ||
    layoutRoot.querySelector('vslot')
  if (!outlet) return layoutRoot
  outlet.setAttribute('data-vrouter-outlet', '')
  outlet.setAttribute('data-vrouter-managed', '')
  return layoutRoot
}

export function normalizeLayoutUrl(layout) {
  if (!layout) return ''
  let url = layout
  if (!url.startsWith('/')) url = `/${url}`
  if (!url.endsWith('.html')) url += '.html'
  if (!url.startsWith('/layout')) url = `/layout${url}`
  return url
}

// ---- 生命周期辅助 ----

/** 树遍历（实例树，visited 防环）。 */
function walkInstanceTree(root, fn) {
  const rootInstance = instanceOf(root)
  if (!rootInstance) return
  const visited = new Set()
  const walk = (instance) => {
    if (!instance || visited.has(instance)) return
    visited.add(instance)
    fn(instance)
    instance.children.forEach((child) => walk(child))
  }
  walk(rootInstance)
}

/** 路由分支当前性树维护：commit 换页时旧页 false / 新页 true，激活资格重算。 */
export function setRouteCurrentTree(root, current, reason) {
  walkInstanceTree(root, (instance) => {
    instance.scope?.setRouteCurrent(current, reason)
  })
}

/** commit 接入后的确定性挂载 flush：树上仍处于 building 的 scope 依次 tryMount。 */
function tryMountTree(root) {
  walkInstanceTree(root, (instance) => {
    instance.scope?.tryMount()
  })
}

export function resolveRouteHtmlPath(ownerView, matchedRoute) {
  const params =
    ownerView?.mergeParams?.(matchedRoute.params) || matchedRoute.params || {}
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

// ---- Page ----

export class Page {
  constructor(ownerView, renderer, node, matchedRoute, cacheKey) {
    this.ownerView = ownerView
    this.renderer = renderer
    this.node = node
    this.instance = createInstance(node, ownerView.instance, 'page')
    this.instance.route = matchedRoute
    this.instance.cacheKey = cacheKey
    // layout 外壳为 RouterView 所有（按 URL 缓存），页面仅持有引用；
    // 生命周期（创建/回收）全部由视图侧 #ensureLayoutEntry/#releaseLayoutIfUnreferenced 收口
    this.layoutEntry = null
    this._destroyed = false
    this._meta = {
      htmlPath: this.resolveHtmlPath(matchedRoute),
      title: '',
      titleWatchers: [],
      didInitialActivation: false,
      layoutOutlet: null,
    }
  }

  get meta() {
    return this._meta
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
    return this._meta.htmlPath
  }
  get dom() {
    return this.instance.host
  }
  set dom(value) {
    this.instance.host = value || null
  }
  get layoutDom() {
    return this.layoutEntry?.dom || null
  }
  get layoutInstance() {
    return this.layoutEntry?.instance || null
  }

  resolveHtmlPath(matchedRoute) {
    return resolveRouteHtmlPath(this.ownerView, matchedRoute)
  }

  resolveErrorRedirect(error) {
    const config = this.matchedRoute.route?.error_redirect
    if (!config) return null
    if (typeof config === 'function') return config(this.matchedRoute, error)
    return config
  }

  updateRouter(matchedRoute) {
    this.matchedRoute = matchedRoute
    const state = this.ownerView.snapshotRoute(matchedRoute)
    if (this.instance.runtime?.routeState)
      Object.assign(this.instance.runtime.routeState, state)
    if (this.layoutEntry?.runtime.routeState)
      Object.assign(this.layoutEntry.runtime.routeState, state)
  }

  roots() {
    if (this.layoutInstance?.host) return [this.layoutInstance.host]
    return this.instance.host ? [this.instance.host] : []
  }

  runtime() {
    return (
      instanceOf(this.dom)?.runtime ||
      instanceOf(this.layoutDom)?.runtime ||
      null
    )
  }

  // title 插值的求值作用域：组件模板里能用 $t，但 title 作用域只有模块服务（runtime），
  // 于是 {{$t('...')}} 报 Unknown identifier "$t"（全站页面 title 都这么写）。
  // 注意时机：activate() 第一步就是 updateTitle()，此时页面实例的 runtime 还没就绪
  // （this.runtime() → null）→ 只能回退到视图级 runtime（ownerView.runtime）拿 $mod。
  // 这里补一个 $t → $mod.$t 的薄封装，其余作用域语义不变。
  titleScope() {
    const rt = this.runtime() || this.ownerView?.runtime || {}
    if (rt.$t) return rt
    const mod = rt.$mod
    if (!mod || typeof mod.$t !== 'function') return rt
    return {...rt, $t: (key, params) => mod.$t(key, params)}
  }

  outlet() {
    if (!this.layoutDom) return this.node
    this._meta.layoutOutlet =
      this._meta.layoutOutlet ||
      this.layoutDom.querySelector('[data-vrouter-outlet]') ||
      this.layoutDom
    return this._meta.layoutOutlet
  }

  /**
   * commit 阶段：把游离构建产物接入活动树。
   * 纯树操作（layout 未连接则接入宿主、内容进 outlet、实例链重建）——
   * 游离 staging 架构下不存在「内容反包 outlet / layout 缺失」等离败形态，
   * 无需防御分支。
   */
  attach() {
    if (this.layoutDom) {
      if (this.layoutDom.parentNode !== this.node) {
        moveAppend(this.node, this.layoutDom)
      }
      unparkStyle(this.layoutDom)
      const outlet = this.outlet()
      if (this.dom && this.dom.parentNode !== outlet) {
        moveAppend(outlet, this.dom)
      }
      unparkStyle(this.dom)
      this.instance.host = this.dom
      const layoutInst = this.layoutInstance
      if (layoutInst) attachChildInstance(instanceOf(this.node), layoutInst)
      const contentInst = instanceOf(this.dom, false)
      if (layoutInst && contentInst)
        attachChildInstance(layoutInst, contentInst)
    } else {
      if (this.dom && this.dom.parentNode !== this.node) {
        moveAppend(this.node, this.dom)
      }
      unparkStyle(this.dom)
      this.instance.host = this.dom
      const contentInst = instanceOf(this.dom, false)
      if (contentInst) attachChildInstance(instanceOf(this.node), contentInst)
    }
    // 挂载 flush（v0.11）：接入活动树后树遍历 tryMount——游离 staging 期
    // 积累的 building 态 scope 在此确定性迁移（plain script + active 判定），
    // 已 mounted 的（缓存页重入）幂等空转
    tryMountTree(this.node)
  }

  /**
   * resolving 阶段：解析页面组件到游离 DOM。
   * 不触碰活动树——被作废的导航直接丢弃 build 产物即可，不会污染当前
   * 显示；plain script / active 等挂载钩子由 commit 接入后的 tryMount
   * 树遍历补迁移（接入前脚本零执行，作废零脚本副作用）。
   * 返回 { redirect }（error_redirect 命中）或 { built: true }。
   */
  async build(runtime, layoutEntry = null) {
    let parser
    try {
      parser = await templateLoader.fetchUI(this.htmlPath, runtime)
    } catch (error) {
      const redirect = this.resolveErrorRedirect(error)
      if (redirect) return { redirect }
      throw new Error(`load page failed: ${this.htmlPath}: ${error.message}`, {
        cause: error,
      })
    }
    this._meta.title = parser.title || ''
    this.dom = document.createElement('div')
    this.dom.setAttribute('vsrc', this.htmlPath)
    this.layoutEntry = layoutEntry
    const layoutRuntime = layoutEntry
      ? instanceOf(layoutEntry.dom)?.runtime || runtime || null
      : runtime
    const pageRuntime = this.ownerView.createPageRuntime(
      layoutRuntime,
      this.matchedRoute
    )
    this.instance.runtime = pageRuntime
    await this.renderer.parseRef(this.htmlPath, this.dom, {}, pageRuntime, {
      target: parser,
      keepOnDetach: true,
    })
    return { built: true }
  }

  /**
   * 首 mount 失败的降级页（view 侧仅在无在显页面时调用）：不抛穿——错误页
   * 照常 commit，布局外壳照常挂载。初始 deep link 组件 404 若抛穿杀整个
   * 应用 = 白屏，即视觉静默空白，违反错误暴露契约；错误仍三处可见：可见
   * 错误页、console warn、errors 登记表。
   *
   * 错误页是整屏浮层（不依赖布局外壳的样式——外壳挂载失败时它就是唯一
   * 可见物），并给出两个出口：「重试」（原地重挂当前路由）与「重新加载
   * 页面」（整页刷新）。
   * options: { stage: 'page' | 'layout', layout: 布局名 }
   */
  buildError(layoutEntry = null, error = null, options = {}) {
    this.dom = document.createElement('div')
    this.dom.setAttribute('vsrc', this.htmlPath)
    const stage = options.stage === 'layout' ? 'layout' : 'page'
    const message = error?.message || String(error || '')
    const overlay = document.createElement('div')
    overlay.setAttribute('role', 'alert')
    overlay.style.cssText =
      'position:fixed;inset:0;z-index:2147483647;display:flex;' +
      'align-items:center;justify-content:center;padding:24px;' +
      'background:rgba(15,23,42,0.97);overflow:auto;'
    const panel = document.createElement('div')
    panel.style.cssText =
      'box-sizing:border-box;max-width:680px;width:100%;padding:24px;' +
      'border-radius:12px;background:#fff;color:#0f172a;'
    const title = document.createElement('div')
    title.style.cssText = 'font-size:16px;font-weight:600;color:#b91c1c;'
    title.textContent = stage === 'layout' ? '布局加载失败' : '页面加载失败'
    const path = document.createElement('div')
    path.style.cssText =
      'margin-top:6px;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;' +
      'color:#64748b;word-break:break-all;'
    path.textContent =
      stage === 'layout' && options.layout
        ? `${options.layout} ← ${this.htmlPath}`
        : this.htmlPath
    const detail = document.createElement('pre')
    detail.style.cssText =
      'margin:16px 0 0;padding:12px;border-radius:8px;background:#fef2f2;' +
      'border:1px solid #fecaca;color:#991b1b;white-space:pre-wrap;' +
      'word-break:break-word;max-height:40vh;overflow:auto;' +
      'font:12px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;'
    detail.textContent = message || 'unknown error'
    const actions = document.createElement('div')
    actions.style.cssText =
      'display:flex;gap:10px;align-items:center;margin-top:20px;'
    const buttonStyle =
      'font:13px/1 inherit;padding:9px 16px;border-radius:8px;' +
      'border:1px solid #cbd5e1;background:#f8fafc;color:#0f172a;cursor:pointer;'
    const reloadPage = () => {
      const loc = globalThis.location
      if (loc && typeof loc.reload === 'function') loc.reload()
    }
    const retry = document.createElement('button')
    retry.type = 'button'
    retry.textContent = '重试'
    retry.style.cssText =
      buttonStyle + 'background:#0f172a;color:#fff;border-color:#0f172a;'
    const reload = document.createElement('button')
    reload.type = 'button'
    reload.textContent = '重新加载页面'
    reload.style.cssText = buttonStyle
    const restore = () => {
      retry.disabled = false
      reload.disabled = false
    }
    retry.addEventListener('click', () => {
      retry.disabled = true
      reload.disabled = true
      Promise.resolve(this.ownerView?.retryMount?.())
        .then((ok) => {
          if (!ok) {
            reloadPage()
            return
          }
          // 重挂成功则错误页已被销毁；仍挂在树上说明没重挂成，恢复按钮。
          if (this.dom?.isConnected) restore()
        })
        .catch(() => reloadPage())
    })
    reload.addEventListener('click', () => reloadPage())
    actions.append(retry, reload)
    panel.append(title, path, detail, actions)
    overlay.appendChild(panel)
    this.dom.appendChild(overlay)
    this._meta.title = 'Load Error'
    this.layoutEntry = layoutEntry
    return { built: true }
  }

  // 页面 <title> 回写 ownerView（setPageTitle）：view 按路由注册名优先结算，
  // 并由 view 决定出口（虚拟 vrouter 只落宿主 __title；系统 vrouter 同步 document.title）。
  updateTitle() {
    this.clearTitleWatchers()
    const view = this.ownerView
    if (!this._meta.title) {
      view?.setPageTitle('')
      return
    }
    const title = this._meta.title.trim()
    if (!title.includes('{{')) {
      view?.setPageTitle(title)
      return
    }
    const target = this.dom || this.layoutDom
    if (!target) return
    const titleRuntime = this.titleScope() || {}
    const varRegex = /{{|}}/g
    let match,
      nextStart = 0,
      start = -1
    const parts = []
    while ((match = varRegex.exec(title)) !== null) {
      if (match[0] === '{{') {
        start = match.index
      } else if (start >= 0) {
        if (nextStart !== start) parts.push(title.slice(nextStart, start))
        parts.push('')
        const expr = title.slice(start + 2, match.index)
        const partIndex = parts.length - 1
        nextStart = match.index + 2
        start = -1
        const watchId = Watch(() => {
          let value = Run(
            expr,
            instanceOf(target)?.data || {},
            titleRuntime || {}
          )
          if (typeof value === 'function') value = value()
          else if (typeof value === 'object' && value)
            value = JSON.stringify(value)
          parts[partIndex] = value
          view?.setPageTitle(parts.join(''))
        })
        this._meta.titleWatchers.push(watchId)
      }
    }
    parts.push(title.slice(nextStart))
    view?.setPageTitle(parts.join(''))
  }

  clearTitleWatchers() {
    while (this._meta.titleWatchers.length > 0)
      Cancel(this._meta.titleWatchers.pop())
  }

  // 一次性求值标题（不建 watcher，供缓存页列表等非激活场景读取）。
  // 拆分规则与 updateTitle 一致；表达式求值失败兜底为空串。
  evalTitle() {
    const title = (this._meta.title || '').trim()
    if (!title) return ''
    if (!title.includes('{{')) return title
    const titleRuntime = this.titleScope() || {}
    const varRegex = /{{|}}/g
    let match,
      nextStart = 0,
      start = -1
    const parts = []
    while ((match = varRegex.exec(title)) !== null) {
      if (match[0] === '{{') {
        start = match.index
      } else if (start >= 0) {
        if (nextStart !== start) parts.push(title.slice(nextStart, start))
        const expr = title.slice(start + 2, match.index)
        let value
        try {
          value = Run(
            expr,
            instanceOf(this.dom || this.layoutDom)?.data || {},
            titleRuntime
          )
        } catch {
          value = ''
        }
        if (typeof value === 'function') {
          try {
            value = value()
          } catch {
            value = ''
          }
        } else if (typeof value === 'object' && value) {
          value = JSON.stringify(value)
        }
        parts.push(value ?? '')
        nextStart = match.index + 2
        start = -1
      }
    }
    parts.push(title.slice(nextStart))
    return parts.join('')
  }

  activate() {
    this.updateTitle() // 所有 vrouter 都结算标题（出口由 view 按 affectsDocument 决定）
    this.attach()
    if (!this._meta.didInitialActivation) {
      // 首次激活：attach 的 tryMount 树遍历已完成 mounted 迁移与激活判定
      //（reason='mount'），不再补发 route 激活
      this._meta.didInitialActivation = true
      return
    }
    this.roots().forEach((root) => setRouteCurrentTree(root, true, 'route'))
  }

  deactive(opts = {}) {
    this.clearTitleWatchers()
    if (!this._meta.didInitialActivation) return
    const skipLayout = opts?.skipLayout ?? false
    if (skipLayout && this.layoutDom && this.dom) {
      setRouteCurrentTree(this.dom, false, 'route')
      // 只断开与父实例的连接（保留子树），不能用 detachInstance 因为
      // detachInstance 会清空 children 破坏子树，导致 reactivate 时遍历失败
      const inst = instanceOf(this.dom, false)
      if (inst?.parent) {
        inst.parent.children.delete(inst)
        inst.parent = null
      }
      this.parkDom(false)
      return
    }
    this.roots().forEach((root) => {
      setRouteCurrentTree(root, false, 'route')
      // 同上：软断开，保留子树
      const inst = instanceOf(root, false)
      if (inst?.parent) {
        inst.parent.children.delete(inst)
        inst.parent = null
      }
    })
    this.parkDom(true)
  }

  /**
   * 缓存页就地停车：内容留在原父节点（同 layout 时仍在 outlet），仅翻转样式。
   * 不做 connected move：既保留渲染缓存，也避免搬运 content-visibility:hidden 子树。
   */
  parkDom(includeLayout) {
    if (this.dom) parkStyle(this.dom)
    if (includeLayout && this.layoutDom) parkStyle(this.layoutDom)
  }

  /** 销毁：释放内容实例与 meta，幂等。layout 外壳为视图所有，不在此处置。 */
  destroy() {
    if (this._destroyed) return
    this._destroyed = true
    this.clearTitleWatchers()
    if (this.dom) disposeRuntimeSubtree(this.dom)
    // 未进入 build 的 staged 页 this.dom 仍是视图宿主本身，不能 remove，
    // 否则一次被作废的导航会把整个 vrouter 从文档里删掉。
    if (this.dom && this.dom !== this.node) this.dom.remove()
    detachInstance(this.instance)
    this.layoutEntry = null
  }
}
