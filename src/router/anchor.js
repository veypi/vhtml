/*
 * router/anchor.js — <a> 链接拦截与 active 态同步
 */

import { debug as logDebug } from '../debug.js'
import { reportError } from '../errors.js'
import { stripRouterEscape, matchedRouteDebugInfo } from './util.js'

// fire-and-forget 导航收口：与 RouterView.#swallowNav 同契约——
// 页面加载/构建失败登记进 __vhtml_dev.errors，不产生 unhandled rejection
function swallowNav(promise, extra = {}) {
  Promise.resolve(promise).catch((error) => {
    reportError('navigation', error?.message || String(error), { ...extra, stack: error?.stack || '' })
  })
}

const anchorRouters = new WeakMap()

export function bindAnchorRouter(anchor, router, getTarget = null) {
  if (!anchor || !router) return () => {}
  anchorRouters.set(anchor, { router, getTarget })
  return () => {
    if (anchorRouters.get(anchor)?.router === router) anchorRouters.delete(anchor)
  }
}

export function normalizeActiveHref(href, router) {
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

export function isSameActiveHref(href, current, router) {
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
  // 空目标不参与同步：空串经 resolveHref 会解析成当前路径（new URL('', 当前地址)），
  // 导致 href 被改写为当前页 + active 恒真
  if (!target) return
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
    routerPrefix: router.prefix || '',
  })
}

export class AnchorClickRuntime {
  #loaded = false

  init() {
    if (this.#loaded) return
    const bind = () => {
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
          else swallowNav(router.replace(target), { source: 'anchor', target })
        } else {
          swallowNav(router.push(target), { source: 'anchor', target })
        }
      }, true)
    }
    // 模块可能在 <head> 中加载（document.body 尚不存在）：延迟到 DOMContentLoaded。
    // 静默跳过会让锚点拦截整个会话失效，必须挂起等待而非放弃
    if (!document.body) {
      document.addEventListener('DOMContentLoaded', bind, { once: true })
      return
    }
    bind()
  }
}
