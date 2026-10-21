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
import { templateRef } from './url.js'

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

// ---- alias 规则（URL 键）----
//
// 组件标签推导逻辑候选路径：<ai-box> → '/ai/box'（compiler-attrs.js
// resolveComponentUrl）。alias 规则把候选映射成 origin 绝对地址（'@' 转义
// 前缀由调用方补，resource.js resolve 处理）。键两形态：'.html' 结尾 =
// 精确文件键（与候选+'.html' 全等匹配），否则 = 目录前缀键（段边界最长
// 前缀匹配，'/ai' 不命中 '/aix'）。命中优先级：精确 > 最长前缀；同具体度
// 按表档 primary > scoped > global。归一化仅此一处，注册与查表共用。

export function isExactAliasKey(key) {
  return key.endsWith('.html')
}

export function normalizeAliasKey(key) {
  if (typeof key !== 'string' || !key)
    throw new Error(`addAlias: key must be a non-empty string, got "${key}"`)
  let k = key
  while (k.length > 1 && k.endsWith('/')) k = k.slice(0, -1)
  if (!k.startsWith('/') || k === '/')
    throw new Error(
      `addAlias: key must be an absolute logical path below /, got "${key}"`
    )
  if (
    !/^\/[a-z0-9._\-/]+$/.test(k) ||
    k.split('/').some((seg) => seg === '.' || seg === '..')
  )
    throw new Error(
      `addAlias: key must be lowercase path segments (no . or ..), got "${key}"`
    )
  return k
}

export function normalizeAliasValue(key, value) {
  if (typeof value !== 'string' || !value)
    throw new Error(`addAlias: value must be a non-empty string, got "${value}"`)
  if (!/^(\/|https?:\/\/)/.test(value))
    throw new Error(
      `addAlias: value must start with / or https://, got "${value}"`
    )
  let v = value
  while (v.length > 1 && v.endsWith('/')) v = v.slice(0, -1)
  if (isExactAliasKey(key)) {
    if (!v.endsWith('.html'))
      throw new Error(
        `addAlias: exact key "${key}" requires a file value ending with .html, got "${value}"`
      )
  } else if (v.endsWith('.html')) {
    throw new Error(
      `addAlias: prefix key "${key}" requires a directory value (not .html), got "${value}"`
    )
  }
  return v
}

// tables = getAliases() 返回的 { primary, scoped, global }。返回映射后的
// 地址字符串（调用方补 '@'），未命中返回 null。
export function matchAlias(candidate, tables) {
  if (!tables) return null
  const exactKey = candidate + '.html'
  for (const table of [tables.primary, tables.scoped, tables.global]) {
    if (table && Object.hasOwn(table, exactKey)) return table[exactKey]
  }
  let best = null
  let bestLen = 0
  for (const table of [tables.primary, tables.scoped, tables.global]) {
    if (!table) continue
    for (const key of Object.keys(table)) {
      if (isExactAliasKey(key) || key.length <= bestLen) continue
      if (
        candidate === key ||
        (candidate.startsWith(key) && candidate.charCodeAt(key.length) === 47)
      ) {
        best = table[key] + candidate.slice(key.length)
        bestLen = key.length
      }
    }
  }
  return best
}

// ---- ModuleContextManager ----

export class ModuleContextManager {
  constructor() {
    this.modMap = new Map()
    this.moduleMetadata = new Map()
    this._globalAliases = {}
    // host 特权档（profile 规则表）：优先级最高的 alias 表，仅根模块 env
    // 可经 addPrimaryAlias 注册；clearScoped 不清（与全局层同生命周期）
    this._primaryAliases = {}
    // slot override 规则表（V2，profile.md §2）：键 = 宿主组件运行期实际 ref
    //（templateRef：去 .html 留 query）+ '\n' + 槽名；值 = {component, slot, url, mode}。
    // alias 与 slot 对同一组件互斥（alias 整体替换后 ref 变了，旧键永不命中）。
    // 片段装载/样式释放在 loader.js（fetchFragment/releaseFragment，经 fragmentRelease 钩子
    // 免循环依赖）；slotOverrideVersion = 响应式版本号：注册/注销/片段就绪 bump，
    // 出口 watch 重估（片段就绪自动重渲、规则删除自动回退 projected/fallback）。
    this._slotOverrides = Object.create(null)
    this.slotOverrideVersion = Wrap({v: 0})
    // loader.js 装配（removeSlotOverride 时释放片段样式）；测试可替换
    this.fragmentRelease = null
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
    this._primaryAliases = {}
    this._slotOverrides = Object.create(null)
    this.slotOverrideVersion = Wrap({v: 0})
    this.globals = Wrap({})
    defineRegistry.length = 0
  }

  /**
   * clearScoped(prefix) — 按 scoped 前缀失效模块上下文（v0.10.5）：
   * 删除模块记录中「精确等于 prefix 或位于其下」的条目，
   * 使后续 getModule 重建模块上下文。globals/_globalAliases/_primaryAliases/
   * defineRegistry 是全局/host 层，不属于任何 scoped，不在此清理。匹配使用
   * 规范模块根地址。
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
      // Native env service guards share the same generation as define and $mod.
      // Isolated env receives its own restricted context in ModuleExecutor.
      globals,
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
      addAlias: (key, url, global = false) => {
        this.assertCurrent(entry)
        this.addAlias(scoped, key, url, global ? 'global' : 'scoped')
      },
      // host 特权档注册口：仅根模块 env（scoped === ''）可用，profile 规则
      // 走此通道（P1b）；子模块 env 调用即抛错，防止 skill 劫持宿主的组件解析
      addPrimaryAlias: (key, url) => {
        this.assertCurrent(entry)
        if (scoped !== '')
          throw new Error('addPrimaryAlias is host-only (root module env)')
        this.addAlias(scoped, key, url, 'primary')
      },
      // slot override（V2）：profile 槽模板替换，host-only（同 addPrimaryAlias 档）。
      // component = 宿主组件路径（归一化为运行期 ref）；slot '' = 默认槽；
      // mode: override（默认，压 projected）/ soft（只压原生 fallback）
      addSlotOverride: (component, slot, url, opts) => {
        this.assertCurrent(entry)
        if (scoped !== '')
          throw new Error('addSlotOverride is host-only (root module env)')
        this.addSlotOverride(component, slot, url, opts)
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

  // tier: 'scoped' | 'global' | 'primary'（优先级递增序见 matchAlias 表档）
  addAlias(scoped, key, value, tier = 'scoped') {
    key = normalizeAliasKey(key)
    value = normalizeAliasValue(key, value)
    if (tier === 'global') {
      this._globalAliases[key] = value
      return
    }
    if (tier === 'primary') {
      this._primaryAliases[key] = value
      return
    }
    if (tier !== 'scoped') throw new Error(`addAlias: unknown tier "${tier}"`)
    const entry = this.modMap.get(scoped)
    if (!entry) throw new Error(`Module is not registered: ${scoped}`)
    entry.aliases[key] = value
  }

  // V2：注册槽替换规则（host 层；env 上下文已门、此处不再验 scoped）
  addSlotOverride(component, slotName, url, {mode = 'override'} = {}) {
    if (typeof component !== 'string' || !component.startsWith('/'))
      throw new Error(`addSlotOverride: component must be an absolute path, got "${component}"`)
    if (mode !== 'override' && mode !== 'soft')
      throw new Error(`addSlotOverride: mode must be override|soft, got "${mode}"`)
    if (typeof url !== 'string' || !url.startsWith('/'))
      throw new Error(`addSlotOverride: url must be an absolute path, got "${url}"`)
    const ref = templateRef(component)
    const slot = slotName == null ? '' : String(slotName)
    this._slotOverrides[ref + '\n' + slot] = {component: ref, slot, url, mode}
    this.slotOverrideVersion.v++
  }

  removeSlotOverride(component, slotName = '') {
    const key = templateRef(component) + '\n' + (slotName == null ? '' : String(slotName))
    const rule = this._slotOverrides[key]
    if (!rule) return false
    delete this._slotOverrides[key]
    this.slotOverrideVersion.v++
    this.fragmentRelease?.(rule.url)   // 片段样式释放（新增生命周期成本，规则删除即清）
    return true
  }

  // 出口查询：宿主 ref + 槽名 → 规则（无 = null）
  slotOverrideFor(componentRef, slotName) {
    return this._slotOverrides[componentRef + '\n' + (slotName ?? '')] || null
  }

  // 三档表原样返回（不合并），优先级判定归 matchAlias。scoped 为 null/undefined
  // 或未注册时 scoped 档为 null（根模块 scoped='' 照常查表）。
  getAliases(scoped) {
    return {
      primary: this._primaryAliases,
      scoped: scoped == null ? null : (this.modMap.get(scoped)?.aliases ?? null),
      global: this._globalAliases,
    }
  }
}

const moduleContextManager = new ModuleContextManager()

export default moduleContextManager
