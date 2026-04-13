import vproxy from '../vproxy.js'
import { createModuleContext, createModuleHttpClient, createRuntimeContext } from './context.js'

const moduleReservedKeys = new Set([
  'scoped',
  'baseURL',
  'origin',
  '$axios',
  '$bus',
  '$i18n',
  '$t',
])

function trimTrailingSlash(value) {
  if (!value || value === '/') {
    return value || ''
  }
  return value.endsWith('/') ? value.slice(0, -1) : value
}

const scopedMarkerSegments = new Set([
  'page',
  'layout',
  'local',
  'form',
  'component',
  'components',
  'widget',
  'widgets',
])

export function normalizeScoped(scoped = '') {
  if (!scoped) {
    return ''
  }
  if (/^https?:\/\//.test(scoped)) {
    const url = new URL(scoped)
    const pathname = trimTrailingSlash(url.pathname)
    return `${url.origin}${pathname === '/' ? '' : pathname}`
  }
  const normalized = trimTrailingSlash(scoped)
  if (!normalized) {
    return ''
  }
  return normalized.startsWith('/') ? normalized : `/${normalized}`
}

export function inferScopedFromUrl(url = '') {
  if (!url) {
    return ''
  }
  let pathname = ''
  try {
    pathname = new URL(url, window.location.origin).pathname
  } catch (_) {
    return ''
  }
  const segments = pathname.split('/').filter(Boolean)
  if (segments.length === 0) {
    return ''
  }
  const markerIndex = segments.findIndex((segment) => scopedMarkerSegments.has(segment))
  if (markerIndex <= 0) {
    return ''
  }
  return normalizeScoped(`/${segments.slice(0, markerIndex).join('/')}`)
}

export function resolveScopedUrl(path = '', scoped = '') {
  if (!path) {
    return path
  }
  if (path.startsWith('@')) {
    return path.slice(1)
  }
  if (/^https?:\/\//.test(path)) {
    return path
  }
  if (!path.startsWith('/')) {
    return path
  }
  const normalizedScoped = normalizeScoped(scoped)
  if (!normalizedScoped) {
    return path
  }
  if (/^https?:\/\//.test(normalizedScoped)) {
    return `${normalizedScoped}${path}`
  }
  return `${normalizedScoped}${path}`
}

export function scopedBaseURL(scoped = '') {
  const normalizedScoped = normalizeScoped(scoped)
  if (!normalizedScoped) {
    return window.location.origin
  }
  if (/^https?:\/\//.test(normalizedScoped)) {
    return normalizedScoped
  }
  return `${window.location.origin}${normalizedScoped}`
}

function mergeModulePatch(mod, patch = {}) {
  if (!patch || typeof patch !== 'object') {
    return
  }
  Object.entries(patch).forEach(([key, value]) => {
    if (moduleReservedKeys.has(key)) {
      return
    }
    mod[key] = value
  })
}

export class ModuleContextManager {
  constructor() {
    this.modMap = new Map()
    this.wrappers = []
    this.sharedLocale = vproxy.Wrap({
      locale: localStorage.getItem('i18n_locale') || 'zh-CN',
      fallback: 'en-US',
    })
    this.initLocaleWatcher()
  }

  initLocaleWatcher() {
    vproxy.Watch(() => this.sharedLocale.locale, (locale) => {
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

export function createRuntimeEnv(parentRuntime = null, mod = null, initialSys = {}, initialCtx = {}) {
  return createRuntimeContext(parentRuntime, mod, initialSys, initialCtx)
}

const moduleContextManager = new ModuleContextManager()

export default moduleContextManager
