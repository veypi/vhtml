import {
  htmlElements,
  templateElements,
  templateAttributes,
} from './dom-schema.js'
import { parse, parseFragment, serialize } from 'parse5'
import * as css from 'css-tree'
import { patchStyle, setBoundAttribute } from '../binding-values.js'
import {
  HTML_NS,
  SVG_NS,
  XLINK_NS,
  svgElements,
  svgAttributes,
  createSVGPolicy,
} from './svg.js'

const resourceAttrs = new Set([
  'src',
  'srcset',
  'poster',
  'href',
  'data',
  'action',
  'formaction',
  'background',
  'ping',
  'srcdoc',
  'xlink:href',
])
const passiveAttrs = new Set(
  'id class title role name value type checked selected disabled readonly multiple required placeholder min max step minlength maxlength pattern autocomplete autofocus rows cols size width height alt controls muted loop preload loading decoding crossorigin playsinline tabindex hidden draggable contenteditable spellcheck translate dir lang slot for colspan rowspan scope open datetime download target rel accept capture label start reversed wrap list form inputmode'.split(
    ' '
  )
)
const blockedBindings = new Set([
  'innerhtml',
  'outerhtml',
  'textcontent',
  'srcdoc',
  'is',
  'xmlns',
])

export class RenderPolicy {
  #blobs = new Map()
  #closed = false
  #assetJobs = new Map()
  #assetBytes = 0
  #states = new WeakMap()
  #owners = new WeakMap()
  constructor(resources) {
    this.resources = resources
    this.svg = createSVGPolicy()
  }

  checkElement(tag, namespace = HTML_NS, template = false) {
    if (namespace === SVG_NS) {
      if (!svgElements.has(tag))
        throw new Error(`SVG element <${tag}> is unavailable`)
      return
    }
    if (
      namespace !== HTML_NS ||
      !(
        htmlElements.has(tag) ||
        (template &&
          (templateElements.has(tag) ||
            (tag.includes('-') && !globalThis.customElements?.get(tag))))
      )
    )
      throw new Error(`Element <${tag}> is unavailable in an isolated module`)
  }

  readAttribute(node, name) {
    const value = node.getAttribute(name)
    if (value == null || node.namespaceURI !== SVG_NS) return value
    return name === 'id' ? this.svg.originalId(value) : value
  }

  svgValue(tag, name, value) {
    const normalized = this.svg.attribute(name)
    if (['href', 'xlink:href'].includes(normalized)) {
      if (tag === 'image') {
        if (!this.ownsAsset(value)) this.resources.resolve(String(value))
        return String(value)
      }
      if (!['use', 'textPath'].includes(tag))
        throw new Error('SVG URL attribute is unavailable on this element')
      return this.svg.fragment(value)
    }
    return this.svg.value(normalized, value)
  }

  ownsAsset(url) {
    return [...this.#blobs.values()].includes(url)
  }

  async asset(url) {
    if (this.#closed) throw new Error('Render resources are disposed')
    if (this.ownsAsset(url)) return url
    const resource = this.resources.resolve(String(url))
    if (this.#blobs.has(resource.href)) return this.#blobs.get(resource.href)
    if (this.#assetJobs.has(resource.href))
      return this.#assetJobs.get(resource.href)
    if (this.#blobs.size + this.#assetJobs.size >= 256)
      throw new Error('Module asset count limit exceeded')
    const pending = this.#loadAsset(resource)
    this.#assetJobs.set(resource.href, pending)
    try {
      return await pending
    } finally {
      this.#assetJobs.delete(resource.href)
    }
  }

  async #loadAsset(resource) {
    const lease = await this.resources.open(resource)
    try {
      if (!lease.response.ok)
        throw new Error(`Asset HTTP ${lease.response.status}`)
      const type = (lease.response.headers.get('content-type') || '')
        .split(';')[0]
        .trim()
        .toLowerCase()
      if (
        !/^(image\/(png|jpeg|gif|webp|avif|bmp|x-icon)|audio\/[a-z0-9.+-]+|video\/[a-z0-9.+-]+|font\/[a-z0-9.+-]+|application\/(font-woff|vnd.ms-fontobject))$/.test(
          type
        )
      )
        throw new Error(`Unsupported sandbox asset type: ${type}`)
      const reader = lease.response.body.getReader(),
        chunks = []
      let length = 0
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        length += chunk.value.length
        if (length > 16 * 1024 * 1024) {
          await reader.cancel()
          throw new Error('Asset size limit exceeded')
        }
        chunks.push(chunk.value)
      }
      if (this.#closed) throw new Error('Render resources are disposed')
      if (this.#assetBytes + length > 32 * 1024 * 1024)
        throw new Error('Module asset memory limit exceeded')
      this.#assetBytes += length
      const blob = URL.createObjectURL(new Blob(chunks, { type }))
      this.#blobs.set(resource.href, blob)
      return blob
    } finally {
      lease.release()
    }
  }

  prepareStyle(text, { declaration = false } = {}) {
    const ast = css.parse(String(text), {
      context: declaration ? 'declarationList' : 'stylesheet',
    })
    const urls = []
    css.walk(ast, (node) => {
      if (node.type === 'Raw')
        throw new Error('Unparsed CSS is unavailable in an isolated module')
      if (
        node.type === 'Atrule' &&
        ![
          'media',
          'supports',
          'keyframes',
          '-webkit-keyframes',
          'font-face',
          'container',
          'layer',
        ].includes(node.name.toLowerCase())
      )
        throw new Error(
          `CSS @${node.name} is unavailable in an isolated module`
        )
      if (
        node.type === 'Function' &&
        /^(?:-webkit-)?image-set$/i.test(node.name)
      )
        throw new Error('Use url() for sandbox CSS images')
      if (node.type === 'Url') {
        if (node.value.startsWith('#'))
          node.value = this.svg.fragment(node.value)
        else urls.push(node)
      }
    })
    return { ast, urls }
  }

  styleImmediate(text, options) {
    const { ast, urls } = this.prepareStyle(text, options)
    return urls.length ? null : css.generate(ast)
  }

  async style(text, options) {
    const { ast, urls } = this.prepareStyle(text, options)
    for (const node of urls) node.value = await this.asset(node.value)
    return css.generate(ast)
  }

  scopeStyles(text, scope) {
    const ast = css.parse(text)
    const root = `[vref=${JSON.stringify(scope)}]`
    const svg = this.svg
    let keyframes = 0
    css.walk(ast, {
      enter(node) {
        if (node.type === 'Atrule' && /keyframes$/i.test(node.name)) keyframes++
        if (
          node.type !== 'Rule' ||
          keyframes ||
          node.prelude?.type !== 'SelectorList'
        )
          return
        node.prelude = css.parse(svg.selector(css.generate(node.prelude)), {
          context: 'selectorList',
        })
        node.prelude.children.forEach((selector) => {
          const suffix = css.parse(`:where(${root},${root} *)`, {
            context: 'selector',
          }).children
          let before = null
          selector.children.forEach((part, item) => {
            if (!before && part.type === 'PseudoElementSelector') before = item
          })
          selector.children.insertList(suffix, before)
        })
      },
      leave(node) {
        if (node.type === 'Atrule' && /keyframes$/i.test(node.name)) keyframes--
      },
    })
    return css.generate(ast)
  }

  checkAttribute(name) {
    name = String(name).toLowerCase()
    if (name.startsWith('on') || blockedBindings.has(name))
      throw new Error(`Attribute ${name} is unavailable in an isolated module`)
    if (
      resourceAttrs.has(name) ||
      name === 'style' ||
      passiveAttrs.has(name) ||
      svgAttributes.has(name) ||
      name.startsWith('data-') ||
      name.startsWith('aria-') ||
      /^_[a-z0-9_-]+$/.test(name)
    )
      return
    throw new Error(`Attribute ${name} is not provided to isolated modules`)
  }

  // One write ledger for template bindings and programmatic DOM writes. A node
  // keeps its component owner while detached; rebinding invalidates older work.
  bind(node, owner) {
    this.#owners.set(node, owner)
    const state = this.#states.get(node)
    if (state) {
      if (state.owner && state.owner !== owner) {
        state.versions.clear()
        state.style = null
      }
      state.owner = owner
    }
  }

  owner(node) {
    for (let current = node; current; current = current.parentNode) {
      const owner = this.#owners.get(current)
      if (owner) return owner
    }
    return null
  }

  #write(node, name) {
    let state = this.#states.get(node)
    if (!state) {
      state = { versions: new Map(), owner: this.owner(node), style: null }
      this.#states.set(node, state)
    }
    const ticket = {}
    state.versions.set(name, ticket)
    return () =>
      !this.#closed &&
      !state.owner?.closed &&
      state.versions.get(name) === ticket
  }

  styleProperty(node, name, value, priority = '') {
    const property = cssProperty(String(name))
    const declaration = document.createElement('div').style
    declaration.cssText = this.#states.get(node)?.style ?? node.style.cssText
    if (property === 'css-text') declaration.cssText = String(value)
    else
      declaration.setProperty(
        property,
        String(value),
        priority === 'important' ? 'important' : ''
      )
    return this.attribute(node, 'style', declaration.cssText)
  }

  styles(node, next, previous) {
    const declaration = document.createElement('div').style
    declaration.cssText = this.#states.get(node)?.style ?? node.style.cssText
    patchStyle(declaration, next, previous)
    return this.attribute(node, 'style', declaration.cssText)
  }

  async attribute(node, name, value, { binding = false } = {}) {
    name =
      node.namespaceURI === SVG_NS
        ? this.svg.attribute(name)
        : String(name).toLowerCase()
    if (node.namespaceURI !== SVG_NS) this.checkAttribute(name)
    const alive = this.#write(node, name)
    // Template bindings use DOM properties (notably dirty form values). Guest
    // setAttribute keeps native attribute semantics; resource writes stay below.
    if (
      binding &&
      node.namespaceURI !== SVG_NS &&
      name !== 'style' &&
      !resourceAttrs.has(name)
    ) {
      if (alive()) setBoundAttribute(node, name, value)
      return
    }
    if (value == null || value === false) {
      if (name === 'style') this.#states.get(node).style = ''
      node.removeAttribute(name)
      return
    }
    let result = value
    if (name === 'style') {
      this.#states.get(node).style = String(value)
      result = this.styleImmediate(value, { declaration: true })
      if (result === null)
        result = await this.style(value, { declaration: true })
    } else if (node.namespaceURI === SVG_NS) {
      result = this.svgValue(node.localName, name, value)
      if (node.localName === 'image' && ['href', 'xlink:href'].includes(name))
        result = await this.asset(value)
    } else if (resourceAttrs.has(name)) {
      if (name === 'href' && node.nodeName === 'A') {
        // Navigation goes through the module router.
        if (!String(value).startsWith('#')) {
          this.resources.resolve(String(value))
          result = '#'
        }
      } else if (
        (name === 'src' &&
          ['IMG', 'AUDIO', 'VIDEO', 'SOURCE', 'TRACK'].includes(
            node.nodeName
          )) ||
        (name === 'poster' && node.nodeName === 'VIDEO')
      ) {
        result = await this.asset(value)
      } else if (
        name === 'srcset' &&
        ['IMG', 'SOURCE'].includes(node.nodeName)
      ) {
        result = (
          await Promise.all(
            String(value)
              .split(',')
              .map(async (part) => {
                const [url, descriptor = ''] = part.trim().split(/\s+/)
                if (descriptor && !/^\d+(?:\.\d+)?[wx]$/.test(descriptor))
                  throw new Error('Invalid srcset descriptor')
                return `${await this.asset(url)} ${descriptor}`.trim()
              })
          )
        ).join(', ')
      } else
        throw new Error(
          `Resource attribute ${name} on ${node.nodeName} is unavailable`
        )
    }
    if (!alive()) return
    if (name === 'xlink:href') node.setAttributeNS(XLINK_NS, name, result)
    else node.setAttribute(name, result === true ? '' : String(result))
  }

  async html(source, { fragment = false, scripts = true } = {}) {
    const tree = (fragment ? parseFragment : parse)(String(source))
    const visit = async (node) => {
      if (node.tagName) {
        const tag = node.tagName
        this.checkElement(tag, node.namespaceURI, true)
        const svg = node.namespaceURI === SVG_NS
        if (tag.includes('-') && globalThis.customElements?.get(tag))
          throw new Error(
            'Registered native custom elements are unavailable in an isolated module'
          )
        if (!scripts && ['script', 'style', 'link'].includes(tag))
          throw new Error('Active content is unavailable in v-html')
        if (
          tag === 'link' &&
          (node.parentNode?.tagName !== 'head' ||
            !node.attrs.some(
              (attr) => attr.name === 'rel' && attr.value === 'stylesheet'
            ))
        )
          throw new Error(
            'Only module stylesheets are supported in sandbox heads'
          )
        if (tag === 'style') {
          const text = node.childNodes
            .map((child) => child.value || '')
            .join('')
          node.childNodes = [
            {
              nodeName: '#text',
              value: await this.style(text),
              parentNode: node,
            },
          ]
        }
        const attrs = []
        for (const attr of node.attrs) {
          const name =
            (attr.prefix ? attr.prefix + ':' : '') + attr.name.toLowerCase()
          if (name === 'unsafe')
            throw new Error(
              'unsafe is a module response header, not a component attribute'
            )
          if (name === 'is' || name.startsWith('on') || name === 'no-vhtml')
            throw new Error(
              `Native attribute ${name} is unavailable in an isolated module`
            )
          if (name === 'unscoped') continue
          const directive =
            name.startsWith(':') ||
            name.startsWith('@') ||
            name.startsWith('v-') ||
            name.startsWith('v:') ||
            templateAttributes.has(name)
          const metadata =
            (tag === 'vrouter' && ['history', 'initial'].includes(name)) ||
            (['script', 'style', 'link'].includes(tag) &&
              [
                'setup',
                'active',
                'deactive',
                'dispose',
                'src',
                'href',
                'rel',
                'type',
                'media',
              ].includes(name))
          const component =
            tag.includes('-') ||
            node.attrs.some((item) => ['vsrc', ':vsrc'].includes(item.name))
          if (!svg && !directive && !metadata && !component)
            this.checkAttribute(name)
          // Custom component props are inert, but browser-recognized resource
          // attributes still pass through the resource branch below.

          if (
            svg &&
            !name.startsWith(':') &&
            !name.startsWith('@') &&
            !name.startsWith('v-') &&
            !name.startsWith('v:') &&
            !['ref', 'vsrc', 'routes', 'prefix', 'params'].includes(name)
          ) {
            const canonical = this.svg.attribute(name)
            if (
              canonical !== 'style' &&
              !(tag === 'image' && ['href', 'xlink:href'].includes(canonical))
            )
              attr.value = this.svgValue(tag, canonical, attr.value)
          }
          if (
            name.startsWith(':') &&
            !tag.includes('-') &&
            !node.attrs.some((item) => ['vsrc', ':vsrc'].includes(item.name)) &&
            !['vsrc', 'ref', 'routes', 'prefix', 'params'].includes(
              name.slice(1)
            )
          )
            this.checkAttribute(name.slice(1))
          if (
            name.startsWith('v:') &&
            ['innerhtml', 'outerhtml', 'srcdoc'].includes(name.slice(2))
          )
            throw new Error('Unsupported two-way DOM binding')
          if (
            ['script', 'link'].includes(tag) &&
            ['src', 'href'].includes(name)
          )
            attr.name = 'data-vhtml-' + name
          if (name === 'style')
            attr.value = await this.style(attr.value, { declaration: true })
          // Keep resources inert until the framework installs a controlled binding.
          if (resourceAttrs.has(name) && !['script', 'link'].includes(tag)) {
            if (!node.attrs.some((item) => item.name === ':' + name))
              attrs.push({
                name: ':' + name,
                value: JSON.stringify(attr.value),
              })
          } else attrs.push(attr)
        }
        node.attrs = attrs
      }
      for (const child of node.childNodes || []) await visit(child)
      if (node.content) await visit(node.content)
    }
    await visit(tree)
    return serialize(tree)
  }

  dispose() {
    this.#closed = true
    for (const url of this.#blobs.values()) URL.revokeObjectURL(url)
    this.#blobs.clear()
  }
}

export const cssProperty = (name) =>
  name.startsWith('--')
    ? name
    : name
        .replace(/[A-Z]/g, (char) => '-' + char.toLowerCase())
        .replace(/^ms-/, '-ms-')
