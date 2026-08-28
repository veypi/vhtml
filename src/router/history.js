/*
 * router/history.js — history 适配层：memory 实现、browser 单例、注册表
 */

import { Wrap } from '../reactive.js'
import { isHttpUrl, hasRouterEscape, stripRouterEscape, normalizeHistoryHref, pathFromHref } from './util.js'

const routerHistories = new Map()
let browserHistory = null

export function notifyHistoryListeners(listeners, payload) {
  Array.from(listeners).forEach(listener => listener(payload))
}

export function assignLocation(locationState, href, baseHref = window.location.href) {
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

export function assertRouterHistory(history, name = 'history') {
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

export function getBrowserHistory() {
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

export function prefixInitial(initial, routerPrefix) {
  if (hasRouterEscape(initial)) return stripRouterEscape(initial)
  if (!initial && routerPrefix) return routerPrefix
  if (!routerPrefix || !initial || isHttpUrl(initial)) return initial
  if (!initial.startsWith('/')) initial = `/${initial}`
  if (initial === routerPrefix || initial.startsWith(`${routerPrefix}/`)) return initial
  return `${routerPrefix}${initial}`
}

export function resolveRouterHistory(node, routerPrefix = '') {
  const name = (node.getAttribute('history') || 'browser').trim() || 'browser'
  if (name === 'browser' || name === 'window') return getBrowserHistory()
  const initial = node.hasAttribute('initial') ? node.getAttribute('initial') : routerPrefix || '/'
  if (name === 'memory') return createMemoryHistory(prefixInitial(initial, routerPrefix))
  const history = routerHistories.get(name)
  if (history) return history
  console.warn(`[vhtml] vrouter history "${name}" 未注册，已创建独立 memory history`)
  return createMemoryHistory(prefixInitial(initial, routerPrefix))
}
