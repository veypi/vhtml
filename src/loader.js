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
function templateRef(source) {
  const url = new URL(source, window.location.origin)
  url.pathname = url.pathname.replace(/\.html$/, '')
  return url.origin === window.location.origin
    ? url.pathname + url.search + url.hash
    : url.href
}

class ResourceLoader {
  loadedLinks = new Set()
  loadedStyles = new Set()

  loadStyle(text, source) {
    if (!text) return
    const url = new URL(source, window.location.origin).href
    const key = `${url}::${text}`
    if (this.loadedStyles.has(key)) return
    this.loadedStyles.add(key)
    const style = document.createElement('style')
    style.textContent = text
    style.setAttribute('vref', templateRef(url))
    document.head.appendChild(style)
  }

  clearScopedStyles(matches) {
    for (const node of document.head.querySelectorAll('style[vref]')) {
      if (matches(node.getAttribute('vref'))) node.remove()
    }
    for (const key of this.loadedStyles) {
      if (matches(key.slice(0, key.indexOf('::'))))
        this.loadedStyles.delete(key)
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
  parse(text, mod, url) {
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
      descriptor.styles += node.hasAttribute('unscoped')
        ? node.textContent
        : vcss.parse(node.textContent, ref)
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

export const templateLoader = new TemplateLoader()
export default templateLoader
