import vproxy from '../vproxy.js'
import { applyScopedAliases, createEnvContext, createScopedContext } from './context.js'

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

export class ModuleEnvManager {
  constructor() {
    this.envMap = new Map()
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
    for (const [scoped, env] of this.envMap.entries()) {
      wrapper(scoped, env)
    }
  }

  clear() {
    this.envMap.clear()
    this.wrappers = []
  }

  async getEnv(scoped = '', temp = {}) {
    const normalizedScoped = normalizeScoped(scoped || temp.scoped || '')
    let env = this.envMap.get(normalizedScoped)
    if (!env) {
      env = await this.createEnv(normalizedScoped, temp)
      this.envMap.set(normalizedScoped, env)
      return env
    }
    Object.assign(env, temp)
    env.scoped = normalizedScoped
    env.$module.scoped = normalizedScoped
    env.$module.baseURL = scopedBaseURL(normalizedScoped)
    return env
  }

  async createEnv(scoped, temp = {}) {
    const baseURL = scopedBaseURL(scoped)
    const scopedContext = createScopedContext(scoped, baseURL, this.sharedLocale, temp)
    await this.loadEnvConfig(scopedContext)
    for (const wrapper of this.wrappers) {
      wrapper(scoped, scopedContext)
    }
    return scopedContext
  }

  async loadEnvConfig(env) {
    const envUrl = `${scopedBaseURL(env.scoped)}/env.js`
    try {
      const envModule = await import(envUrl)
      if (typeof envModule.default === 'function') {
        await envModule.default(env, this)
      }
    } catch (error) {
      console.warn(`error loading ${envUrl}: ${error}`)
    }
  }
}

export function createRuntimeEnv(parentEnv = null, scopedContext = null, initial = {}) {
  const env = createEnvContext(parentEnv, initial)
  applyScopedAliases(env, scopedContext)
  Object.assign(env, initial)
  return env
}

const moduleEnvManager = new ModuleEnvManager()

export default moduleEnvManager
