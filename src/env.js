/*
 * env.js — 模块上下文与环境配置
 * Copyright (C) 2024 veypi <i@veypi.com>
 *
 * 管理模块级 scoped 上下文、运行时创建、env.js 配置加载。
 * 合并原 context.js，消除 createRuntimeEnv 零价值包装。
 */

import { Wrap, Watch } from './reactive.js'
import EventBus from './vbus.js'
import axios from './axios.min.js'
import I18n from './i18n.js'
import vmessage from './vmessage.js'

// ---- 模块上下文 ----

const moduleReservedKeys = new Set([
  'scoped', 'baseURL', 'origin', '$axios', '$bus', '$i18n', '$t',
])

export function getModuleContext(source = null) {
  if (!source || typeof source !== 'object') return null
  return source.$mod || source
}

export function getModulePath(source = null) {
  const mod = getModuleContext(source)
  return mod?.scoped || ''
}

export function getBaseURL(source = null) {
  const mod = getModuleContext(source)
  return mod?.baseURL || window.location.origin
}

export function createModuleHttpClient(baseURL) {
  return axios.create({ baseURL })
}

export function createModuleContext(scoped, baseURL, sharedLocale, initial = {}) {
  const mod = {
    ...initial,
    scoped,
    baseURL,
    origin: window.location.origin,
    $bus: new EventBus(),
    $i18n: new I18n(sharedLocale),
  }
  mod.$t = (key, params = {}) => mod.$i18n.t(key, params)
  mod.fetch = (url, options) => {
    let resolvedUrl = url
    if (url.startsWith('@')) {
      resolvedUrl = url.slice(1)
    } else if (!/^https?:\/\//.test(url) && !url.startsWith('//')) {
      resolvedUrl = url.startsWith('/') ? `${scoped}${url}` : `${scoped}/${url}`
    }
    return fetch(resolvedUrl, options)
  }
  return mod
}

// ---- 系统/上下文运行时 ----

export function createSystemContext(parent = null, initial = {}) {
  const sys = Object.create(parent || null)
  if (!Object.prototype.hasOwnProperty.call(sys, '$message')) {
    sys.$message = vmessage
  }
  if (initial && typeof initial === 'object') {
    Object.assign(sys, initial)
  }
  return sys
}

export function createCtxContext(parent = null, initial = {}) {
  const seed = initial && typeof initial === 'object' ? { ...initial } : {}
  return Wrap(seed, parent || undefined)
}

export function createRuntimeContext(parent = null, mod = null, initialSys = {}, initialCtx = {}) {
  const parentSys = parent?.$sys || null
  const parentCtx = parent?.$ctx || null
  return {
    $sys: createSystemContext(parentSys, initialSys),
    $ctx: createCtxContext(parentCtx, initialCtx),
    $mod: mod || parent?.$mod || null,
  }
}

// ---- Scoped 路径工具 ----

function trimTrailingSlash(value) {
  if (!value || value === '/') return value || ''
  return value.endsWith('/') ? value.slice(0, -1) : value
}

const scopedMarkerSegments = new Set([
  'page', 'layout', 'local', 'form', 'component', 'components', 'widget', 'widgets',
])

export function normalizeScoped(scoped = '') {
  if (!scoped) return ''
  if (/^https?:\/\//.test(scoped)) {
    const url = new URL(scoped)
    const pathname = trimTrailingSlash(url.pathname)
    return `${url.origin}${pathname === '/' ? '' : pathname}`
  }
  const normalized = trimTrailingSlash(scoped)
  if (!normalized) return ''
  return normalized.startsWith('/') ? normalized : `/${normalized}`
}

export function inferScopedFromUrl(url = '') {
  if (!url) return ''
  let pathname = ''
  try {
    pathname = new URL(url, window.location.origin).pathname
  } catch (_) { return '' }
  const segments = pathname.split('/').filter(Boolean)
  if (segments.length === 0) return ''
  const markerIndex = segments.findIndex(segment => scopedMarkerSegments.has(segment))
  if (markerIndex <= 0) return ''
  return normalizeScoped(`/${segments.slice(0, markerIndex).join('/')}`)
}

export function resolveScopedUrl(path = '', scoped = '') {
  if (!path) return path
  if (path.startsWith('@')) return path.slice(1)
  if (/^https?:\/\//.test(path)) return path
  if (!path.startsWith('/')) return path
  const normalizedScoped = normalizeScoped(scoped)
  if (!normalizedScoped) return path
  if (/^https?:\/\//.test(normalizedScoped)) {
    return `${normalizedScoped}${path}`
  }
  return `${normalizedScoped}${path}`
}

export function scopedBaseURL(scoped = '') {
  const normalizedScoped = normalizeScoped(scoped)
  if (!normalizedScoped) return window.location.origin
  if (/^https?:\/\//.test(normalizedScoped)) return normalizedScoped
  return `${window.location.origin}${normalizedScoped}`
}

// ---- ModuleContextManager ----

function mergeModulePatch(mod, patch = {}) {
  if (!patch || typeof patch !== 'object') return
  Object.entries(patch).forEach(([key, value]) => {
    if (moduleReservedKeys.has(key)) return
    mod[key] = value
  })
}

export class ModuleContextManager {
  constructor() {
    this.modMap = new Map()
    this.wrappers = []
    this.sharedLocale = Wrap({
      locale: localStorage.getItem('i18n_locale') || 'zh-CN',
      fallback: 'en-US',
    })
    this.initLocaleWatcher()
  }

  initLocaleWatcher() {
    Watch(() => this.sharedLocale.locale, (locale) => {
      localStorage.setItem('i18n_locale', locale)
      document.documentElement.lang = locale
    })
  }

  addWrapper(wrapper) {
    if (typeof wrapper !== 'function') {
      console.warn('addWrapper: wrapper must be a function')
      return
    }
    this.wrappers.push(wrapper)
    for (const [scoped, mod] of this.modMap.entries()) {
      wrapper(scoped, mod)
    }
  }

  clear() {
    this.modMap.clear()
    this.wrappers = []
  }

  async getModule(scoped = '') {
    const normalizedScoped = normalizeScoped(scoped || '')
    let mod = this.modMap.get(normalizedScoped)
    if (!mod) {
      mod = await this.createModule(normalizedScoped)
      this.modMap.set(normalizedScoped, mod)
    }
    return mod
  }

  patchModule(mod, patch = {}) {
    mergeModulePatch(mod, patch)
    return mod
  }

  async createModule(scoped, patch = {}) {
    const baseURL = scopedBaseURL(scoped)
    const mod = createModuleContext(scoped, baseURL, this.sharedLocale, {
      $axios: createModuleHttpClient(baseURL),
    })
    this.patchModule(mod, patch)
    await this.loadEnvConfig(mod)
    for (const wrapper of this.wrappers) {
      wrapper(scoped, mod)
    }
    return mod
  }

  async loadEnvConfig(mod) {
    const envUrl = `${scopedBaseURL(mod.scoped)}/env.js`
    try {
      const envModule = await import(envUrl)
      if (typeof envModule.default === 'function') {
        await envModule.default(mod, this)
      }
    } catch (error) {
      console.warn(`error loading ${envUrl}: ${error}`)
    }
  }
}

const moduleContextManager = new ModuleContextManager()

export default moduleContextManager
