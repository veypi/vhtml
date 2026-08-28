/*
 * reactive.js — 响应式系统（v0.10.0 全新重写）
 * Copyright (C) 2024 veypi <i@veypi.com>
 *
 * 设计要点（2026-08-28 v0.10.0，行为基线见 test/copybind.test.js）：
 *
 * - Effect handle（对象身份）取代全局数字索引：Watch 返回不透明 handle
 *   { dead, debug, fn }，Cancel O(1) 幂等；依赖表 listeners[lkey] =
 *   Set<handle>，add 天然去重，notify 迭代时惰性清理 dead 条目（key 不再
 *   变化则随 proxy 整体 GC，不劣于旧全局数组形态）。伪回调漏洞（整数索引
 *   复用）与槽位膨胀结构性消失。
 *
 * - 两阶段 flush + 变更门控：阶段一重求值拿新值并重新注册依赖，阶段二按
 *   equality 比较（缺省 Object.is），变了才调用户回调。equality: null =
 *   恒触发（框架内部恒跑型订阅，如 v-for reconcile——数组原地变异后引用
 *   不变，Object.is 会错误门掉）。已知边界（契约，非 bug）：模板表达式
 *   每次求值返回新引用（items.filter(...)）时门控恒放行，模板表达式应
 *   避免每次产生新引用。首轮回调保持立即同步执行的既有语义。
 *
 * - batch(fn) 原语：深度计数器挂起通知、归零单次通知（同 key 多次写合并
 *   为一次）。数组变异方法（splice/shift/unshift/sort/reverse/copyWithin/
 *   fill）在 get 陷阱返回自动 batch 的包装（per-proxy 缓存，函数身份稳定）；
 *   sort 比较器窗口内对其他对象的写入同样延迟到 batch 结束。
 *
 * - set 陷阱纯替换：Reflect.set，Object.is 相同不通知；新增/删除 key 额外
 *   通知 '' 结构通道（数组所有 key 恒注册在 ''）。深度合并（旧 copyBind）
 *   已从写路径整体移除——旧实现的实体合并曾把移动中的元素坍缩为同一
 *   proxy（unshift 别名污染，见 copybind.test.js golden-4）；v-for 行身份
 *   由 compiler.js reconcile 显式调用 mergeIntoProxy 保持。
 *
 * - 数组恒 '' 单粗通道（按索引订阅是反模式：splice 后索引身份无意义）；
 *   lazy wrap-on-read；DataID 盖章；SetDataRoot 作用域链；root 链穿透读
 *   同时注册本地 key 通道（重写顺带修复的追踪洞）。
 *
 * - 级联防护：单帧 flush 轮数上限 10，超限在调度层 throw（不经过单 watcher
 *   try/catch 隔离层，fail-fast 才不会被吞），附带轮数与 dirty effect 链
 *   诊断（AI 生成 UI 排障刚需）。
 *
 * - 保留不变式：单 watcher 异常不中断整轮 flush（2026-08-11 vedio_studio
 *   崩溃根治所加）——一处模板错误不得冻结全页响应式。
 *
 * - document.hidden 时 rAF 停摆：setTimeout 双通道兜底 + visibilitychange
 *   强制 flush（flushScheduled 幂等，先到先跑）。
 *
 * - 函数属性读取不注册依赖（重赋值 $data 上的函数本身不触发 watcher，
 *   重估依赖函数体内读取的响应式字段——既有契约）。
 *
 * - defineProperty 原语（v0.10.1）：Object.defineProperty 的响应式增强，
 *   $mod.define/all.define 底层。新装描述符接通知（key + '' 结构通道），
 *   getter this = 代理；已有数据 key = 赋值语义；显式目标写入不触发
 *   root 链穿透（define 本地可遮蔽 global 同名键）。
 */

import { errorLog } from './errors.js'

const listenStack = []   // 求值期栈：栈顶 = 当前正在注册依赖的 handle
const dirty = new Set()  // 待 flush 的 handle（Set 去重，迭代中删除安全）
let flushScheduled = false

// batch 窗口挂起的 (listeners, lkey) 对：归零时按 listeners×key 去重通知
let batchDepth = 0
const batchedNotifies = new Map()

const MAX_CASCADE_ROUNDS = 10
// 级联诊断 ring 上限：反复级联的页面不该让观测层无限增长
const MAX_CASCADE_ERRORS = 50

// __vhtml_dev 观测层（最小版；10.1 扩展 scope 注册表与实例树）
const devStats = { watches: 0, cancels: 0, flushes: 0 }
const cascadeErrors = []

const scheduleFrame = typeof requestAnimationFrame === 'function'
  ? requestAnimationFrame.bind(window)
  : (callback) => setTimeout(callback, 16)

function cascadeError(round) {
  const chain = [...dirty].map((h) => h.debug).filter(Boolean).join('\n  -> ')
  return new Error(
    `[vhtml] reactive cascade limit exceeded after ${round} rounds in one flush.\n` +
    `  effects still dirty:\n  -> ${chain || '(pass options.debug to Watch for diagnostics)'}`)
}

function flushUpdates() {
  flushScheduled = false
  let round = 0
  while (dirty.size > 0) {
    round++
    if (round > MAX_CASCADE_ROUNDS) {
      // 调度层抛出：必须在单 watcher try/catch 之外，fail-fast 不被吞。
      // flushScheduled 已复位，后续写入可重新调度（错误登记表供 __vhtml_dev 排障）。
      const err = cascadeError(round)
      cascadeErrors.push({ round, message: err.message, at: Date.now() })
      if (cascadeErrors.length > MAX_CASCADE_ERRORS) {
        cascadeErrors.splice(0, cascadeErrors.length - MAX_CASCADE_ERRORS)
      }
      throw err
    }
    const batch = [...dirty]
    dirty.clear()
    for (const handle of batch) {
      if (handle.dead) continue
      try {
        handle.fn()
      } catch (e) {
        // 单个 watcher 异常不中断整轮 flush，避免一处模板错误冻结全页响应式
        console.error('watcher error', e)
      }
    }
  }
  devStats.flushes++
}

function scheduleUpdate() {
  if (flushScheduled) return
  flushScheduled = true
  scheduleFrame(flushUpdates)
  // 后台 tab rAF 停摆：setTimeout 双通道兜底（flushScheduled 幂等，先到先跑）
  if (typeof document !== 'undefined' && document.hidden) {
    setTimeout(flushUpdates, 16)
  }
}

if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && dirty.size > 0 && !flushScheduled) flushUpdates()
  })
}

// ====================================================================
// batch 原语
// ====================================================================

/**
 * 深度计数器挂起通知，归零后按 listeners×key 去重单次通知。
 * 数组变异方法包装内部使用；用户侧批量写入同样可用。
 * @template T
 * @param {() => T} fn
 * @returns {T}
 */
export function batch(fn) {
  batchDepth++
  try {
    return fn()
  } finally {
    batchDepth--
    if (batchDepth === 0 && batchedNotifies.size > 0) {
      const entries = [...batchedNotifies.entries()]
      batchedNotifies.clear()
      for (const [listeners, keys] of entries) {
        for (const lkey of keys) notifyNow(listeners, lkey)
      }
    }
  }
}

// ====================================================================
// Watch / Cancel（Effect handle）
// ====================================================================

function previewOf(target) {
  try {
    return String(target).replace(/\s+/g, ' ').slice(0, 140)
  } catch (_) {
    return ''
  }
}

/**
 * @param {() => any} target 求值函数（求值期注册依赖）
 * @param {(newValue: any) => void} [callback] 缺省时副作用应写在 target 内（门控不参与）
 * @param {{ equality?: null | ((a: any, b: any) => boolean), debug?: string }} [options]
 *   equality 缺省 = Object.is（值不变不触发）；null = 恒触发（恒跑型订阅）；
 *   自定义函数 = 返回 true 视为相等。debug 进级联诊断链。
 * @returns 不透明 handle（传给 Cancel 取消；对象身份永不复用）
 */
export function Watch(target, callback, options) {
  const equality = options ? options.equality : undefined
  const handle = {
    dead: false,
    debug: (options && options.debug) || previewOf(target),
    fn: null,
  }
  let lastValue
  let hasLast = false

  const runTarget = () => {
    listenStack.push(handle)
    try {
      return target()
    } catch (e) {
      console.warn('running \n%s\n failed:', target, e)
      return undefined
    } finally {
      listenStack.pop()
    }
  }

  handle.fn = () => {
    const value = runTarget()
    if (typeof callback === 'function') {
      let changed = true
      if (equality !== null && hasLast) {
        changed = typeof equality === 'function'
          ? !equality(lastValue, value)
          : !Object.is(lastValue, value)
      }
      if (changed) callback(value)
    }
    lastValue = value
    hasLast = true
  }

  // 首轮：求值注册依赖 + 立即同步回调（既有语义）
  lastValue = runTarget()
  hasLast = true
  if (typeof callback === 'function') callback(lastValue)
  devStats.watches++
  return handle
}

/** O(1) 幂等取消；dead handle 随对应 key 下次通知惰性清理 */
export function Cancel(handle) {
  if (handle && !handle.dead) {
    handle.dead = true
    devStats.cancels++
  }
}

// ====================================================================
// 依赖表（listeners[lkey] = Set<handle>）
// ====================================================================

function track(listeners, lkey) {
  const top = listenStack[listenStack.length - 1]
  if (!top) return
  let set = listeners[lkey]
  if (!set) {
    set = new Set()
    listeners[lkey] = set
  }
  set.add(top)  // Set 去重：同一 handle 重复读取同一 key 只挂一次
}

function notifyNow(listeners, lkey) {
  const set = listeners[lkey]
  if (!set || set.size === 0) return
  let scheduled = false
  for (const handle of set) {
    if (handle.dead) {
      set.delete(handle)  // 惰性清理（Set 迭代中删当前项安全）
      continue
    }
    dirty.add(handle)
    scheduled = true
  }
  if (scheduled) scheduleUpdate()
}

function notify(listeners, lkey) {
  if (batchDepth > 0) {
    let keys = batchedNotifies.get(listeners)
    if (!keys) {
      keys = new Set()
      batchedNotifies.set(listeners, keys)
    }
    keys.add(lkey)
    return
  }
  notifyNow(listeners, lkey)
}

// ====================================================================
// Wrap（Proxy 依赖追踪）
// ====================================================================

export function GenUniqueID() {
  const timestamp = performance.now().toString(36)
  const random = Math.random().toString(36).substring(2, 5)
  return `${timestamp}-${random}`
}

const isProxy = Symbol('isProxy')
export const DataID = Symbol('DataID')
const rootObj = Symbol('root')

// defineProperty 原语需要触及 Wrap 闭包内的 listeners/isArray：Wrap 时登记
const proxyMeta = new WeakMap()  // proxy → { target, listeners, isArray }

export function IsWrapped(data) {
  return Boolean(data && typeof data === 'object' && data[isProxy])
}

export function EnsureWrap(data, root = undefined) {
  if (!data || typeof data !== 'object') return data
  if (IsWrapped(data)) {
    if (root) SetDataRoot(data, root)
    return data
  }
  return Wrap(data, root)
}

export function SetDataRoot(data, root) {
  data[rootObj] = root
}

function isProxyType(v) {
  if (!v || typeof v !== 'object') return false
  if (v instanceof Node || v instanceof Date || v instanceof RegExp || v instanceof Event) return false
  if (v.__noproxy) return false
  if (v.constructor !== Object && v.constructor !== Array) return false
  return true
}

// 数组变异方法：get 陷阱返回自动 batch 的包装（per-proxy 缓存，身份稳定）
const ARRAY_MUTATORS = new Set([
  'splice', 'shift', 'unshift', 'sort', 'reverse', 'copyWithin', 'fill',
])
const mutatorCache = new WeakMap()  // raw target → { key: wrapped fn }

function getArrayMutator(target, key, receiver) {
  let perProxy = mutatorCache.get(target)
  if (!perProxy) {
    perProxy = {}
    mutatorCache.set(target, perProxy)
  }
  let wrapped = perProxy[key]
  if (!wrapped) {
    const proto = Array.prototype[key]
    wrapped = function (...args) {
      // this 即调用处的 proxy（arr.splice(...) 形态）；防御性回退 receiver
      const self = this && this[isProxy] ? this : receiver
      return batch(() => proto.apply(self, args))
    }
    perProxy[key] = wrapped
  }
  return wrapped
}

/**
 * 显式深度合并（原 copyBind 的 merge 语义，v0.10.0 从 set 陷阱迁出）。
 * v-for reconcile 位置键复用分支专用：保持行身份（返回原 proxy，字段已
 * 原位更新、逐字段通知）；不可合并（非 proxy 旧值 / 形状互异 / 同 DataID
 * 实体）时返回 newValue，由调用方直接赋值替换。整个合并走 batch，单次通知。
 */
export function mergeIntoProxy(oldValue, newValue) {
  if (!oldValue || !oldValue[isProxy] || !isProxyType(newValue)) return newValue
  if (newValue[isProxy] && newValue[DataID] === oldValue[DataID]) return newValue
  if (Array.isArray(oldValue)) {
    if (!Array.isArray(newValue)) return newValue
    return batch(() => {
      oldValue.length = 0
      for (let i = 0; i < newValue.length; i++) oldValue.push(newValue[i])
      return oldValue
    })
  }
  if (Array.isArray(newValue)) return newValue
  return batch(() => {
    Object.keys(oldValue).forEach((k) => {
      if (!Object.prototype.hasOwnProperty.call(newValue, k)) delete oldValue[k]
    })
    Object.keys(newValue).forEach((k) => {
      const ov = oldValue[k]
      if (ov && ov[isProxy] && isProxyType(newValue[k])) {
        oldValue[k] = mergeIntoProxy(ov, newValue[k])
      } else {
        oldValue[k] = newValue[k]
      }
    })
    return oldValue
  })
}

export function Wrap(data, root = undefined) {
  const did = GenUniqueID()
  const isArray = Array.isArray(data)
  if (root) SetDataRoot(data, root)
  data[DataID] = did
  const listeners = {}
  const handler = {
    get(target, key, receiver) {
      if (key === DataID) return did
      else if (key === isProxy) return true
      const hasLocalKey = Reflect.has(target, key)
      // root 链穿透读：本地无此 key 而 root 上有 → 读走 root（root 是 proxy
      // 时读取本身已注册 root 通道依赖），同时注册本地 key 通道——key 被本地
      // 遮蔽/结构变化时依赖方仍会重估（修复旧实现零注册的追踪洞）
      if (!hasLocalKey && target[rootObj] && key in target[rootObj]) {
        if (typeof key !== 'symbol') track(listeners, key)
        return target[rootObj][key]
      }
      const value = Reflect.get(target, key, receiver)
      if (typeof value === 'function') {
        // 数组变异方法：自动 batch 包装；其余函数原样返回且不注册依赖
        // （重赋值函数本身不触发，重估依赖函数体内读取的响应式字段）
        if (isArray && ARRAY_MUTATORS.has(key)) return getArrayMutator(target, key, receiver)
        return value
      }
      if (typeof key === 'symbol') return value
      track(listeners, isArray ? '' : key)
      if (isProxyType(value) && !value[isProxy]) {
        const newValue = Wrap(value, undefined)
        target[key] = newValue  // 直写 raw target：读路径零通知（wrap 是读副作用）
        return newValue
      }
      return value
    },
    set(target, key, newValue, receiver) {
      const root = target[rootObj]
      // 与 get/has 对称：本地没有且 root 链上有的 key，穿透写入持有者，
      // 避免写入本地后遮蔽 root 同名属性（如 v-for 作用域内修改组件状态）
      if (typeof key !== 'symbol' && root && !Reflect.has(target, key) && key in root) {
        root[key] = newValue
        return true
      }
      const oldValue = Reflect.get(target, key, receiver)
      if (Object.is(oldValue, newValue)) return true
      // 纯替换：深度合并已迁出（mergeIntoProxy），写路径可预测
      const hadKey = Reflect.has(target, key)
      const result = Reflect.set(target, key, newValue, receiver)
      if (!result) {
        // 描述符锁（writable:false 数据属性 / 仅 getter 访问器）在 sloppy
        // 调用方下会静默 no-op（P2，v0.10.2）：显式 throw 让 fail-fast 不依赖
        // 调用方严格模式；经 executeFn 的 try/catch 落入错误登记表。
        throw new TypeError(`cannot set ${isArray ? 'array item' : `property '${String(key)}'`}: readonly or setter-less`)
      }
      if (listenStack.length === 0) {
        // 新增 key 属于结构变化：除精确 key 外还需通知结构依赖（'' 通道，
        // 数组已有该语义——其所有 key 都注册在 ''）
        notify(listeners, isArray ? '' : key)
        if (!isArray && !hadKey) notify(listeners, '')
      }
      return result
    },
    // Object.keys / for...in / 展开都会走 ownKeys：注册结构依赖（'' 通道），
    // 否则空数组/空对象上 v-for 的 collect 无任何内容依赖，首次 push 静默不更新
    ownKeys(target) {
      track(listeners, '')
      return Reflect.ownKeys(target)
    },
    has(target, key) {
      if (Reflect.has(target, key)) return true
      return Boolean(target[rootObj] && key in target[rootObj])
    },
    deleteProperty(target, key) {
      const result = Reflect.deleteProperty(target, key)
      if (result && listenStack.length === 0) {
        // 删 key 同属结构变化，通知 '' 通道（数组语义并入 ''）
        notify(listeners, isArray ? '' : key)
        if (!isArray) notify(listeners, '')
      }
      return result
    },
  }
  const proxy = new Proxy(data, handler)
  proxyMeta.set(proxy, { target: data, listeners, isArray })
  return proxy
}

/**
 * defineProperty — Object.defineProperty 的响应式增强公共原语（v0.10.1，
 * $mod.define / all.define 的底层实现；对任意对象安全）。
 *
 * 语义分派：
 * - 普通对象：纯 defineProperty 语义。默认值 configurable/writable/
 *   enumerable 全为 true（可重复 define 覆盖——非锁属性谁后谁生效）。
 * - Wrap proxy，带 get/set（描述符语义）：Object.defineProperty 安装，
 *   经 proxy 读取时 Reflect.get 透传 receiver → getter this = 代理，
 *   体内读字段注册依赖；写入经 Wrap set 陷阱调 setter 后通知。非
 *   configurable 的旧键 → 原生 TypeError（先定义者不可覆盖）。
 * - Wrap proxy，无 get/set（数据语义）：已有 own key = 赋值（代理 set：
 *   覆盖+通知，锁属性 Reflect.set 返 false → 严格模式原生 TypeError）；
 *   新 key = 描述符新装 + 通知（key 通道 + 对象 '' 结构通道）。
 *
 * define 是显式目标写入：永不触发 root 链穿透写。root（globals）有同名
 * key 时新装本地条目遮蔽之——这正是 define 相对 `$mod.x = y` 的用途：
 * 赋值会穿透到持有者，define 永远写调用方指定的目标。
 */
export function defineProperty(target, key, value, opts = {}) {
  if (typeof key === 'symbol') throw new Error('defineProperty: symbol key not supported')
  if (!target || typeof target !== 'object') throw new Error('defineProperty: target must be an object')
  const meta = proxyMeta.get(target) || null
  const raw = meta ? meta.target : target
  const isAccessor = typeof opts.get === 'function' || typeof opts.set === 'function'
  if (!meta) {
    if (isAccessor) {
      Object.defineProperty(raw, key, {
        get: opts.get,
        set: opts.set,
        enumerable: opts.enumerable ?? true,
        configurable: opts.configurable ?? true,
      })
    } else {
      Object.defineProperty(raw, key, {
        value,
        writable: opts.writable ?? true,
        enumerable: opts.enumerable ?? true,
        configurable: opts.configurable ?? true,
      })
    }
    return
  }
  const hadOwn = Object.prototype.hasOwnProperty.call(raw, key)
  if (isAccessor || !hadOwn) {
    const descriptor = isAccessor
      ? {
          get: opts.get,
          set: opts.set,
          enumerable: opts.enumerable ?? true,
          configurable: opts.configurable ?? true,
        }
      : {
          value,
          writable: opts.writable ?? true,
          enumerable: opts.enumerable ?? true,
          configurable: opts.configurable ?? true,
        }
    batch(() => {
      Object.defineProperty(raw, key, descriptor)
      notify(meta.listeners, meta.isArray ? '' : key)
      if (!meta.isArray && !hadOwn) notify(meta.listeners, '')
    })
    return
  }
  // 已有 own key 的数据语义 = 赋值（代理 set 全套语义：穿透分支因本地已有
  // 该 key 不触发；锁属性返 false → ESM 严格模式原生 TypeError）
  target[key] = value
}

// ====================================================================
// __vhtml_dev 观测层（最小版）
// ====================================================================

if (typeof window !== 'undefined' && !window.__vhtml_dev) {
  window.__vhtml_dev = {
    get stats() {
      return {
        ...devStats,
        dirty: dirty.size,
        liveHandles: devStats.watches - devStats.cancels,
      }
    },
    cascadeErrors,
    // 全局错误登记表（errors.js，v0.10.3 错误契约）：编译/表达式/挂载四类
    get errors() {
      return errorLog
    },
  }
}
