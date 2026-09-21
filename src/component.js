/*
 * component.js — 组件系统
 * Copyright (C) 2024 veypi <i@veypi.com>
 *
 * 组件解析、setup、挂载主流程。
 */

import { Wrap, EnsureWrap } from './reactive.js'
import { Run, AsyncRun, setCompileContext } from './sandbox.js'
import { reportError } from './errors.js'
import utils from './utils.js'
import { createRuntimeContext, RUNTIME } from './module.js'
import { parseImports } from './imports.js'
import { registerScriptLifecycle } from './lifecycle.js'
import { templateLoader } from './loader.js'
import { ComponentScope } from './component-scope.js'
import {
  instanceOf,
  setInstance,
  createInstance,
  detachInstance,
} from './component-instance.js'
import { createSlotContents } from './slots.js'
import { watch } from './runtime-watch.js'

export { ComponentScope } from './component-scope.js'
export {
  ComponentInstance,
  instanceOf,
  setInstance,
  metaOf,
  setNodeScope,
  getNodeScope,
  createInstance,
  attachChildInstance,
  detachInstance,
  disposeRuntimeSubtree,
} from './component-instance.js'
export { createSlotContents, parseSlots } from './slots.js'


// ===================================================================
// 组件解析/挂载 (原 component.js)
// ===================================================================

export async function parseRaw(dom, data, runtime, code, ctx) {
  data = EnsureWrap(data || {})
  const tmpId = `_${Math.random().toString(36).slice(2)}`
  // RUNTIME symbol 显式标记（取代 $mod/$sys/scoped 鸭子判定）
  const activeRuntime = (runtime && runtime[RUNTIME])
    ? runtime
    : instanceOf(dom)?.runtime || runtime || {}
  const target = await templateLoader.parseUI(code, activeRuntime, tmpId)
  ctx.parseRef(tmpId, dom, data, activeRuntime, target)
}

export async function parseRef(vsrc, dom, data, runtime, target, optsOrCtx, ctx) {
  data = EnsureWrap(data || {})
  ctx = (optsOrCtx && typeof optsOrCtx === 'object' && optsOrCtx.compileNode) ? optsOrCtx : (ctx)
  const options = (optsOrCtx && typeof optsOrCtx === 'object' && !optsOrCtx.compileNode) ? optsOrCtx : {}
  const singleMode = options.single || (typeof optsOrCtx === 'boolean' ? optsOrCtx : false)

  const previousInstance = instanceOf(dom, false)
  const parentInstance = instanceOf(dom.parentNode)
  if (previousInstance) {
    previousInstance.scope?.dispose(dom)
    detachInstance(previousInstance)
  }

  const isUnsafe = dom.hasAttribute('unsafe') || (parentInstance?.unsafe ?? false)
  if (dom.hasAttribute('unsafe')) dom.removeAttribute('unsafe')

  const instance = createInstance(dom, parentInstance, 'component')
  setInstance(dom, instance)
  instance.unsafe = isUnsafe
  instance.scope = new ComponentScope(dom)
  // 路由缓存软断开标记：调用方（路由）经 parseRef options 声明，
  // 运行时判读只走实例字段，不依赖任何 DOM 属性
  if (options.keepOnDetach) instance.keepOnDetach = true
  dom.setAttribute('vparsing', '')
  // 兜底清理：仅当元素上没有新实例接管（自己被替换/销毁）时才移除 vparsing，
  // 避免误删新实例的解析标记；异常或竞态提前退出时组件不会永久隐藏。
  const clearParsing = () => {
    const cur = instanceOf(dom, false)
    if (cur === instance || cur === null) dom.removeAttribute('vparsing')
  }

  // 表达式错误定位的编译上下文（v0.10.3）：buildErrorContext / 未命中标识符警告取用；
  // finally 必恢复（模块级单例，泄漏会误导后续错误的定位）
  const compileCtx = {
    tag: dom.tagName?.toLowerCase() || '',
    vref: dom.getAttribute('vref') || '',
    vsrc: vsrc || target?.url || '',
  }
  const restoreCompileCtx = setCompileContext(compileCtx)

  try {
  const parentRuntime = runtime
  const refOf = dom.getAttribute('vrefof')
  const parentRef = dom.closest(`*[vref='${refOf}']`)
  if (parentRef) runtime = instanceOf(parentRef)?.runtime

  // v0.10.1 阶段 5：generation token 统一竞态契约。scope.dispose 是唯一销毁口
  // （显式销毁/parseRef 替换都经它 kill()），await 边界统一 alive() 校验，
  // 取代逐点 instanceOf(dom,false)!==instance 检查。
  // 嵌套组合契约：setupRef 是本段的子段，复用父段票据（子段另行 issue 会
  // 作废父段在途票据，导致 setup 后编译被误中止）；同一票据在子 await 期间
  // 的 kill 同样使父段校验失败，安全性不降级
  const token = instance.scope.token
  const ticket = token.issue()

  if (!target && vsrc) {
    if (!vsrc.endsWith('.html')) vsrc = `${vsrc}.html`
    target = await templateLoader.fetchUI(vsrc, runtime, isUnsafe)
    compileCtx.vsrc = vsrc
    if (!token.alive(ticket)) {
      // 竞态：实例已被替换/销毁（如路由竞态 dispose），提前退出，finally 兜底清理
      return
    }
  }

  const mod = target?.mod || runtime?.$mod || null
  const componentRuntime = createRuntimeContext(runtime || null, mod)
  if (isUnsafe) componentRuntime.__unsafe = true
  componentRuntime.$sys.$emit = (evt, ...args) => {
    evt = evt.toLowerCase()
    // fail-fast（v0.10.3）：内置事件名冲突下自定义事件永不触发，
    // AI 生成的组件看不到 warn，错误必须暴露成异常
    if (utils.EventsList.indexOf(evt) !== -1) {
      throw new Error(`[vhtml] $emit("${evt}") 使用了 DOM 内置事件名：父组件的 @${evt} 会被当作原生 DOM 事件监听，自定义事件不会触发。请改用非内置事件名。`)
    }
    const events = instanceOf(dom, false)?.events
    if (!events) return
    const callback = events[evt]
    if (typeof callback === 'function') callback(...args)
  }
  instance.runtime = componentRuntime
  instance.vsrc = vsrc

  const originData = await setupRef(dom, data, parentRuntime, target, instance, singleMode, ctx, ticket)
  if (!token.alive(ticket)) {
    return
  }
  // 阶段迁移：setup 完成 → building（模板编译与子组件挂载）
  instance.scope?.markBuilding()
  ctx.suspendMO?.()

  if (singleMode) {
    ctx.compileAttrs(dom, originData, componentRuntime, ctx, target?.customAttrs)
  } else {
    ctx.compileAttrs(dom, data, parentRuntime, ctx, target?.customAttrs)
  }

  const children = ctx.compileVif(Array.from(dom.childNodes), originData, componentRuntime, ctx)
  for (const child of children) {
    ctx.compileNode(child, originData, componentRuntime, ctx)
  }
  dom.removeAttribute('vparsing')
  ctx.resumeMO?.()

  mountRef(dom, originData, componentRuntime, target, ctx)
  // 挂载迁移唯一入口（v0.11）：资格满足（宿主已接入文档）即 mounted 并执行
  // plain script；游离 staging 构建时宿主未连接，经 whenConnected 兜底或
  // Page.attach 树遍历在 commit 接入后补迁移——脚本绝不在游离期执行
  instance.scope?.tryMount()
  } catch (error) {
    // 解析/编译异常：报错并确保 MO 恢复，避免 MutationObserver 永久挂起；
    // 静默空白是最恶劣的失败形态——渲染可见错误占位（v0.10.3 错误契约）
    ctx.resumeMO?.()
    // 失败路径同样走唯一销毁口：已注册的 props watchers 与在途异步段一并收掉，
    // 不留待节点移除时 observer 兜底（dispose 幂等；token.kill 使在途段早退）
    instance.scope?.dispose(dom)
    const message = error?.message || String(error)
    instance._error = { kind: 'mount', message }
    reportError('mount', message, { ...compileCtx, stack: error?.stack || '' })
    renderErrorPlaceholder(dom, compileCtx.vsrc, message)
  } finally {
    clearParsing()
    restoreCompileCtx()
  }
}

/** 坏组件可见占位（v0.10.3 错误契约）：取代旧行为的静默空白 */
function renderErrorPlaceholder(dom, vsrc, message) {
  if (!dom) return
  const pre = document.createElement('pre')
  pre.className = 'vhtml-error'
  pre.setAttribute('style', 'margin:0;padding:0.5em 0.75em;border:1px solid #e5484d;border-left:3px solid #e5484d;background:#fff5f5;color:#a11a1f;font:11px/1.5 ui-monospace,monospace;white-space:pre-wrap;word-break:break-all;')
  pre.textContent = `[vhtml] ${vsrc || 'component'} failed: ${message}`
  dom.replaceChildren(pre)
}

export async function setupRef(dom, data, parentRuntime, target, instance, singleMode = false, ctx, ticket = null) {
  const originData = Wrap({ $refs: Wrap({}) })
  let inst = instance || instanceOf(dom, false)
  if (!inst) return originData
  const componentRuntime = inst?.runtime
  const sandboxOptions = inst?.unsafe ? { unsafe: true } : {}

  if (target.setup) {
    let script = target.setup.code
    if (inst?.unsafe) {
      console.warn(`unsafe component "${target.url}" contains <script setup>, imports and external modules are blocked`)
    }
    // 异步段令牌（v0.10.1 阶段 5）：parseImports/AsyncRun 两处 await 边界统一校验。
    // parseRef 在途时复用其票据（嵌套子段不得 issue 作废父段）；独立调用时自行领票
    const token = inst.scope.token
    const segTicket = ticket ?? token.issue()
    script = await parseImports(script, originData, componentRuntime, target.url, inst?.unsafe)
    // watch 延迟队列（v0.10.3）：setup 内 $watch 入队，props 绑定完成后统一排空，
    // 确保注册时求值读到已绑定的 props（取代旧 50ms 定时器）
    const setupScope = inst?.scope
    setupScope?.beginWatchQueue()
    await AsyncRun(script, originData, componentRuntime, {
      $node: dom,
      $watch: (targetFn, callback, options) => {
        const scope = inst?.scope
        const register = () => watch(scope, targetFn, callback, options)
        if (scope) return scope.queueWatch(register)
        return register()
      },
      // $scope 与生命周期脚本同源（此前 setup 遗漏：setup 里调用读成 undefined 直接 TypeError）
      $scope: setupScope,
    }, sandboxOptions)
    if (!token.alive(segTicket)) return originData
    inst = instanceOf(dom, false)
    if (!inst) return originData
  }

  if (!originData.$refs || typeof originData.$refs !== 'object') {
    originData.$refs = Wrap({})
  }
  instance.data = originData

  if (singleMode) {
    inst?.scope?.flushWatchQueue()
    return originData
  }

  if (dom.hasAttribute('vslot-inherit')) {
    dom.removeAttribute('vslot-inherit')
    let owner = instanceOf(dom.parentNode)
    while (owner && !owner.slotContents) {
      owner = instanceOf(owner.host?.parentNode)
    }
    instance.slotContents = owner?.slotContents || {}
  } else {
    // 插槽源直接取宿主当前子节点（createSlotContents 内部逐条深克隆），
    // 不再在实例上驻留快照副本（实例终生持有会双倍占用内存）
    const slotSources = Array.from(dom.childNodes)
      .filter(n => !(n.nodeType === 3 && !n.textContent.trim()))
    instance.slotContents = createSlotContents(slotSources, data, parentRuntime)
  }
  dom.innerHTML = ''

  const bodyClone = target.body.cloneNode(true)
  dom.append(...bodyClone.childNodes)

  const scope = instance.scope
  Object.keys(originData).forEach(key => {
    const localKey = utils.CamelToKebabCase(key)
    if (typeof originData[key] === 'boolean') {
      if (dom.hasAttribute(key) || dom.hasAttribute(localKey)) {
        originData[key] = true
      }
    } else if (dom.hasAttribute(key)) {
      originData[key] = dom.getAttribute(key)
      dom.removeAttribute(key)
    } else if (dom.hasAttribute(localKey)) {
      originData[key] = dom.getAttribute(localKey)
      dom.removeAttribute(localKey)
    }

    if (dom.hasAttribute(`:${key}`) || dom.hasAttribute(`:${localKey}`)) {
      const expr = dom.getAttribute(`:${key}`) || dom.getAttribute(`:${localKey}`)
      dom.removeAttribute(`:${key}`)
      dom.removeAttribute(`:${localKey}`)
      delete originData[key]
      if (expr) {
        // v0.10.0：删 deep —— 求值路径读取即注册，深层传播靠共享 proxy 本身；
        // 变更门控（Object.is）下天然引用语义，回调直接消费阶段一求值结果
        watch(scope, () => Run(expr, data, parentRuntime), (value) => {
          originData[key] = value
        })
      } else {
        watch(scope, () => data[key], (value) => {
          originData[key] = value
        })
      }
    }

    if (dom.hasAttribute(`v:${key}`) || dom.hasAttribute(`v:${localKey}`)) {
      let expr = dom.getAttribute(`v:${key}`) || dom.getAttribute(`v:${localKey}`)
      dom.removeAttribute(`v:${key}`)
      dom.removeAttribute(`v:${localKey}`)
      if (!expr) expr = key
      const args = ctx.findLastAccess?.(expr, data)
      if (!args || (!args.chain && !args.key) || (args.data === undefined && !args.chain)) {
        console.warn(`not find bind variables: ${expr}`)
        return
      }
      // v: 绑定经惰性路径链解析 —— 读写每次从根 data 沿链求值，
      // 中间对象被整体替换（v0.10.0 纯替换语义）后绑定仍跟随新对象（修复
      // profile.html 等 user = await fetchUser() 场景的写回丢失）；复杂表达式
      // 回退旧语义（解析时刻对象引用 + 末段 key），行为不变。
      const read = () => (args.chain ? utils.getPath(args.root, args.chain) : args.data[args.key])
      const write = (v) => {
        if (args.chain) {
          utils.setPath(args.root, args.chain, v)
        } else {
          args.data[args.key] = v
        }
      }
      const initial = read()
      if (initial !== undefined && initial !== null) {
        delete originData[key]
      }
      watch(scope, read, (value) => {
        originData[key] = value
      })
      watch(scope, () => originData[key], () => {
        write(originData[key])
      })
    }
  })

  // setup 的 $watch 在 props 绑定完成后统一排空（v0.10.3 延迟队列）
  inst?.scope?.flushWatchQueue()

  let attrs = Array.from(bodyClone.attributes)
  attrs = applyTemplateAttrs(dom, bodyClone, attrs, originData, componentRuntime, ctx)
  return originData
}

// 模板属性应用单独成函数：bodyClone/attrs 只在直排代码中被引用，
// 若留在 setupRef 作用域内，会被该作用域内长寿命的 watch/$watch 闭包
// 共享的 context 提升并终生驻留（V8 闭包共享上下文语义）
function applyTemplateAttrs(dom, bodyClone, attrs, originData, componentRuntime, ctx) {
  attrs = attrs.filter(attr => {
    if (ctx.compileAttr(dom, attr.name, attr.value, originData, componentRuntime, ctx)) {
      bodyClone.removeAttribute(attr.name)
      return false
    }
    return true
  })
  attrs.forEach(attr => {
    if (attr.name === 'class') {
      dom.classList.add(...attr.value.trim().split(/\s+/))
    } else if (attr.name === 'style') {
      attr.value.split(';').forEach(stylePart => {
        const segments = stylePart.split(':')
        if (segments.length !== 2 || dom.style[segments[0]]) return
        const styleKey = segments[0].trim()
        const styleValue = segments[1].trim()
        if (styleKey.startsWith('--')) dom.style.setProperty(styleKey, styleValue)
        else dom.style[styleKey] = styleValue
      })
    } else if (!dom.getAttribute(attr.name)) {
      dom.setAttribute(attr.name, attr.value)
    }
  })
}

export function mountRef(dom, componentData, runtime, target, ctx) {
  const instance = instanceOf(dom, false)
  if (!instance?.scope) {
    if (instance) instance.scope = new ComponentScope(dom)
  }
  const sandboxOptions = instance?.unsafe ? { unsafe: true } : {}
  for (const script of target.scripts) {
    registerScriptLifecycle(script, dom, instance, componentData, runtime, sandboxOptions)
  }
}
