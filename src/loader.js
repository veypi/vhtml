/* Template loading: fetch → inert descriptor → prepare module dependencies. */
import { moduleRecord } from './execution/context.js'
import {
  readModuleMeta,
  moduleIdentity,
  normalizeScoped,
  getModulePath,
  resourcesFor,
  resourceKey,
  resourceMatcher,
  platformResources,
} from './resource.js'
import { bumpImportEpoch } from './imports.js'
import moduleContextManager from './module.js'
import vcss from './vcss.js'
import { withTimeout } from './utils.js'
import { prepareStaticUrlAttrs } from './compiler-attrs.js'
import { normalizeTemplate } from './template-normalize.js'

const FETCH_TIMEOUT = 10000

// Keep DOM/CSS references compact; descriptor URLs remain canonical for
// caching, module boundaries and relative imports. Foreign origins stay distinct.
// templateRef 的单一出口在 url.js（loader 不再转手出口）。
import { templateRef } from './url.js'

class ResourceLoader {
  loadedLinks = new Set()
  loadedStyles = new Set()
  #styleNodes = new Map()  // key → style 节点（片段样式释放用）
  #styleRefs = new Map()   // key → 引用计数（组件与片段可共享同一文件样式）

  loadStyle(text, source) {
    if (!text) return
    const url = new URL(source, window.location.origin).href
    const key = `${url}::${text}`
    this.#styleRefs.set(key, (this.#styleRefs.get(key) || 0) + 1)
    if (this.loadedStyles.has(key)) return
    this.loadedStyles.add(key)
    const style = document.createElement('style')
    style.textContent = text
    style.setAttribute('vref', templateRef(url))
    document.head.appendChild(style)
    this.#styleNodes.set(key, style)
  }

  // 片段规则删除时释放（V2 新增生命周期成本；组件装载永不调）。
  // 计数归零才摘节点——同一文件被组件挂载与片段规则共用时互不受影响
  releaseStyle(text, source) {
    if (!text) return
    const url = new URL(source, window.location.origin).href
    const key = `${url}::${text}`
    const n = (this.#styleRefs.get(key) || 0) - 1
    if (n > 0) {
      this.#styleRefs.set(key, n)
      return
    }
    this.#styleRefs.delete(key)
    this.loadedStyles.delete(key)
    this.#styleNodes.get(key)?.remove()
    this.#styleNodes.delete(key)
  }

  clearScopedStyles(matches) {
    for (const node of document.head.querySelectorAll('style[vref]')) {
      if (matches(node.getAttribute('vref'))) node.remove()
    }
    for (const key of this.loadedStyles) {
      if (matches(key.slice(0, key.indexOf('::')))) {
        this.loadedStyles.delete(key)
        this.#styleRefs.delete(key)
        this.#styleNodes.delete(key)
      }
    }
  }

  clearStyles() {
    this.clearScopedStyles(() => true)
  }

  async prepare(descriptor, assertCurrent) {
    assertCurrent?.()
    const { resources, execution, meta } = moduleRecord(descriptor.mod)
    for (const script of [descriptor.setup, ...descriptor.scripts]) {
      if (!script?.src) continue
      script.code = await resources.text(script.src, { from: descriptor.url })
      assertCurrent?.()
      script.source = resources.resolve(script.src, {
        from: descriptor.url,
      }).href
    }
    this.loadStyle(descriptor.styles, descriptor.url)
    for (const head of descriptor.heads) {
      if (head.tag === 'script') {
        if (head.src)
          await execution.externalScript(
            resources.resolve(head.src).href,
            head.type
          )
        else if (head.code)
          await execution.script(head.code, descriptor.url, descriptor.mod)
      } else if (head.tag === 'link') {
        const href = resources.resolve(head.href).href
        if (meta.unsafe) {
          if (head.rel !== 'stylesheet')
            throw new Error(
              'Only module stylesheets are supported in sandbox heads'
            )
          const text = await resources.text(href)
          assertCurrent?.()
          const css = await execution.render.style(text)
          assertCurrent?.()
          this.loadStyle(
            execution.render.scopeStyles(
              vcss.parse(css, descriptor.ref),
              descriptor.ref
            ),
            descriptor.url
          )
        } else if (!this.loadedLinks.has(href)) {
          const link = document.createElement('link')
          for (const [name, value] of head.attrs) link.setAttribute(name, value)
          link.href = href
          this.loadedLinks.add(href)
          document.head.appendChild(link)
        }
      }
      assertCurrent?.()
    }
    descriptor.heads = []
    return descriptor
  }
}

// This parser never fetches dependencies, evaluates code or modifies the live document.
class TemplateParser {
  parse(text, mod, url, opts = {}) {
    const ref = templateRef(url)
    const doc = new DOMParser().parseFromString(text, 'text/html')
    const descriptor = {
      url,
      ref,
      scoped: getModulePath(mod),
      mod,
      body: document.createElement('div'),
      setup: null,
      scripts: [],
      styles: '',
      title: doc.querySelector('title')?.textContent || '',
      customAttrs: {},
      heads: [],
    }
    doc.querySelectorAll('style').forEach((node) => {
      const css = node.textContent || ''
      if (opts.fragment) {
        // 片段样式（用户空间）：unscoped **不生效**——一律按片段自身 ref 作用域化；
        // 且禁 @import/@charset/外链（片段不得出网改全局样式）
        const bad = fragmentStyleProblem(css)
        if (bad) throw new Error(`slot fragment style: ${bad}`)
        descriptor.styles += vcss.parse(css, ref)
      } else {
        descriptor.styles += node.hasAttribute('unscoped') ? css : vcss.parse(css, ref)
      }
      node.remove()
    })
    for (const node of doc.querySelectorAll('script')) {
      const src =
        node.getAttribute('data-vhtml-src') || node.getAttribute('src')
      const script = {
        code: node.textContent.trim(),
        src,
        source: url,
        setup: node.hasAttribute('setup'),
        active: node.hasAttribute('active'),
        deactive: node.hasAttribute('deactive'),
        dispose: node.hasAttribute('dispose'),
      }
      if (
        node.parentElement?.tagName === 'HEAD' &&
        ![script.setup, script.active, script.deactive, script.dispose].some(
          Boolean
        )
      ) {
        descriptor.heads.push({
          tag: 'script',
          src,
          code: script.code,
          type: node.getAttribute('type') || 'text/javascript',
        })
      } else if (script.setup) descriptor.setup = script
      else if (!node.hasAttribute('no-vhtml')) descriptor.scripts.push(script)
      node.remove()
    }
    for (const node of doc.head.querySelectorAll('link')) {
      descriptor.heads.push({
        tag: 'link',
        href: node.getAttribute('data-vhtml-href') || node.getAttribute('href'),
        rel: node.getAttribute('rel'),
        attrs: Array.from(node.attributes, (attr) => [attr.name, attr.value]),
      })
    }
    const body = doc.body
    descriptor.body.append(...body.childNodes)
    for (const attr of body.attributes) {
      if (/^[a-zA-Z]/.test(attr.name))
        descriptor.body.setAttribute(attr.name, attr.value)
      else descriptor.customAttrs[attr.name] = attr.value
    }
    descriptor.body.setAttribute('vref', ref)
    normalizeTemplate(descriptor.body)
    const mark = (node) => {
      for (const child of (node.content || node).childNodes) {
        if (child.nodeType !== 1) continue
        child.setAttribute('vrefof', ref)
        mark(child)
      }
    }
    mark(descriptor.body)
    prepareStaticUrlAttrs(descriptor.body, mod)
    return descriptor
  }
}

export class TemplateLoader {
  constructor(moduleManager = moduleContextManager) {
    this.moduleManager = moduleManager
    this.cache = new Map()
    this.resourceLoader = new ResourceLoader()
    this.parser = new TemplateParser()
  }

  clear() {
    bumpImportEpoch()
    this.cache.clear()
    this.resourceLoader.clearStyles()
    this.moduleManager.clear()
  }

  clearScoped(prefix, { keepLive = false } = {}) {
    const matches = resourceMatcher(prefix)
    bumpImportEpoch()
    for (const key of this.cache.keys()) if (matches(key)) this.cache.delete(key)
    if (keepLive) return
    this.resourceLoader.clearScopedStyles(matches)
    this.moduleManager.clearScoped(prefix)
  }

  getModule(scoped) {
    return this.moduleManager.getModule(scoped)
  }

  async prepare(text, mod, url, assertCurrent) {
    assertCurrent?.()
    const render = moduleRecord(mod)?.execution.render
    if (render) text = await render.html(text)
    assertCurrent?.()
    const descriptor = this.parser.parse(text, mod, url)
    if (render) descriptor.styles = render.scopeStyles(descriptor.styles, descriptor.ref)
    return this.resourceLoader.prepare(descriptor, assertCurrent)
  }

  async parseUI(text, runtime, url) {
    const mod =
      runtime?.$mod ||
      (await this.moduleManager.getModule(getModulePath(runtime)))
    const source = resourceKey(url || '#inline', mod)
    return this.prepare(text, mod, source)
  }

  scopeOf(url, runtime) {
    return this.cache.get(resourceKey(url, runtime))?.descriptor?.scoped ?? null
  }

  async fetchUI(url, runtime = {}) {
    const owner = moduleRecord(runtime)
    const fetchUrl = resourceKey(url, runtime)
    let entry = this.cache.get(fetchUrl)
    const assertCurrent = () => {
      if (this.cache.get(fetchUrl) !== entry)
        throw new Error('Template load invalidated')
    }
    if (!entry) {
      entry = { ready: null, descriptor: null }
      this.cache.set(fetchUrl, entry)
      // Publish one identity before any async work, just like module records.
      entry.ready = Promise.resolve().then(async () => {
        try {
          assertCurrent()
          const descriptor = await this.doFetchUI(
            fetchUrl, resourcesFor(runtime), owner, assertCurrent
          )
          assertCurrent()
          entry.descriptor = descriptor
          return descriptor
        } catch (error) {
          if (this.cache.get(fetchUrl) === entry) this.cache.delete(fetchUrl)
          throw error
        }
      })
    }
    const descriptor = await entry.ready
    assertCurrent()
    if (owner?.meta.unsafe && descriptor.mod !== owner.mod)
      throw new Error('Isolated modules cannot load another module')
    return descriptor
  }

  // ---- slot override 片段装载（V2）----
  // 闸门 1：惰性模板管道——parser.parse 出描述符（body 为模板），不走 prepare()
  //（setup/script/heads 永不执行）；style 走片段自身 ref 的 vcss 作用域注入
  //（2026-10-21 拍板：片段自身作用域，非宿主）。
  //
  // 片段落点 = 平台根绝对（注册期解析，开放问题 9）：缓存键 / 样式释放键 /
  // 解析源三者统一为同一个 source。片段按**根模块**上下文解析（与消费模块
  // 无关）→ 缓存内容不随消费方变化。
  #fragments = new Map()   // source → { ready: Promise, record: null|fragment, error: null }

  // 就绪探针（同步，parseSlots 渲染判定用）：已装载返回片段记录，否则 null
  fragmentStateOf(source) {
    return this.#fragments.get(source)?.record || null
  }

  // 失败态探针：片段装载失败记住失败态（不反复重试），宿主侧给错误占位
  fragmentErrorOf(source) {
    return this.#fragments.get(source)?.error || null
  }

  fetchFragment(source) {
    let entry = this.#fragments.get(source)
    if (entry) return entry.ready
    entry = { ready: null, record: null, error: null }
    entry.ready = Promise.resolve().then(async () => {
      const record = await this.#doFetchFragment(source)
      entry.record = record
      return record
    })
    // 失败态记住：条目留在表里 → 后续渲染不再重试（坏片段每次重渲都打网络）
    entry.ready.catch((error) => {
      entry.error = error
      console.warn('[vhtml] slot override fragment failed:', source, error)
    })
    this.#fragments.set(source, entry)
    return entry.ready
  }

  async #doFetchFragment(source) {
    const mod = await this.moduleManager.getModule('')   // 根模块上下文
    const lease = await platformResources().open(source, {
      headers: { 'X-No-Fallback': '1' },
      cache: 'no-cache',
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    })
    try {
      const response = lease.response
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${source}`)
      const descriptor = this.parser.parse(await response.text(), mod, source, { fragment: true })
      const problem = fragmentPurityProblem(descriptor.body)
      if (problem)
        throw new Error(`slot fragment "${source}": ${problem}（纯结构闸门：片段禁数据绑定）`)
      if (descriptor.setup || descriptor.scripts.length || descriptor.heads.length)
        console.warn('[vhtml] slot fragment scripts/heads are never executed:', source)
      this.resourceLoader.loadStyle(descriptor.styles, source)
      return {
        ref: descriptor.ref,
        url: source,
        styleText: descriptor.styles,
        templates: Array.from(descriptor.body.childNodes),
      }
    } finally {
      lease.release()
    }
  }

  // 规则删除/作用域清理时释放：清片段缓存 + 样式计数释放（同文件被组件挂载
  // 共用时计数保护不受影响）。键 = 片段 source（与装载同一把钥匙）
  releaseFragment(source) {
    const entry = this.#fragments.get(source)
    if (!entry) return
    this.#fragments.delete(source)
    entry.ready
      .then((frag) => {
        if (frag?.styleText) this.resourceLoader.releaseStyle(frag.styleText, frag.url)
      })
      .catch(() => {})
  }

  async doFetchUI(fetchUrl, resources, owner, assertCurrent) {
    const lease = await resources.open(fetchUrl, {
      headers: { 'X-No-Fallback': '1' },
      cache: 'no-cache',
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    })
    try {
      assertCurrent()
      const response = lease.response
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${fetchUrl}`)
      const scoped = normalizeScoped(
        response.headers.get('vhtml-scoped') ??
          (owner?.meta.unsafe ? owner.meta.scoped : '')
      )
      if (
        owner?.meta.unsafe &&
        moduleIdentity(scoped, owner.meta.origin).root !== owner.meta.root
      )
        throw new Error('Isolated modules cannot load another module')
      const metadata =
        this.moduleManager.moduleMetadata.get(scoped) ||
        readModuleMeta(response, fetchUrl)
      const patch = {}
      for (const [key, value] of response.headers.entries())
        if (
          key.startsWith('vhtml-') &&
          !['vhtml-scoped', 'vhtml-unsafe'].includes(key)
        )
          patch[key.slice(6)] = value
      const mod = await this.moduleManager.getModule(scoped, metadata, patch)
      assertCurrent()
      const text = await withTimeout(
        response.text(),
        FETCH_TIMEOUT,
        `read ${fetchUrl}`
      )
      assertCurrent()
      return await this.prepare(text, mod, fetchUrl, assertCurrent)
    } finally {
      lease.release()
    }
  }
}

// ---- slot override 片段（V2 闸门，profile.md §2）----
// 闸门 2：纯结构片段——禁一切数据绑定（{{ }}、:/@/v: 指令属性）。
// 组件标签允许（自身带独立数据域）；嵌套 vslot 不允许（投影链不穿越片段）。
//
// 指令面清单按 vhtml 源码实读维护（2026-10-22 复核）：
//   ':x'  单向属性绑定        '@x'  事件绑定
//   'v:x' 双向绑定（component.js 的 v:${key} props 双向；compiler-attrs 的 v: 前缀）
//   'v-if' / 'v-else-if' / 'v-else' / 'v-for' / 'v-show' / 'v-html' / 'v-whitespace'
//   'vbind'（slots.js：把宿主数据绑进槽）、'vslot'（嵌套投影）
// 注意：'v-model' / 'v-bind' / 'v-slot' / 'v-cloak' 在 vhtml 中**不存在**
//（写进黑名单只会给人「已覆盖」的错觉），故不列。
const FRAGMENT_BIND_ATTR =
  /^[:@]|^v:|^v-(if|else-if|else|for|show|html|whitespace)$|^vbind$|^vslot$/
// 主动内容：内联事件处理器 + 可嵌入文档/可导航元素（同源不防脚本执行）
const FRAGMENT_ACTIVE_ATTR = /^on/i
const FRAGMENT_ACTIVE_TAG = new Set([
  'iframe', 'object', 'embed', 'form', 'base', 'meta', 'link', 'srcdoc',
])
// URL 属性：scheme 危险则片段里一按即在页面 origin 执行
const FRAGMENT_URL_ATTRS = new Set([
  'href', 'src', 'action', 'formaction', 'xlink:href', 'poster', 'data', 'background',
])
const FRAGMENT_DANGEROUS_SCHEME_RE = /^\s*(javascript|vbscript)\s*:/i
const FRAGMENT_DANGEROUS_DATA_RE = /^\s*data\s*:\s*text\/html/i

// 片段 URL 值检查（返回问题描述或 null）
function fragmentUrlProblem(attrName, value) {
  const raw = String(value == null ? '' : value)
  const candidates = attrName === 'srcset'
    ? raw.split(',').map((s) => s.trim().split(/\s+/)[0]).filter(Boolean)
    : [raw]
  for (const c of candidates) {
    if (FRAGMENT_DANGEROUS_SCHEME_RE.test(c))
      return `dangerous URL scheme in attribute "${attrName}"`
    if (FRAGMENT_DANGEROUS_DATA_RE.test(c))
      return `dangerous data: URL in attribute "${attrName}"`
  }
  return null
}

// 片段样式检查：禁 @import/@charset（拉外链）与外链 url()（出网改全局样式）
// 注：style 节点在 parse 阶段已被摘除 → 纯结构闸门看不到它，样式约束在此做。
const FRAGMENT_STYLE_AT_RULE_RE = /@(import|charset)\b/i
const FRAGMENT_STYLE_EXTERNAL_URL_RE = /url\(\s*['"]?\s*(https?:|\/\/)/i
export function fragmentStyleProblem(css) {
  const text = String(css || '')
  if (FRAGMENT_STYLE_AT_RULE_RE.test(text))
    return 'style must not use @import/@charset'
  if (FRAGMENT_STYLE_EXTERNAL_URL_RE.test(text))
    return 'style must not reference external URLs'
  return null
}

export function fragmentPurityProblem(root) {
  const walk = (node) => {
    if (node.nodeType === 3)
      return /\{\{[\s\S]*?\}\}/.test(node.textContent || '') ? 'text binding {{ }}' : null
    if (node.nodeType !== 1) return null
    const tag = (node.tagName || '').toLowerCase()
    if (FRAGMENT_ACTIVE_TAG.has(tag))
      return `active element <${tag}>`
    for (const attr of node.attributes || []) {
      if (FRAGMENT_BIND_ATTR.test(attr.name))
        return `binding attribute "${attr.name}"`
      if (FRAGMENT_ACTIVE_ATTR.test(attr.name))
        return `inline handler attribute "${attr.name}"`
      if (attr.name === 'srcdoc') return 'inline document attribute "srcdoc"'
      if (FRAGMENT_URL_ATTRS.has(attr.name) || attr.name === 'srcset') {
        const bad = fragmentUrlProblem(attr.name, attr.value)
        if (bad) return bad
      }
    }
    for (const child of node.childNodes) {
      const p = walk(child)
      if (p) return p
    }
    return null
  }
  for (const child of root.childNodes) {
    const p = walk(child)
    if (p) return p
  }
  return null
}

export const templateLoader = new TemplateLoader()

// slot 规则删除 → 片段样式释放（module.js 不反向依赖 loader，钩子在此装配）
moduleContextManager.fragmentRelease = (url) => templateLoader.releaseFragment(url)
export default templateLoader
