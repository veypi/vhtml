/*
 * module.js — 模块上下文与环境配置
 * Copyright (C) 2024 veypi <i@veypi.com>
 *
 * 管理模块级 scoped 上下文、运行时创建、env.js 配置加载。
 * 合并原 context.js，消除 createRuntimeEnv 零价值包装。
 */

import { Wrap, Watch, EnsureWrap, defineProperty } from './reactive.js'
import { withTimeout } from './utils.js'
import EventBus from './vbus.js'
import I18n from './i18n.js'

// ---- define 登记表（__vhtml_dev.defines） ----

// ESM 缓存穿透令牌：浏览器原生模块表按完整 URL 缓存、无任何 API 可驱逐，
// clearScoped/clear 管不到它。令牌随清缓存递增，import 点（imports.js 静态/
// 动态、env.js）在令牌非 0 时给 URL 追加 ?__ve={n}——新 URL 即新模块表条目，
// 强制走网络重取（服务端对 query 无感，etag 协商仍生效）。跨令牌同模块并存
// 两个实例（旧页面实例持旧引用），与 invalidation 语义一致，不是 HMR。
let importEpoch = 0
export function bumpImportEpoch() { importEpoch++ }
export function withImportBust(url) {
  if (!importEpoch) return url
  if (url.startsWith('blob:') || url.startsWith('data:')) return url
  // 外部 http(s)（CDN 三方库）不穿透；同源绝对 URL（env.js、动态 import 的
  // origin 绝对化产物）照常穿透
  if (/^https?:\/\//.test(url) && typeof window !== 'undefined' && window.location && !url.startsWith(window.location.origin)) return url
  return url + (url.includes('?') ? '&' : '?') + '__ve=' + importEpoch
}

const defineRegistry = []
const summarizeOpts = (opts = {}) =>
  ['get', 'set', 'writable', 'configurable', 'enumerable']
    .filter((k) => opts && opts[k] !== undefined)
    .join(',') || '-'
const recordDefine = (target, name, opts) => {
  defineRegistry.push({ name, target, opts: summarizeOpts(opts) })
}
if (typeof window !== 'undefined' && window.__vhtml_dev) {
  window.__vhtml_dev.defines = defineRegistry
}

// ---- 模块上下文 ----

export function getModulePath(source = null) {
  return resolveScope(source)
}

export function createModuleContext(scoped, sharedLocale, initial = {}, broadcast = null, globals = null) {
  const mod = { ...initial }
  mod.scoped = scoped
  mod.$bus = new EventBus(broadcast)
  mod.$i18n = new I18n(sharedLocale)
  mod.$t = (key, params = {}) => mod.$i18n.t(key, params)
  mod.fetch = (url, options) => {
    let resolvedUrl = url
    if (url.startsWith('@')) {
      resolvedUrl = url.slice(1)
    } else if (!/^https?:\/\//.test(url) && !url.startsWith('//') && !url.startsWith('blob:') && !url.startsWith('data:')) {
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
      } else if (url.startsWith('data:')) {
        // data: 透传（与 mod.fetch/loader 同语义：非网络资源，不 scope 不拦截）
      } else if (!url.startsWith('/')) {
        resolvedUrl = scoped ? `${scoped}/${url}` : `/${url}`
      } else if (scoped && !url.startsWith(scoped + '/') && url !== scoped) {
        throw new Error(`fetch: cross-scope request blocked: ${url} (scoped: ${scoped})`)
      }
    }
    return fetch(resolvedUrl, options)
  }

  // 内置件 = 装配期 define 锁只读（v0.10.1，lockProperty 语义并入 define 原语）：
  // raw 对象上走纯 defineProperty 语义；env.js 后赋值/再定义同名 → 原生
  // TypeError——先定义者不可覆盖
  const readonly = { writable: false, configurable: false }
  for (const key of ['scoped', '$bus', '$i18n', '$t', 'fetch', 'restrictedFetch']) {
    defineProperty(mod, key, mod[key], readonly)
  }
  const wrapped = EnsureWrap(mod, globals || undefined)
  // define 绑本模块（显式 local 目标的写入通道；global 目标走 all.define）
  defineProperty(wrapped, 'define', (key, value, opts) => {
    const r = defineProperty(wrapped, key, value, opts)
    recordDefine(scoped || '/', key, opts)
    return r
  }, readonly)
  return wrapped
}

// ---- 系统/上下文运行时 ----

export function createSystemContext(parent = null, initial = {}) {
  const sys = Object.create(parent || null)

  if (initial && typeof initial === 'object') {
    Object.assign(sys, initial)
  }

  return sys
}

// runtime 显式标记（取代鸭子类型判定 $mod/$sys/scoped）
export const RUNTIME = Symbol('vhtmlRuntime')

export function createRuntimeContext(parent = null, mod = null, initialSys = {}) {
  const parentSys = parent?.$sys || null
  const runtimeMod = mod || parent?.$mod || null
  const runtime = {
    $sys: createSystemContext(parentSys, initialSys),
    $mod: EnsureWrap(runtimeMod),
  }
  runtime[RUNTIME] = true
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
    this._aliasMap = new Map()
    this._globalAliases = {}
    // 正在加载 env.js 的模块栈（P3-3）：嵌套 loadModule 与并发加载经
    // push/pop 自平衡，取代旧单槽 + 手动保存/恢复（单槽在 await 交错时
    // 会被内层 finally null 清空，错配 recordDefine 归属、误抑制 outside-env 警告）
    this._loadingStack = []
    // $mod 二级树的全局层（v0.10.1）：模块 proxy 的 root 链终点。各模块
    // $mod 本地无 key 时读/写穿透到 globals——动态回落取代 addWrapper 复制
    this.globals = Wrap({})
    this.sharedLocale = Wrap({
      locale: localStorage.getItem('i18n_locale') || 'zh-CN',
      fallback: 'en-US',
    })
    this.initLocaleWatcher()
  }

  /** 正在加载 env.js 的模块（栈顶）；null = 非装载期 */
  get _loadingMod() {
    return this._loadingStack[this._loadingStack.length - 1] || null
  }

  initLocaleWatcher() {
    Watch(() => this.sharedLocale.locale, (locale) => {
      localStorage.setItem('i18n_locale', locale)
      document.documentElement.lang = locale
    })
  }

  /**
   * all.define(key, value, opts) — define 到 manager.globals（v0.10.1，
   * addWrapper 的替代）：所有模块 $mod 本地无此 key 时经 root 链动态回落。
   * 必须在 env.js 装载期调用——组件编译后再 define 新键，已编译模板不重估
   * （root 链 miss 读只注册本地 key 通道，装载顺序不变式见 SKILL.md）→
   * dev 模式警告。
   */
  define(key, value, opts = {}) {
    if (!this._loadingMod) {
      console.warn(`all.define: '${String(key)}' defined outside env.js loading — already-compiled templates reading this key will not re-evaluate`)
    }
    const r = defineProperty(this.globals, key, value, opts)
    recordDefine('$globals', key, opts)
  }

  clear() {
    this.modMap.clear()
    this._aliasMap.clear()
    this._globalAliases = {}
    this.globals = Wrap({})
    defineRegistry.length = 0
  }

  /**
   * clearScoped(prefix) — 按 scoped 前缀失效模块上下文（v0.10.5）：
   * 删除 modMap/_aliasMap 中「精确等于 prefix 或位于其下」的条目，
   * 使后续 getModule 重建模块上下文。globals/_globalAliases/defineRegistry
   * 是全局层，不属于任何 scoped，不在此清理。文件级 prefix（.../x.html）
   * 自动剥 .html 按所在目录模块匹配。已存活实例持有的旧 $mod 引用不受
   * 影响（invalidation 语义，非 HMR——组件级 HMR 已定档不做）。
   */
  clearScoped(prefix) {
    let p = normalizeScoped(prefix || '')
    if (p.endsWith('.html')) p = p.slice(0, -5)
    // 空前缀 = 全部模块上下文（与 loader 侧 match-all 对齐；globals/
    // defineRegistry 是全局层仍不动，须清它们用 clear()）
    if (!p) {
      this.modMap.clear()
      this._aliasMap.clear()
      return
    }
    for (const key of [...this.modMap.keys()]) {
      if (key === p || key.startsWith(p + '/')) this.modMap.delete(key)
    }
    for (const key of [...this._aliasMap.keys()]) {
      if (key === p || key.startsWith(p + '/')) this._aliasMap.delete(key)
    }
  }

  async getModule(scoped = '') {
    const normalizedScoped = normalizeScoped(scoped || '')
    let entry = this.modMap.get(normalizedScoped)
    if (!entry) {
      entry = await this.createModule(normalizedScoped)
    }
    return entry.mod
  }

  async createModule(scoped, patch = {}) {
    const mod = createModuleContext(scoped, this.sharedLocale, {}, (eventName, args, sourceBus) => {
      this.broadcastBusEvent(eventName, args, sourceBus)
    }, this.globals)
    mergeModulePatch(mod, patch)
    // 提前注册到 modMap，防止子模块 env.js 通过 loadModule
    // 反向引用当前模块时陷入重复创建。
    const entry = { mod }
    this.modMap.set(scoped, entry)
    await this.loadEnvConfig(mod)
    return entry
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
    const currentScoped = this._loadingMod.scoped || ''

    let targetScoped
    if (subPath.startsWith('/')) {
      targetScoped = normalizeScoped(subPath)
    } else {
      targetScoped = normalizeScoped(currentScoped ? `${currentScoped}/${subPath}` : `/${subPath}`)
    }

    // 子模块 loadEnvConfig 的 push/pop 自平衡恢复栈顶，无需保存/恢复
    return await this.getModule(targetScoped)
  }

  broadcastBusEvent(eventName, args, sourceBus) {
    for (const entry of this.modMap.values()) {
      const bus = entry.mod?.$bus
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
    this._loadingStack.push(mod)
    try {
      const envModule = await withTimeout(import(withImportBust(envUrl)), 10000, `import ${envUrl}`)
      if (typeof envModule.default === 'function') {
        await envModule.default(mod, this)
      }
    } catch (error) {
      console.warn(`error loading ${envUrl}: ${error}`)
    } finally {
      this._loadingStack.pop()
    }
  }
}

const moduleContextManager = new ModuleContextManager()

export default moduleContextManager
