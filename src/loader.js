/*
 * loader.js — 模板加载器
 * Copyright (C) 2024 veypi <i@veypi.com>
 *
 * HTML 模板获取、缓存、DOMParser 解析、资源加载。
 * 合并原 vget.js，调用者直接 import templateLoader 使用。
 */

import vcss from './vcss.js'
import moduleContextManager, { normalizeScoped, resolveScopedUrl, getModulePath, mergeModulePatch } from './module.js'

function normalizeFetchUrl(url, scoped = '') {
  if (!url || url === '/') return resolveScopedUrl('/', scoped)
  if (url.startsWith('@')) return url.slice(1)
  if (/^https?:\/\//.test(url)) return url
  if (!url.startsWith('/')) return resolveScopedUrl(`/${url}`, scoped)
  return resolveScopedUrl(url, scoped)
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
      script.onload = () => resolve(script)
      script.onerror = () => {
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
    descriptor.body.querySelectorAll('script').forEach(scriptNode => {
      const content = scriptNode.innerHTML.trim()
      if (!content) { scriptNode.remove(); return }
      if (scriptNode.hasAttribute('setup')) descriptor.setup = scriptNode
      else if (!scriptNode.hasAttribute('no-vhtml')) descriptor.scripts.push(scriptNode)
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

  async parse(text, mod, url, ignoreScoped = false, unsafe = false) {
    const doc = new DOMParser().parseFromString(text, 'text/html')
    if (doc.body.hasAttribute('scoped') && !ignoreScoped) {
      throw new Error('HTTP error! status: 404')
    }
    const descriptor = this.createDescriptor(text, mod, url, getModulePath(mod), doc)
    this.processStyles(descriptor)
    this.processBody(descriptor)
    this.processScripts(descriptor)
    this.syncRefOwnerId(descriptor.body, url)
    if (!ignoreScoped) {
      await this.resourceLoader.loadHeads(descriptor.heads, mod, descriptor, unsafe)
    }
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
  }

  clear() {
    this.cache.clear()
    this.moduleManager.clear()
  }

  addWrapper(wrapper) {
    this.moduleManager.addWrapper(wrapper)
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
    const response = await fetch(url, { headers: { 'X-No-Fallback': '1' } })
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`)
    return response.text()
  }

  async parseUI(text, runtime, url, ignoreScoped = false, unsafe = false) {
    const descriptorUrl = url?.endsWith('.html') ? url.slice(0, -5) : (url || '#inline')
    const descriptorModule = await this.moduleManager.getModule(getModulePath(runtime))
    return this.parser.parse(text, descriptorModule, descriptorUrl, ignoreScoped, unsafe)
  }

  async fetchUI(url, runtime = {}, ignoreScoped = false, unsafe = false) {
    const fetchUrl = normalizeFetchUrl(url, getModulePath(runtime))
    if (this.cache.templates.has(fetchUrl)) return this.cache.templates.get(fetchUrl)
    if (this.cache.pending.has(fetchUrl)) return this.cache.pending.get(fetchUrl)
    const pending = this.doFetchUI(fetchUrl, ignoreScoped, unsafe)
    this.cache.pending.set(fetchUrl, pending)
    return pending.finally(() => this.cache.pending.delete(fetchUrl))
  }

  async doFetchUI(fetchUrl, ignoreScoped = false, unsafe = false) {
    try {
      let params = {}
      if (!ignoreScoped) {
        params = { headers: { 'X-No-Fallback': 1 } }
      } else {
        params = { headers: { 'accept': 'text/html' } }
      }
      const response = await fetch(fetchUrl, params)
      if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`)
      const scopedHeaders = this.readScopedHeaders(response)
      const responseScoped = normalizeScoped(scopedHeaders.scoped || '')
      delete scopedHeaders.scoped
      const descriptorModule = await this.moduleManager.getModule(responseScoped)
      mergeModulePatch(descriptorModule, scopedHeaders)
      const text = await response.text()
      const descriptorUrl = fetchUrl.endsWith('.html') ? fetchUrl.slice(0, -5) : fetchUrl
      const descriptor = await this.parser.parse(text, descriptorModule, descriptorUrl, ignoreScoped, unsafe)
      this.cache.templates.set(fetchUrl, descriptor)
      return descriptor
    } catch (error) {
      const fallbackModule = await this.moduleManager.getModule('')
      const descriptor = this.parser.create404Descriptor(fetchUrl, fallbackModule, error)
      this.cache.templates.set(fetchUrl, descriptor)
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
