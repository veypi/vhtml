/*
 * vget.js
 * Copyright (C) 2024 veypi <i@veypi.com>
 *
 * Distributed under terms of the MIT license.
 */
import EventBus from './vbus.js';
import axios from './axios.min.js'
import vcss from './vcss.js'
import vproxy from './vproxy.js';
import vmessage from './vmessage.js'
import i18n from './i18n.js'

/**
 * 环境管理器 - 负责管理不同 scoped 的环境变量
 */
class EnvManager {
  constructor() {
    this.envMap = new Map()
    this.i18nLocale = vproxy.Wrap({
      locale: localStorage.getItem('i18n_locale') || 'zh-CN',
      fallback: 'en-US'
    })
    this.initI18nWatcher()
  }

  initI18nWatcher() {
    vproxy.Watch(() => {
      localStorage.setItem('i18n_locale', this.i18nLocale.locale)
    })
  }

  /**
   * 获取或创建环境变量
   * @param {string} scoped - 作用域标识
   * @param {Object} temp - 临时配置
   * @returns {Promise<Object>} 环境变量对象
   */
  async getEnv(scoped = '', temp = {}) {
    if (this.envMap.has(scoped)) {
      return this.envMap.get(scoped)
    }

    const env = await this.createEnv(scoped, temp)
    this.envMap.set(scoped, env)
    return env
  }

  async createEnv(scoped, temp) {
    const baseURL = scoped.startsWith('http') ? scoped : window.location.origin + scoped
    const env = {
      scoped,
      ...temp,
      $bus: new EventBus(),
      $axios: axios.create({ baseURL }),
      $i18n: new i18n(this.i18nLocale),
      $message: vmessage,
      $router: null,
      $emit: null,
      $router: $vhtml.$router,
    }

    env.$t = (key, params = {}) => env.$i18n.t(key, params)

    await this.loadEnvConfig(env, baseURL)
    return env
  }

  async loadEnvConfig(env, baseURL) {
    try {
      const envModule = await import(baseURL + '/env.js')
      await envModule.default(env, this)
    } catch (e) {
      console.warn(`error loading ${baseURL}/env.js: ${e}`)
    }
  }

  clear() {
    this.envMap.clear()
  }
}

/**
 * 缓存管理器 - 管理 URL 缓存和请求去重
 */
class CacheManager {
  constructor() {
    this.urlCache = new Map()
    this.pendingRequests = new Map()
    this.baseFileContent = ''
  }

  get(url) {
    return this.urlCache.get(url)
  }

  has(url) {
    return this.urlCache.has(url)
  }

  set(url, data) {
    this.urlCache.set(url, data)
  }

  getPending(url) {
    return this.pendingRequests.get(url)
  }

  hasPending(url) {
    return this.pendingRequests.has(url)
  }

  setPending(url, promise) {
    this.pendingRequests.set(url, promise)
  }

  deletePending(url) {
    this.pendingRequests.delete(url)
  }

  setBaseFile(content) {
    if (!this.baseFileContent) {
      this.baseFileContent = content
    }
  }

  isBaseFile(content) {
    return this.baseFileContent === content
  }

  clear() {
    this.urlCache.clear()
    this.pendingRequests.clear()
    this.baseFileContent = ''
  }
}

/**
 * 资源加载器 - 处理脚本和样式加载
 */
class ResourceLoader {
  constructor(envManager) {
    this.envManager = envManager
    this.loadedScripts = new Set()
    this.loadedLinks = new Set()
  }

  resolveUrl(src, scoped) {
    if (!src) return src
    if (scoped && src.startsWith('/')) {
      return scoped + src
    }
    if (src.startsWith('@')) {
      return src.slice(1)
    }
    return src
  }

  async loadScript(dom, env) {
    const src = this.resolveUrl(dom.getAttribute('src'), env?.scoped)
    const key = dom.getAttribute('key')

    if (this.isScriptLoaded(src, key)) {
      return
    }

    const script = this.createScriptElement(dom, src, key)
    return this.appendScript(script)
  }

  isScriptLoaded(src, key) {
    if (src && document.querySelector(`script[src="${src}"]`)) return true
    if (key && document.querySelector(`script[key="${key}"]`)) return true
    return false
  }

  createScriptElement(dom, src, key) {
    const script = document.createElement('script')
    if (src) script.src = src
    if (key) script.key = key
    script.type = dom.getAttribute('type') || 'text/javascript'
    return script
  }

  appendScript(script) {
    return new Promise((resolve, reject) => {
      script.onload = () => resolve(script)
      script.onerror = () => reject(new Error(`Failed to load script ${script.src}`))
      document.head.appendChild(script)
    })
  }

  loadLink(dom, env) {
    const href = this.resolveUrl(dom.getAttribute('href'), env?.scoped)
    const key = dom.getAttribute('key')

    if (this.isLinkLoaded(href, key)) {
      return
    }

    dom.setAttribute('href', href)
    document.head.append(dom)
  }

  isLinkLoaded(href, key) {
    if (href && document.querySelector(`link[href="${href}"]`)) return true
    if (key && document.querySelector(`link[key="${key}"]`)) return true
    return false
  }

  async loadHeaders(target, env) {
    for (const h of target.heads) {
      const nodeName = h.nodeName.toLowerCase()
      switch (nodeName) {
        case 'link':
          this.loadLink(h, env)
          break
        case 'script':
          await this.loadScript(h, env)
          break
        case 'title':
          target.title = h.innerText
          break
      }
    }
  }
}

/**
 * UI 解析器 - 解析 HTML 组件
 */
class UIParser {
  constructor(resourceLoader) {
    this.resourceLoader = resourceLoader
  }

  generateUniqueId() {
    const timestamp = new Date().getTime().toString(36).slice(-4)
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
    let random = ''
    for (let i = 0; i < 4; i++) {
      random += chars.charAt(Math.floor(Math.random() * chars.length))
    }
    return random + timestamp.padStart(4, '0')
  }

  async parse(txt, env, url, ignoreScoped = false) {
    const turl = this.normalizeUrl(url)
    const tmp = new DOMParser().parseFromString(txt, 'text/html')

    if (tmp.body.hasAttribute('scoped') && !ignoreScoped) {
      throw new Error('HTTP error! status: 404')
    }

    const target = this.createTarget(txt, env, turl, tmp)
    this.processStyles(target, turl)
    this.processBody(target, tmp)
    this.processScripts(target)
    this.syncRefOwnerId(target.body, turl)

    if (!ignoreScoped) {
      await this.resourceLoader.loadHeaders(target, env)
    }

    return target
  }

  normalizeUrl(url) {
    if (url === undefined) {
      return '#' + this.generateUniqueId()
    }
    if (url.endsWith('.html')) {
      return url.slice(0, -5)
    }
    return url
  }

  createTarget(txt, env, url, tmp) {
    return {
      url,
      heads: Array.from(tmp.querySelector('head')?.children || []),
      body: document.createElement('div'),
      setup: undefined,
      scripts: [],
      styles: '',
      txt,
      env,
      tmp,
      customAttrs: {},
    }
  }

  processStyles(target, turl) {
    if (!turl) return

    target.tmp.querySelectorAll('style').forEach((style) => {
      if (style.getAttribute('unscoped') === null) {
        target.styles += vcss.parse(style.innerHTML, turl)
      } else {
        target.styles += style.innerHTML
      }
    })

    if (target.styles) {
      const styleEl = document.createElement('style')
      styleEl.innerHTML = target.styles
      styleEl.setAttribute('vref', turl)
      document.head.appendChild(styleEl)
    }
  }

  processBody(target, tmp) {
    target.body.append(...tmp.querySelector('body').childNodes)

    Array.from(tmp.body.attributes).forEach((attr) => {
      if (/^[a-zA-Z]/.test(attr.name)) {
        target.body.setAttribute(attr.name, attr.value)
      } else {
        target.customAttrs[attr.name] = attr.value
      }
    })

    target.body.setAttribute('vref', target.url)
  }

  processScripts(target) {
    target.body.querySelectorAll('script').forEach((script) => {
      const content = script.innerHTML.trim()
      if (!content) {
        script.remove()
        return
      }

      if (script.hasAttribute('setup')) {
        target.setup = script
      } else if (!script.hasAttribute('no-vhtml')) {
        target.scripts.push(script)
      }
      script.remove()
    })
  }

  syncRefOwnerId(dom, id) {
    Array.from(dom.childNodes).forEach((node) => {
      if (node.nodeType === 1) {
        node.setAttribute('vrefof', id)
        this.syncRefOwnerId(node, id)
      }
    })
  }

  create404Parser(url, tempenv, error) {
    const dom404 = document.createElement('div')
    dom404.style.cssText = `
      background:#aaa;
      height:100%;
      width: 100%;
      display:grid;
      place-items: center;
    `
    dom404.innerHTML = `
      <div style="width:20rem;height:15rem;border-radius:1rem;padding:1rem;background:#cfc0aa;display:grid;place-items:center;">
        <div style="font-size:2rem">404</div>
        <p>${url}</p>
      </div>
    `

    return {
      heads: [],
      body: dom404,
      setup: '',
      scripts: [],
      styles: '',
      txt: '',
      tmp: '',
      env: tempenv,
      err: error,
    }
  }
}

/**
 * VGet - 主类，负责加载 HTML 组件
 */
class VGet {
  constructor() {
    this.envManager = new EnvManager()
    this.cacheManager = new CacheManager()
    this.resourceLoader = new ResourceLoader(this.envManager)
    this.uiParser = new UIParser(this.resourceLoader)
  }

  /**
   * 获取环境变量
   * @param {string} scoped - 作用域标识
   * @param {Object} temp - 临时配置
   * @returns {Promise<Object>}
   */
  async getEnv(scoped, temp) {
    return this.envManager.getEnv(scoped, temp)
  }

  /**
   * 加载 HTML 组件
   * @param {string} url - 组件 URL
   * @param {Object} env - 环境变量
   * @param {boolean} ignoreScoped - 是否忽略 scoped 检查
   * @returns {Promise<Object>}
   */
  async fetchUI(url, env, ignoreScoped = false) {
    const normalizedUrl = this.normalizeUrl(url, env?.scoped)

    // 检查缓存
    if (this.cacheManager.has(normalizedUrl)) {
      return Promise.resolve(this.cacheManager.get(normalizedUrl))
    }

    // 检查是否有正在进行的请求
    if (this.cacheManager.hasPending(normalizedUrl)) {
      return this.cacheManager.getPending(normalizedUrl)
    }

    const promise = this.doFetchUI(normalizedUrl, env, ignoreScoped)
    this.cacheManager.setPending(normalizedUrl, promise)

    return promise.finally(() => {
      this.cacheManager.deletePending(normalizedUrl)
    })
  }

  async doFetchUI(url, _env, ignoreScoped) {
    let tempenv = {}

    try {
      const response = await fetch(url + '?random=' + Math.random())

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`)
      }

      // 解析响应头中的 vhtml- 前缀配置
      for (const [key, value] of response.headers.entries()) {
        if (key.startsWith('vhtml-')) {
          tempenv[key.slice(6)] = value
        }
      }

      // 处理 scoped
      let scoped = tempenv.scoped || ''
      if (scoped.endsWith('/')) {
        scoped = scoped.slice(0, -1)
      }

      if (url.startsWith('http')) {
        scoped = new URL(url).origin + scoped
        tempenv.scoped = scoped
      }

      // 获取或创建环境变量
      const packEnv = await this.getEnv(scoped, tempenv)
      Object.assign(tempenv, packEnv)

      const txt = await response.text()
      this.cacheManager.setBaseFile(txt)

      const parser = await this.uiParser.parse(txt, tempenv, url, ignoreScoped)
      this.cacheManager.set(url, parser)

      return parser
    } catch (err) {
      return this.handleFetchError(url, tempenv, err)
    }
  }

  handleFetchError(url, tempenv, err) {
    if (err.message !== 'HTTP error! status: 404') {
      console.warn(err)
    }

    const parser = this.uiParser.create404Parser(url, tempenv, err)
    this.cacheManager.set(url, parser)
    return parser
  }

  normalizeUrl(url, scoped) {
    if (!url || url === '/') {
      url = '/'
    }

    if (!url.startsWith('http') && !url.startsWith('@')) {
      if (!url.startsWith('/')) {
        url = '/' + url
      }
    }

    if (scoped && url.startsWith('/')) {
      url = scoped + url
    }

    if (url.startsWith('@')) {
      url = url.slice(1)
    }

    return url
  }

  /**
   * 获取文件内容
   * @param {string} url - 文件 URL
   * @returns {Promise<string>}
   */
  async fetchFile(url) {
    const response = await fetch(url)
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`)
    }
    return response.text()
  }

  /**
   * 加载脚本
   * @param {HTMLElement} dom - script 元素
   * @param {Object} env - 环境变量
   * @returns {Promise<void>}
   */
  async loadScript(dom, env) {
    return this.resourceLoader.loadScript(dom, env)
  }

  /**
   * 加载链接
   * @param {HTMLElement} dom - link 元素
   * @param {Object} env - 环境变量
   */
  loadLink(dom, env) {
    return this.resourceLoader.loadLink(dom, env)
  }

  /**
   * 解析 UI
   * @param {string} txt - HTML 文本
   * @param {Object} env - 环境变量
   * @param {string} turl - 模板 URL
   * @param {boolean} ignoreScoped - 是否忽略 scoped 检查
   * @returns {Promise<Object>}
   */
  async parseUI(txt, env, turl, ignoreScoped) {
    return this.uiParser.parse(txt, env, turl, ignoreScoped)
  }

  /**
   * 清除所有缓存
   */
  clearCache() {
    this.cacheManager.clear()
    this.envManager.clear()
  }
}

// 创建单例实例
const vget = new VGet()

// 导出兼容原有 API 的对象
export default {
  FetchUI: (url, env, ignoreScoped) => vget.fetchUI(url, env, ignoreScoped),
  FetchFile: (url) => vget.fetchFile(url),
  LoadScript: (dom, env) => vget.loadScript(dom, env),
  LoadLink: (dom, env) => vget.loadLink(dom, env),
  ParseUI: (txt, env, turl, ignoreScoped) => vget.parseUI(txt, env, turl, ignoreScoped),
  // 新增：获取 VGet 实例，用于高级用法
  getInstance: () => vget,
  // 新增：清除缓存
  clearCache: () => vget.clearCache(),
}
