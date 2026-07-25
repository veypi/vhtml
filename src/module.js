/*
 * module.js — 模块上下文与环境配置
 * Copyright (C) 2024 veypi <i@veypi.com>
 *
 * 管理模块级 scoped 上下文、运行时创建、env.js 配置加载。
 * 合并原 context.js，消除 createRuntimeEnv 零价值包装。
 */

import { Wrap, Watch, EnsureWrap } from './reactive.js'
import EventBus from './vbus.js'
import I18n from './i18n.js'
import vmessage from './vmessage.js'

// ---- 模块上下文 ----

export function getModulePath(source = null) {
  return resolveScope(source)
}

function lockProperty(obj, key) {
  if (!obj || typeof obj !== 'object' || !(key in obj)) return
  Object.defineProperty(obj, key, {
    value: obj[key],
    writable: false,
    configurable: false,
    enumerable: true,
  })
}

function lockProperties(obj, keys) {
  keys.forEach(key => lockProperty(obj, key))
}

export function createModuleContext(scoped, sharedLocale, initial = {}, broadcast = null) {
  const frameworkKeys = ['scoped',  '$bus', '$i18n', '$t', 'fetch', 'restrictedFetch']

  const mod = { ...initial }
  mod.scoped = scoped
  mod.$bus = new EventBus(broadcast)
  mod.$i18n = new I18n(sharedLocale)
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
  mod.restrictedFetch = (url, options) => {
    let resolvedUrl = url
    if (typeof url === 'string') {
      if (url.startsWith('@')) {
        resolvedUrl = url.slice(1)
      } else if (/^https?:\/\//.test(url)) {
        throw new Error(`fetch: external URL blocked in unsafe mode: ${url}`)
      } else if (!url.startsWith('/')) {
        resolvedUrl = scoped ? `${scoped}/${url}` : `/${url}`
      } else if (scoped && !url.startsWith(scoped + '/') && url !== scoped) {
        throw new Error(`fetch: cross-scope request blocked: ${url} (scoped: ${scoped})`)
      }
    }
    return fetch(resolvedUrl, options)
  }

  lockProperties(mod, frameworkKeys)
  return EnsureWrap(mod)
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

export function createRuntimeContext(parent = null, mod = null, initialSys = {}) {
  const parentSys = parent?.$sys || null
  const runtimeMod = mod || parent?.$mod || null
  const runtime = {
    $sys: createSystemContext(parentSys, initialSys),
    $mod: EnsureWrap(runtimeMod),
  }
  if (!Object.prototype.hasOwnProperty.call(initialSys || {}, '$router')) {
    const inheritedRouter = parentSys?.$router
    const routerView = inheritedRouter?.__routerView || inheritedRouter
    if (routerView && typeof routerView.createRuntimeProxy === 'function') {
      runtime.$sys.$router = routerView.createRuntimeProxy(runtime)
    }
  }
  return runtime
}

// ---- Scoped 路径工具 ----

function trimTrailingSlash(value) {
  if (!value || value === '/') return value || ''
  return value.endsWith('/') ? value.slice(0, -1) : value
}

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

export function resolveScope(source) {
  if (!source) return ''
  if (typeof source === 'string') {
    const v = source === '/' ? '' : source
    return v.endsWith('/') ? v.slice(0, -1) : v
  }
  const mod = source.$mod || source
  const v = mod?.scoped || ''
  if (!v || v === '/') return ''
  return v.endsWith('/') ? v.slice(0, -1) : v
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

// ---- ModuleContextManager ----

export function mergeModulePatch(mod, patch = {}) {
  if (!patch || typeof patch !== 'object') return
  Object.entries(patch).forEach(([key, value]) => {
    mod[key] = value
  })
}

export class ModuleContextManager {
  constructor() {
    this.modMap = new Map()
    this.wrappers = []
    this._aliasMap = new Map()
    this._globalAliases = {}
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
    this._aliasMap.clear()
    this._globalAliases = {}
  }

  async getModule(scoped = '') {
    const normalizedScoped = normalizeScoped(scoped || '')
    let mod = this.modMap.get(normalizedScoped)
    if (!mod) {
      mod = await this.createModule(normalizedScoped)
    }
    return mod
  }

  async createModule(scoped, patch = {}) {
    const mod = createModuleContext(scoped, this.sharedLocale, {}, (eventName, args, sourceBus) => {
      this.broadcastBusEvent(eventName, args, sourceBus)
    })
    mergeModulePatch(mod, patch)
    // 提前注册到 modMap，防止子模块 env.js 通过 loadModule
    // 反向引用当前模块时陷入重复创建
    this.modMap.set(scoped, mod)
    await this.loadEnvConfig(mod)
    for (const wrapper of this.wrappers) {
      wrapper(scoped, mod)
    }
    return mod
  }

  /**
   * 在 env.js 中预加载子模块，等待其 env.js 执行完毕后返回。
   * 只能在 env.js 加载期间调用（即 _loadingMod 存在时）。
   *
   * @param {string} subPath - 子模块路径，以 / 开头视为绝对路径，
   *   否则基于当前 scoped 解析为子路径
   * @returns {Promise<object>} 目标模块的 $mod 对象
   *
   * @example
   * // 在 scoped="/xxA" 的 env.js 中：
   * export default async ($mod, manager) => {
   *   await manager.loadModule('xxB')       // 加载 /xxA/xxB 的 env.js
   *   await manager.loadModule('/global')   // 加载 /global 的 env.js
   *   // 此时 xxB 和 global 模块的 env.js 已执行完毕
   * }
   */
  async loadModule(subPath) {
    if (!this._loadingMod) {
      throw new Error('loadModule can only be called during env.js loading')
    }
    if (!subPath || typeof subPath !== 'string') {
      throw new Error('loadModule: subPath must be a non-empty string')
    }
    const savedLoadingMod = this._loadingMod
    const currentScoped = savedLoadingMod.scoped || ''

    let targetScoped
    if (subPath.startsWith('/')) {
      targetScoped = normalizeScoped(subPath)
    } else {
      targetScoped = normalizeScoped(currentScoped ? `${currentScoped}/${subPath}` : `/${subPath}`)
    }

    try {
      return await this.getModule(targetScoped)
    } finally {
      // 确保子模块 env.js 加载完毕后恢复 _loadingMod，
      // 否则当前 env.js 后续的 addAlias 等调用会丢失模块关联
      this._loadingMod = savedLoadingMod
    }
  }

  broadcastBusEvent(eventName, args, sourceBus) {
    for (const mod of this.modMap.values()) {
      const bus = mod?.$bus
      if (!bus || bus === sourceBus || typeof bus.emitLocal !== 'function') continue
      bus.emitLocal(eventName, ...args)
    }
  }

  addAlias(prefixa, baseUrl, is_global = false) {
    if (!/^[a-zA-Z]+$/.test(prefixa)) {
      throw new Error(`addAlias: prefixa must contain only English letters, got "${prefixa}"`)
    }
    if (typeof baseUrl !== 'string' || !baseUrl) {
      throw new Error(`addAlias: baseUrl must be a non-empty string, got "${baseUrl}"`)
    }
    if (!/^(\/|https?:\/\/)/.test(baseUrl)) {
      throw new Error(`addAlias: baseUrl must start with / or https://, got "${baseUrl}"`)
    }
    if (is_global) {
      this._globalAliases[prefixa] = baseUrl
      return
    }
    if (!this._loadingMod) {
      console.warn('addAlias: no module is currently loading, alias ignored')
      return
    }
    const scoped = this._loadingMod.scoped
    if (!this._aliasMap.has(scoped)) {
      this._aliasMap.set(scoped, {})
    }
    this._aliasMap.get(scoped)[prefixa] = baseUrl
  }

  getAliases(scoped) {
    const scopedAliases = this._aliasMap.get(scoped) || null
    if (!scopedAliases) return this._globalAliases || null
    return { ...this._globalAliases, ...scopedAliases }
  }

  async loadEnvConfig(mod) {
    const base = mod.scoped && /^https?:\/\//.test(mod.scoped) ? mod.scoped : `${window.location.origin}${mod.scoped || ''}`
    const envUrl = `${base}/env.js`
    this._loadingMod = mod
    try {
      const envModule = await import(envUrl)
      if (typeof envModule.default === 'function') {
        await envModule.default(mod, this)
      }
    } catch (error) {
      console.warn(`error loading ${envUrl}: ${error}`)
    } finally {
      this._loadingMod = null
    }
  }
}

const moduleContextManager = new ModuleContextManager()

export default moduleContextManager
