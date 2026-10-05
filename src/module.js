/*
 * module.js — 模块上下文与环境配置
 * Copyright (C) 2024 veypi <i@veypi.com>
 *
 * 管理模块级 scoped 上下文、运行时创建、env.js 配置加载。
 * 合并原 context.js，消除 createRuntimeEnv 零价值包装。
 */

import { Wrap, Watch, EnsureWrap, defineProperty } from './reactive.js'
import EventBus from './vbus.js'
import I18n from './i18n.js'
import {
  ModuleResources,
  moduleIdentity,
  readModuleMeta,
  normalizeScoped,
  resourceMatcher,
} from './resource.js'
export { normalizeScoped, getModulePath } from './resource.js'
import { registerModule } from './execution/context.js'
import { NativeExecutor } from './execution/native.js'

// ---- define 登记表（__vhtml_dev.defines） ----

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

export function createModuleContext(
  scoped,
  sharedLocale,
  initial = {},
  broadcast = null,
  globals = null,
  resources = null
) {
  const mod = { ...initial }
  mod.scoped = scoped
  mod.$bus = new EventBus(broadcast)
  mod.$i18n = new I18n(sharedLocale)
  mod.$t = (key, params = {}) => mod.$i18n.t(key, params)
  resources ||= new ModuleResources({
    ...moduleIdentity(scoped, window.location.origin),
    unsafe: false,
  })
  mod.fetch = async (url, options) => {
    const lease = await resources.open(url, options)
    lease.release()
    return lease.response
  }

  // 内置件 = 装配期 define 锁只读（v0.10.1，lockProperty 语义并入 define 原语）：
  // raw 对象上走纯 defineProperty 语义；env.js 后赋值/再定义同名 → 原生
  // TypeError——先定义者不可覆盖
  const readonly = { writable: false, configurable: false }
  for (const key of ['scoped', '$bus', '$i18n', '$t', 'fetch']) {
    defineProperty(mod, key, mod[key], readonly)
  }
  const wrapped = EnsureWrap(mod, globals || undefined)
  // define 绑本模块（显式 local 目标的写入通道；global 目标走 all.define）
  defineProperty(
    wrapped,
    'define',
    (key, value, opts) => {
      const r = defineProperty(wrapped, key, value, opts)
      recordDefine(scoped || '/', key, opts)
      return r
    },
    readonly
  )
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

export function createRuntimeContext(
  parent = null,
  mod = null,
  initialSys = {}
) {
  const parentSys = parent?.$sys || null
  const runtimeMod = mod || parent?.$mod || null
  const runtime = {
    $sys: createSystemContext(parentSys, initialSys),
    $mod: EnsureWrap(runtimeMod),
    routeState: Object.hasOwn(initialSys, '$router')
      ? null
      : parent?.routeState || null,
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

// ---- ModuleContextManager ----

export class ModuleContextManager {
  constructor() {
    this.modMap = new Map()
    this.moduleMetadata = new Map()
    this._globalAliases = {}
    // $mod 二级树的全局层（v0.10.1）：模块 proxy 的 root 链终点。各模块
    // $mod 本地无 key 时读/写穿透到 globals——动态回落取代 addWrapper 复制
    this.globals = Wrap({})
    this.sharedLocale = Wrap({
      locale: localStorage.getItem('i18n_locale') || 'zh-CN',
      fallback: 'en-US',
    })
    this.initLocaleWatcher()
  }

  initLocaleWatcher() {
    Watch(
      () => this.sharedLocale.locale,
      (locale) => {
        localStorage.setItem('i18n_locale', locale)
        document.documentElement.lang = locale
      }
    )
  }

  /** Explicit host registration; env.js receives a module-bound context. */
  define(key, value, opts = {}) {
    const result = defineProperty(this.globals, key, value, opts)
    recordDefine('$globals', key, opts)
    return result
  }

  clear() {
    const entries = [...this.modMap.values()]
    this.modMap.clear()
    for (const entry of entries) entry.execution?.retire?.()
    this._globalAliases = {}
    this.globals = Wrap({})
    defineRegistry.length = 0
  }

  /**
   * clearScoped(prefix) — 按 scoped 前缀失效模块上下文（v0.10.5）：
   * 删除模块记录中「精确等于 prefix 或位于其下」的条目，
   * 使后续 getModule 重建模块上下文。globals/_globalAliases/defineRegistry
   * 是全局层，不属于任何 scoped，不在此清理。匹配使用规范模块根地址。
   * 已存活实例持有的旧 $mod 引用不受
   * 影响（invalidation 语义，非 HMR——组件级 HMR 已定档不做）。
   */
  clearScoped(prefix) {
    const matches = resourceMatcher(prefix)
    const address = (key) =>
      moduleIdentity(key, window.location.origin).root.replace(/\/$/, '')
    for (const [key, entry] of this.modMap) {
      if (matches(address(key))) {
        this.modMap.delete(key)
        entry.execution?.retire?.()
      }
    }
  }

  async getModule(scoped = '', metadata = null, patch = {}, ancestors = []) {
    const key = normalizeScoped(scoped || '')
    const existing = this.modMap.get(key)
    if (existing) {
      if (ancestors.includes(key))
        throw new Error(
          `Circular module initialization: ${[...ancestors, key].join(' → ')}`
        )
      await existing.ready
      return existing.mod
    }
    return (await this.createModule(key, patch, metadata, ancestors)).mod
  }

  async createModule(
    scoped,
    patch = {},
    meta = null,
    ancestors = []
  ) {
    scoped = normalizeScoped(scoped)
    const entry = { scoped, aliases: Object.create(null) }
    this.modMap.set(scoped, entry)
    // Publish the record before any async work. Pending and ready modules have
    // the same identity, so invalidation only has one registry to remove from.
    entry.ready = Promise.resolve().then(async () => {
      try {
        this.assertCurrent(entry)
        meta = this.moduleMetadata.get(scoped) || meta
        let envFound
        if (!meta) {
          const identity = moduleIdentity(scoped, window.location.origin)
          const url = identity.root + 'env.js'
          const response = await fetch(url, {
            redirect: 'error',
            signal: AbortSignal.timeout(10000),
          })
          try {
            meta = readModuleMeta(response, url)
            if (!response.headers.has('vhtml-scoped'))
              meta = { ...identity, unsafe: meta.unsafe }
            if (!response.ok && response.status !== 404)
              throw new Error(`HTTP ${response.status}: ${url}`)
            envFound = response.ok
          } finally {
            response.body?.cancel().catch(() => {})
          }
        }
        this.assertCurrent(entry)
        entry.meta = Object.freeze(meta)
        this.moduleMetadata.set(scoped, entry.meta)
        const resources = new ModuleResources(meta)
        entry.resources = resources
        if (meta.unsafe) {
          const { ModuleExecutor } = await import('./execution/module-executor.js')
          entry.execution = await ModuleExecutor.create(resources, patch)
          entry.mod = entry.execution.mod
        } else {
          entry.mod = createModuleContext(
            scoped,
            this.sharedLocale,
            patch,
            (name, args, source) => this.broadcastBusEvent(name, args, source),
            this.globals,
            resources
          )
          entry.execution = new NativeExecutor(resources)
        }
        this.assertCurrent(entry)
        registerModule(entry.mod, entry)
        if (envFound !== false)
          await entry.execution.environment(
            entry.mod,
            this.environmentContext(entry, [...ancestors, scoped]),
            envFound
          )
        this.assertCurrent(entry)
      } catch (error) {
        if (this.modMap.get(scoped) === entry) this.modMap.delete(scoped)
        if (entry.execution?.retire) entry.execution.retire()
        else entry.resources?.dispose()
        throw error
      }
    })
    await entry.ready
    return entry
  }

  assertCurrent(entry) {
    if (this.modMap.get(entry.scoped) !== entry)
      throw new Error('Module initialization invalidated')
  }

  // Each env invocation owns its context across await and nested loads.
  environmentContext(entry, ancestors = [entry.scoped]) {
    const { scoped } = entry
    const globals = this.globals
    return Object.freeze({
      define: (key, value, options) => {
        this.assertCurrent(entry)
        const result = defineProperty(globals, key, value, options)
        recordDefine('$globals', key, options)
        return result
      },
      loadModule: (subPath) => {
        this.assertCurrent(entry)
        if (typeof subPath !== 'string' || !subPath)
          throw new TypeError('loadModule requires a module path')
        const target = normalizeScoped(
          subPath.startsWith('/') ? subPath : `${scoped}/${subPath}`
        )
        return this.getModule(target, null, {}, ancestors)
      },
      addAlias: (name, url, global = false) => {
        this.assertCurrent(entry)
        this.addAlias(scoped, name, url, global)
      },
    })
  }

  broadcastBusEvent(eventName, args, sourceBus) {
    for (const entry of this.modMap.values()) {
      const bus = entry.mod?.$bus
      if (!bus || bus === sourceBus || typeof bus.emitLocal !== 'function')
        continue
      bus.emitLocal(eventName, ...args)
    }
  }

  addAlias(scoped, prefixa, baseUrl, is_global = false) {
    if (!/^[a-zA-Z]+$/.test(prefixa)) {
      throw new Error(
        `addAlias: prefixa must contain only English letters, got "${prefixa}"`
      )
    }
    if (typeof baseUrl !== 'string' || !baseUrl) {
      throw new Error(
        `addAlias: baseUrl must be a non-empty string, got "${baseUrl}"`
      )
    }
    if (!/^(\/|https?:\/\/)/.test(baseUrl)) {
      throw new Error(
        `addAlias: baseUrl must start with / or https://, got "${baseUrl}"`
      )
    }
    if (is_global) {
      this._globalAliases[prefixa] = baseUrl
      return
    }
    const entry = this.modMap.get(scoped)
    if (!entry) throw new Error(`Module is not registered: ${scoped}`)
    entry.aliases[prefixa] = baseUrl
  }

  getAliases(scoped) {
    const scopedAliases = this.modMap.get(scoped)?.aliases
    if (!scopedAliases) return this._globalAliases || null
    return { ...this._globalAliases, ...scopedAliases }
  }
}

const moduleContextManager = new ModuleContextManager()

export default moduleContextManager
