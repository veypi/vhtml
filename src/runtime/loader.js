import vcss from '../vcss.js'
import moduleEnvManager, { inferScopedFromUrl, normalizeScoped, resolveScopedUrl, scopedBaseURL } from './env.js'

function normalizeFetchUrl(url, scoped = '') {
  if (!url || url === '/') {
    return resolveScopedUrl('/', scoped)
  }
  if (url.startsWith('@')) {
    return url.slice(1)
  }
  if (/^https?:\/\//.test(url)) {
    return url
  }
  if (!url.startsWith('/')) {
    return resolveScopedUrl(`/${url}`, scoped)
  }
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

  loadLink(dom, env) {
    const href = this.resolveUrl(dom.getAttribute('href'), env?.scoped)
    const key = dom.getAttribute('key')
    const cacheKey = key || href
    if (!cacheKey || this.loadedLinks.has(cacheKey)) {
      return
    }
    this.loadedLinks.add(cacheKey)
    const link = dom.cloneNode(true)
    link.setAttribute('href', href)
    document.head.appendChild(link)
  }

  async loadScript(dom, env) {
    const src = this.resolveUrl(dom.getAttribute('src'), env?.scoped)
    const key = dom.getAttribute('key')
    const cacheKey = key || src
    if (!cacheKey || this.loadedScripts.has(cacheKey)) {
      return
    }
    this.loadedScripts.add(cacheKey)
    const script = document.createElement('script')
    if (src) {
      script.src = src
    }
    if (key) {
      script.setAttribute('key', key)
    }
    script.type = dom.getAttribute('type') || 'text/javascript'
    await new Promise((resolve, reject) => {
      script.onload = () => resolve(script)
      script.onerror = () => reject(new Error(`Failed to load script ${src}`))
      document.head.appendChild(script)
    })
  }

  loadStyle(styleText, scopeUrl) {
    if (!styleText) {
      return
    }
    const cacheKey = `${scopeUrl}::${styleText}`
    if (this.loadedStyles.has(cacheKey)) {
      return
    }
    this.loadedStyles.add(cacheKey)
    const style = document.createElement('style')
    style.innerHTML = styleText
    style.setAttribute('vref', scopeUrl)
    document.head.appendChild(style)
  }

  async loadHeads(heads, env, descriptor) {
    for (const node of heads) {
      const nodeName = node.nodeName.toLowerCase()
      if (nodeName === 'link') {
        this.loadLink(node, env)
      } else if (nodeName === 'script') {
        await this.loadScript(node, env)
      } else if (nodeName === 'title') {
        descriptor.title = node.innerText
      }
    }
  }
}

class TemplateParser {
  constructor(resourceLoader) {
    this.resourceLoader = resourceLoader
  }

  createDescriptor(text, env, url, scoped, doc) {
    return {
      url,
      scoped,
      env,
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
    descriptor.tmp.querySelectorAll('style').forEach((styleNode) => {
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
    if (!bodyNode) {
      return
    }
    descriptor.body.append(...bodyNode.childNodes)
    Array.from(bodyNode.attributes).forEach((attr) => {
      if (/^[a-zA-Z]/.test(attr.name)) {
        descriptor.body.setAttribute(attr.name, attr.value)
      } else {
        descriptor.customAttrs[attr.name] = attr.value
      }
    })
    descriptor.body.setAttribute('vref', descriptor.url)
  }

  processScripts(descriptor) {
    descriptor.body.querySelectorAll('script').forEach((scriptNode) => {
      const content = scriptNode.innerHTML.trim()
      if (!content) {
        scriptNode.remove()
        return
      }
      if (scriptNode.hasAttribute('setup')) {
        descriptor.setup = scriptNode
      } else if (!scriptNode.hasAttribute('no-vhtml')) {
        descriptor.scripts.push(scriptNode)
      }
      scriptNode.remove()
    })
  }

  syncRefOwnerId(dom, refId) {
    Array.from(dom.childNodes).forEach((node) => {
      if (node.nodeType === 1) {
        node.setAttribute('vrefof', refId)
        this.syncRefOwnerId(node, refId)
      }
    })
  }

  async parse(text, env, url, ignoreScoped = false) {
    const doc = new DOMParser().parseFromString(text, 'text/html')
    if (doc.body.hasAttribute('scoped') && !ignoreScoped) {
      throw new Error('HTTP error! status: 404')
    }
    const descriptor = this.createDescriptor(text, env, url, env?.scoped || '', doc)
    this.processStyles(descriptor)
    this.processBody(descriptor)
    this.processScripts(descriptor)
    this.syncRefOwnerId(descriptor.body, url)
    if (!ignoreScoped) {
      await this.resourceLoader.loadHeads(descriptor.heads, env, descriptor)
    }
    return descriptor
  }

  create404Descriptor(url, env, error) {
    const body = document.createElement('div')
    body.style.cssText = 'background:#aaa;height:100%;width:100%;display:grid;place-items:center;'
    body.innerHTML = `<div style="width:20rem;height:15rem;border-radius:1rem;padding:1rem;background:#cfc0aa;display:grid;place-items:center;"><div style="font-size:2rem">404</div><p>${url}</p></div>`
    return {
      url,
      scoped: env?.scoped || '',
      env,
      heads: [],
      body,
      setup: undefined,
      scripts: [],
      styles: '',
      title: '',
      txt: '',
      tmp: null,
      customAttrs: {},
      err: error,
    }
  }
}

class TemplateLoader {
  constructor(envManager = moduleEnvManager) {
    this.envManager = envManager
    this.cache = new CacheStore()
    this.resourceLoader = new ResourceLoader()
    this.parser = new TemplateParser(this.resourceLoader)
  }

  clear() {
    this.cache.clear()
    this.envManager.clear()
  }

  addWrapper(wrapper) {
    this.envManager.addWrapper(wrapper)
  }

  async getEnv(scoped, temp) {
    return this.envManager.getEnv(scoped, temp)
  }

  async fetchFile(url) {
    const response = await fetch(url)
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`)
    }
    return response.text()
  }

  async parseUI(text, env, url, ignoreScoped = false) {
    const descriptorUrl = url?.endsWith('.html') ? url.slice(0, -5) : (url || '#inline')
    const inferredScoped = normalizeScoped(env?.scoped || inferScopedFromUrl(descriptorUrl) || '')
    const descriptorEnv = await this.envManager.getEnv(inferredScoped, { ...(env || {}), scoped: inferredScoped })
    return this.parser.parse(text, descriptorEnv, descriptorUrl, ignoreScoped)
  }

  async fetchUI(url, env = {}, ignoreScoped = false) {
    const fetchUrl = normalizeFetchUrl(url, env?.scoped)
    if (this.cache.templates.has(fetchUrl)) {
      return this.cache.templates.get(fetchUrl)
    }
    if (this.cache.pending.has(fetchUrl)) {
      return this.cache.pending.get(fetchUrl)
    }
    const pending = this.doFetchUI(fetchUrl, env, ignoreScoped)
    this.cache.pending.set(fetchUrl, pending)
    return pending.finally(() => {
      this.cache.pending.delete(fetchUrl)
    })
  }

  async doFetchUI(fetchUrl, tempEnv = {}, ignoreScoped = false) {
    tempEnv = tempEnv || {}
    let scopedHeaders = {}
    const inferredScoped = inferScopedFromUrl(fetchUrl)
    try {
      const response = await fetch(fetchUrl)
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`)
      }
      for (const [key, value] of response.headers.entries()) {
        if (key.startsWith('vhtml-')) {
          scopedHeaders[key.slice(6)] = value
        }
      }
      const responseScoped = normalizeScoped(scopedHeaders.scoped || tempEnv.scoped || inferredScoped || '')
      const descriptorEnv = await this.envManager.getEnv(responseScoped, { ...tempEnv, ...scopedHeaders, scoped: responseScoped })
      const text = await response.text()
      const descriptorUrl = fetchUrl.endsWith('.html') ? fetchUrl.slice(0, -5) : fetchUrl
      const descriptor = await this.parser.parse(text, descriptorEnv, descriptorUrl, ignoreScoped)
      this.cache.templates.set(fetchUrl, descriptor)
      return descriptor
    } catch (error) {
      const fallbackScoped = normalizeScoped(scopedHeaders.scoped || tempEnv.scoped || inferredScoped || '')
      const fallbackEnv = await this.envManager.getEnv(fallbackScoped, { ...tempEnv, ...scopedHeaders, scoped: fallbackScoped })
      const descriptor = this.parser.create404Descriptor(fetchUrl, fallbackEnv, error)
      this.cache.templates.set(fetchUrl, descriptor)
      return descriptor
    }
  }
}

const templateLoader = new TemplateLoader()

export {
  normalizeFetchUrl,
  normalizeScoped,
  resolveScopedUrl,
  scopedBaseURL,
  TemplateLoader,
  templateLoader,
}

export default templateLoader
