/*
 * loader.js — 模板加载器
 * Copyright (C) 2024 veypi <i@veypi.com>
 *
 * HTML 模板获取、缓存、DOMParser 解析、资源加载。
 * 合并原 vget.js，调用者直接 import templateLoader 使用。
 */

import vcss from './vcss.js'
import { withTimeout } from './utils.js'

// 网络操作超时（ms）：服务端 accept 后不响应时兜底，避免组件永久卡在 vparsing
const FETCH_TIMEOUT = 10000
const SCRIPT_TIMEOUT = 15000
import moduleContextManager, { normalizeScoped, resolveScopedUrl, getModulePath, mergeModulePatch } from './module.js'
import { prepareStaticUrlAttrs } from './compiler-attrs.js'

function normalizeFetchUrl(url, scoped = '') {
  if (!url || url === '/') return resolveScopedUrl('/', scoped)
  if (url.startsWith('@')) return url.slice(1)
  if (/^https?:\/\//.test(url) || url.startsWith('blob:')) return url
  if (!url.startsWith('/')) return resolveScopedUrl(`/${url}`, scoped)
  return resolveScopedUrl(url, scoped)
}

/**
 * scoped 前缀匹配器（clearScoped 用）。prefix 经 normalizeScoped 规范化后，
 * key 命中条件：精确等于 prefix、位于 prefix 目录下、或同形态挂在本源 origin
 * 下（模板缓存键存在 origin 相对路径与绝对 URL 两种形态）。文件级 prefix
 * （.../x.html）剥 .html 后同时匹配描述符级键（vref/URL 去 .html 形态）。
 * 匹配恒以整段边界（精确或后跟 '/'）收束——/pkg/a 不撞 /pkg/a2。
 */
function scopedPrefixMatcher(prefix) {
  const p = normalizeScoped(prefix || '')
  if (!p) return () => true
  const forms = p.endsWith('.html') ? [p, p.slice(0, -5)] : [p]
  const origin = typeof window !== 'undefined' && window.location ? window.location.origin : ''
  return (key) => {
    if (!key || typeof key !== 'string') return false
    for (const f of forms) {
      if (key === f || key.startsWith(f + '/')) return true
      if (origin && (key === origin + f || key.startsWith(origin + f + '/'))) return true
    }
    return false
  }
}

class CacheStore {
  constructor() {
    this.templates = new Map()
    this.pending = new Map()
  }
  clear() {
    this.templates.clear()
    this.pending.clear()
  }
}

class ResourceLoader {
  constructor() {
    this.loadedLinks = new Set()
    this.loadedScripts = new Set()
    this.loadedStyles = new Set()
  }

  resolveUrl(url, scoped) {
    return normalizeFetchUrl(url, scoped)
  }

  loadLink(dom, runtime) {
    const href = this.resolveUrl(dom.getAttribute('href'), getModulePath(runtime))
    const key = dom.getAttribute('key')
    const cacheKey = key || href
    if (!cacheKey || this.loadedLinks.has(cacheKey)) return
    this.loadedLinks.add(cacheKey)
    const link = dom.cloneNode(true)
    link.setAttribute('href', href)
    document.head.appendChild(link)
  }

  async loadScript(dom, runtime) {
    const src = this.resolveUrl(dom.getAttribute('src'), getModulePath(runtime))
    const key = dom.getAttribute('key')
    const cacheKey = key || src
    if (!cacheKey || this.loadedScripts.has(cacheKey)) return
    this.loadedScripts.add(cacheKey)
    const script = document.createElement('script')
    if (src) script.src = src
    if (key) script.setAttribute('key', key)
    script.type = dom.getAttribute('type') || 'text/javascript'
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        console.error(`[vhtml] Script load timeout: ${src}`)
        resolve()
      }, SCRIPT_TIMEOUT)
      script.onload = () => { clearTimeout(timer); resolve(script) }
      script.onerror = () => {
        clearTimeout(timer)
        console.error(`[vhtml] Failed to load external script: ${src}`)
        resolve()
      }
      document.head.appendChild(script)
    })
  }

  loadStyle(styleText, scopeUrl) {
    if (!styleText) return
    const cacheKey = `${scopeUrl}::${styleText}`
    if (this.loadedStyles.has(cacheKey)) return
    this.loadedStyles.add(cacheKey)
    const style = document.createElement('style')
    style.innerHTML = styleText
    style.setAttribute('vref', scopeUrl)
    document.head.appendChild(style)
  }

  async loadHeads(heads, runtime, descriptor, unsafe = false) {
    for (const node of heads) {
      const nodeName = node.nodeName.toLowerCase()
      if (nodeName === 'link') this.loadLink(node, runtime)
      else if (nodeName === 'script') {
        if (!unsafe) await this.loadScript(node, runtime)
      }
      else if (nodeName === 'title') descriptor.title = node.innerText
    }
  }

  /**
   * 按前缀回收 head 中由 loadStyle 注入的 <style vref> 节点并清去重集。
   * 样式文本内联于模板描述符，模块刷新后必须真移除——旧节点否则永久驻留
   * 并与新样式叠加冲突。link/script 是 URL 寻址的外部资源（浏览器缓存语义，
   * 同 URL 内容不变），去重集仍有效，不做移除/清空。
   */
  clearScopedStyles(matches) {
    for (const node of document.head.querySelectorAll('style[vref]')) {
      if (matches(node.getAttribute('vref'))) node.remove()
    }
    for (const key of [...this.loadedStyles]) {
      const sep = key.indexOf('::')
      const vref = sep === -1 ? key : key.slice(0, sep)
      if (matches(vref)) this.loadedStyles.delete(key)
    }
  }

  /** 全清样式（clear() 用）：移除全部 vref 样式节点并清空去重集 */
  clearStyles() {
    for (const node of document.head.querySelectorAll('style[vref]')) node.remove()
    this.loadedStyles.clear()
  }
}

class TemplateParser {
  constructor(resourceLoader) {
    this.resourceLoader = resourceLoader
  }

  createDescriptor(text, mod, url, scoped, doc) {
    return {
      url, scoped, mod,
      heads: Array.from(doc.querySelector('head')?.children || []),
      body: document.createElement('div'),
      setup: undefined,
      scripts: [],
      styles: '',
      title: '',
      txt: text,
      tmp: doc,
      customAttrs: {},
      err: null,
    }
  }

  processStyles(descriptor) {
    descriptor.tmp.querySelectorAll('style').forEach(styleNode => {
      if (styleNode.getAttribute('unscoped') === null) {
        descriptor.styles += vcss.parse(styleNode.innerHTML, descriptor.url)
      } else {
        descriptor.styles += styleNode.innerHTML
      }
    })
    this.resourceLoader.loadStyle(descriptor.styles, descriptor.url)
  }

  processBody(descriptor) {
    const bodyNode = descriptor.tmp.querySelector('body')
    if (!bodyNode) return
    descriptor.body.append(...bodyNode.childNodes)
    Array.from(bodyNode.attributes).forEach(attr => {
      if (/^[a-zA-Z]/.test(attr.name)) {
        descriptor.body.setAttribute(attr.name, attr.value)
      } else {
        descriptor.customAttrs[attr.name] = attr.value
      }
    })
    descriptor.body.setAttribute('vref', descriptor.url)
  }

  processScripts(descriptor) {
    // 脚本元素不驻留：提取为纯数据（code + 生命周期标记），
    // 避免每个模板缓存一份游离的 <script> DOM 节点
    descriptor.body.querySelectorAll('script').forEach(scriptNode => {
      const content = scriptNode.innerHTML.trim()
      if (!content) { scriptNode.remove(); return }
      const record = {
        code: scriptNode.innerHTML,
        setup: scriptNode.hasAttribute('setup'),
        active: scriptNode.hasAttribute('active'),
        deactive: scriptNode.hasAttribute('deactive'),
        dispose: scriptNode.hasAttribute('dispose'),
      }
      if (record.setup) descriptor.setup = record
      else if (!scriptNode.hasAttribute('no-vhtml')) descriptor.scripts.push(record)
      scriptNode.remove()
    })
  }

  syncRefOwnerId(dom, refId) {
    const children = dom.nodeName === 'TEMPLATE' && dom.content
      ? Array.from(dom.content.childNodes)
      : Array.from(dom.childNodes)
    children.forEach(node => {
      if (node.nodeType === 1) {
        node.setAttribute('vrefof', refId)
        this.syncRefOwnerId(node, refId)
      }
    })
  }

  async parse(text, mod, url, unsafe = false) {
    const doc = new DOMParser().parseFromString(text, 'text/html')
    const descriptor = this.createDescriptor(text, mod, url, getModulePath(mod), doc)
    this.processStyles(descriptor)
    this.processBody(descriptor)
    this.processScripts(descriptor)
    this.syncRefOwnerId(descriptor.body, url)
    prepareStaticUrlAttrs(descriptor.body, mod)
    await this.resourceLoader.loadHeads(descriptor.heads, mod, descriptor, unsafe)
    // 解析完成后 tmp 文档与 heads 不再使用，立即释放：
    // DOMParser 每模板产生一个独立文档，常驻会整棵驻留（含 head 内容与文档骨架）
    descriptor.heads = []
    descriptor.tmp = null
    return descriptor
  }

  create404Descriptor(url, mod, error) {
    console.error(`[vhtml] Component load failed: ${url}`, error?.message || error)
    const body = document.createElement('div')
    body.style.cssText = 'display:block;padding:8px 12px;margin:4px 0;' +
      'background:#fef2f2;border:1px solid #f87171;border-radius:4px;' +
      'color:#991b1b;font-size:13px;line-height:1.4;'
    body.textContent = `[Load Error] ${url}`
    return {
      url, scoped: getModulePath(mod), mod,
      heads: [], body, setup: undefined, scripts: [], styles: '', title: '',
      txt: '', tmp: null, customAttrs: {}, err: error,
    }
  }
}

class TemplateLoader {
  constructor(moduleManager = moduleContextManager) {
    this.moduleManager = moduleManager
    this.cache = new CacheStore()
    this.resourceLoader = new ResourceLoader()
    this.parser = new TemplateParser(this.resourceLoader)
    // 缓存代次：clear/clearScoped 时 +1。在途 fetch 捕获起始代次，完成写回前
    // 比对——代次已变说明中途被清，结果丢弃，防旧描述符回流缓存。
    this._epoch = 0
  }

  clear() {
    this._epoch++
    this.cache.clear()
    this.resourceLoader.clearStyles()
    this.moduleManager.clear()
  }

  /**
   * clearScoped(prefix) — 按 scoped 前缀使模板缓存失效（v0.10.5）：
   * 清理 templates/pending 中前缀命中的条目、回收 head 命中样式、并委托
   * moduleManager 清同前缀模块上下文。语义 = invalidation 非 HMR：已存活
   * 实例/已缓存路由页照旧运行旧代码，生效对象是之后的一切加载。
   * reload = clearScoped + 重新构建（路由页重新导航即重建）。
   */
  clearScoped(prefix) {
    const matches = scopedPrefixMatcher(prefix)
    this._epoch++
    for (const key of [...this.cache.templates.keys()]) {
      if (matches(key)) this.cache.templates.delete(key)
    }
    for (const key of [...this.cache.pending.keys()]) {
      if (matches(key)) this.cache.pending.delete(key)
    }
    this.resourceLoader.clearScopedStyles(matches)
    this.moduleManager.clearScoped(prefix)
  }

  async getModule(scoped) {
    return this.moduleManager.getModule(scoped)
  }

  readScopedHeaders(response) {
    const headers = {}
    for (const [key, value] of response.headers.entries()) {
      if (key.startsWith('vhtml-')) headers[key.slice(6)] = value
    }
    return headers
  }

  async fetchFile(url) {
    // cache: 'no-cache' = 与服务端协商（etag/Last-Modified），不直接吃浏览器缓存——
    // 否则 clearScoped 清了描述符缓存，重建时仍被 HTTP 缓存层喂旧文件（reload 失效
    // 的第二层根因）；304 由服务端 etag 消化，冷缓存 fetch 成本不增
    const response = await withTimeout(fetch(url, { headers: { 'X-No-Fallback': '1' }, cache: 'no-cache' }), FETCH_TIMEOUT, `fetch ${url}`)
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`)
    return response.text()
  }

  async parseUI(text, runtime, url, unsafe = false) {
    const descriptorUrl = url?.endsWith('.html') ? url.slice(0, -5) : (url || '#inline')
    const descriptorModule = await this.moduleManager.getModule(getModulePath(runtime))
    return this.parser.parse(text, descriptorModule, descriptorUrl, unsafe)
  }

  /**
   * 查询 url 对应已缓存描述符所属模块的 scoped（未缓存返回 null）。
   * 与 fetchUI 同一键公式（normalizeFetchUrl + runtime 模块路径），供 reload 前
   * 按模块根定位 clearScoped 前缀——文件级清会漏包内子组件，模块级清才是刷新语义。
   * 双键查找：先按传入 runtime 的模块路径，再试裸路径——fetch 发起方的模块路径
   * （vrouter 宿主）与页面解析后的运行时 scoped（响应头模块根）常不一致，单键
   * 反查必 miss（曾致 reload 退回文件级清、子组件旧样式残留）。
   */
  scopeOf(url, runtime = {}) {
    const keys = [
      normalizeFetchUrl(url, getModulePath(runtime)),
      normalizeFetchUrl(url, ''),
    ]
    for (const key of keys) {
      const scoped = this.cache.templates.get(key)?.scoped
      if (scoped !== undefined && scoped !== null) return scoped
    }
    return null
  }

  async fetchUI(url, runtime = {}, unsafe = false) {
    const fetchUrl = normalizeFetchUrl(url, getModulePath(runtime))
    if (this.cache.templates.has(fetchUrl)) return this.cache.templates.get(fetchUrl)
    if (this.cache.pending.has(fetchUrl)) return this.cache.pending.get(fetchUrl)
    const pending = this.doFetchUI(fetchUrl, unsafe, this._epoch)
    this.cache.pending.set(fetchUrl, pending)
    return pending.finally(() => this.cache.pending.delete(fetchUrl))
  }

  async doFetchUI(fetchUrl, unsafe = false, epoch = this._epoch) {
    try {
      const response = await withTimeout(fetch(fetchUrl, { headers: { 'X-No-Fallback': 1 }, cache: 'no-cache' }), FETCH_TIMEOUT, `fetch ${fetchUrl}`)
      if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`)
      const scopedHeaders = this.readScopedHeaders(response)
      const responseScoped = normalizeScoped(scopedHeaders.scoped || '')
      delete scopedHeaders.scoped
      const descriptorModule = await this.moduleManager.getModule(responseScoped)
      mergeModulePatch(descriptorModule, scopedHeaders)
      const text = await withTimeout(response.text(), FETCH_TIMEOUT, `read ${fetchUrl}`)
      const descriptorUrl = fetchUrl.endsWith('.html') ? fetchUrl.slice(0, -5) : fetchUrl
      const descriptor = await this.parser.parse(text, descriptorModule, descriptorUrl, unsafe)
      if (epoch === this._epoch) this.cache.templates.set(fetchUrl, descriptor)
      return descriptor
    } catch (error) {
      const fallbackModule = await this.moduleManager.getModule('')
      const descriptor = this.parser.create404Descriptor(fetchUrl, fallbackModule, error)
      if (epoch === this._epoch) this.cache.templates.set(fetchUrl, descriptor)
      return descriptor
    }
  }
}

export const templateLoader = new TemplateLoader()

export {
  normalizeFetchUrl,
  normalizeScoped,
  resolveScopedUrl,
  TemplateLoader,
}

export default templateLoader
