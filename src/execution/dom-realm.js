// Serialized into QuickJS. None of these objects has a native browser prototype.
export function initializeDOMRealm(
  call,
  draw,
  schema,
  platform,
  createWebGL,
  glCall,
  glTypes,
  weakHandles,
  collect
) {
  delete globalThis.__vhtmlDOMCall
  delete globalThis.__vhtmlCanvasCall
  delete globalThis.__vhtmlWebGLCall
  delete globalThis.__vhtmlCollectDOM
  const pinned = new Map()
  const nodes = weakHandles((dead) => {
      for (const id of collect(dead, [...pinned.keys()])) pinned.delete(id)
    }),
    identities = new WeakMap(),
    contexts = new WeakMap(),
    drawings = new WeakMap()
  const handlers = new WeakMap(),
    eventProperties = new WeakMap(),
    styleObjects = new WeakMap()
  const idOf = (value) => {
    const id = identities.get(value)
    if (id === undefined) throw new TypeError('Expected a module DOM node')
    return id
  }
  const list = (values) => {
    const result = values.map(node)
    Object.defineProperty(result, 'item', {
      value: (index) => result[index] || null,
    })
    return result
  }
  const mark = (value) => {
    Object.defineProperty(value, '__noproxy', { value: true })
    return value
  }
  const drawingHandles = weakHandles((dead) => draw('collect', 0, '', dead))
  const webgl = createWebGL(glCall, node, idOf, glTypes)
  class Node {
    constructor() {
      throw new TypeError('Use document.createElement')
    }
    get ownerDocument() {
      return document
    }
    get childNodes() {
      return list(call('children', idOf(this), 'nodes'))
    }
    get children() {
      return list(call('children', idOf(this)))
    }
    get childElementCount() {
      return this.children.length
    }
    appendChild(child) {
      retain(call('append', idOf(this), idOf(child)))
      return child
    }
    insertBefore(child, before) {
      retain(
        call(
          'append',
          idOf(this),
          idOf(child),
          before == null ? null : idOf(before)
        )
      )
      return child
    }
    removeChild(child) {
      call('remove', idOf(this), idOf(child))
      return child
    }
    replaceChild(child, previous) {
      this.insertBefore(child, previous)
      this.removeChild(previous)
      return previous
    }
    append(...children) {
      children.forEach((child) =>
        this.appendChild(
          typeof child === 'string' ? document.createTextNode(child) : child
        )
      )
    }
    prepend(...children) {
      const before = this.firstChild
      children.forEach((child) =>
        this.insertBefore(
          typeof child === 'string' ? document.createTextNode(child) : child,
          before
        )
      )
    }
    replaceChildren(...children) {
      while (this.firstChild) this.removeChild(this.firstChild)
      this.append(...children)
    }
    remove() {
      this.parentNode?.removeChild(this)
    }
    hasChildNodes() {
      return !!this.firstChild
    }
    cloneNode(deep = false) {
      return node(call('clone', idOf(this), !!deep))
    }
    compareDocumentPosition(other) {
      return call('compare', idOf(this), idOf(other))
    }
    contains(child) {
      return child != null && call('contains', idOf(this), idOf(child))
    }
    isSameNode(other) {
      return this === other
    }
    getRootNode() {
      return document
    }
    addEventListener(type, callback, options = {}) {
      if (!callback) return
      type = String(type)
      const capture = typeof options === 'boolean' ? options : !!options.capture
      const records = handlers.get(this) || []
      handlers.set(this, records)
      if (
        records.some(
          (record) =>
            record.type === type &&
            record.callback === callback &&
            record.capture === capture
        )
      )
        return
      const listener = (event) => {
        if (options.once) this.removeEventListener(type, callback, options)
        typeof callback === 'function'
          ? callback.call(this, event)
          : callback.handleEvent(event)
      }
      const token = call('listen', idOf(this), type, listener, {
        capture,
        passive: !!options.passive,
        once: !!options.once,
      })
      records.push({ type, callback, capture, token })
    }
    removeEventListener(type, callback, options = {}) {
      const records = handlers.get(this) || [],
        capture = typeof options === 'boolean' ? options : !!options.capture
      const index = records.findIndex(
        (record) =>
          record.type === String(type) &&
          record.callback === callback &&
          record.capture === capture
      )
      if (index >= 0) call('unlisten', records.splice(index, 1)[0].token)
    }
  }
  for (const [key, value] of Object.entries({
    ELEMENT_NODE: 1,
    TEXT_NODE: 3,
    DOCUMENT_NODE: 9,
    DOCUMENT_FRAGMENT_NODE: 11,
  })) {
    Node[key] = value
    Node.prototype[key] = value
  }
  for (const key of schema.read)
    Object.defineProperty(Node.prototype, key, {
      configurable: true,
      get() {
        return call('get', idOf(this), key)
      },
      ...(schema.write.includes(key)
        ? {
            set(value) {
              call('set', idOf(this), key, value)
            },
          }
        : {}),
    })
  for (const key of schema.relatives)
    Object.defineProperty(Node.prototype, key, {
      get() {
        return node(call('relative', idOf(this), key))
      },
    })
  class Element extends Node {
    get style() {
      return style(idOf(this))
    }
    get innerHTML() {
      return call('htmlRead', idOf(this))
    }
    set innerHTML(value) {
      call('html', idOf(this), String(value))
    }
    querySelector(selector) {
      return node(call('query', idOf(this), String(selector)))
    }
    querySelectorAll(selector) {
      return list(call('queryAll', idOf(this), String(selector)))
    }
    getElementsByTagName(tag) {
      return this.querySelectorAll(String(tag))
    }
    getElementsByClassName(names) {
      return this.querySelectorAll(
        '.' + String(names).trim().split(/\s+/).join('.')
      )
    }
    matches(selector) {
      return call('matches', idOf(this), String(selector))
    }
    closest(selector) {
      for (let current = this; current; current = current.parentElement)
        if (current.matches(selector)) return current
      return null
    }
    getAttribute(name) {
      return call('attribute', idOf(this), String(name))
    }
    hasAttribute(name) {
      return this.getAttribute(name) !== null
    }
    setAttribute(name, value) {
      call('setAttribute', idOf(this), String(name), String(value))
    }
    setAttributeNS(ns, name, value) {
      call('setAttributeNS', idOf(this), ns, String(name), String(value))
    }
    getAttributeNS(ns, name) {
      return call('attributeNS', idOf(this), ns, String(name))
    }
    removeAttributeNS(ns, name) {
      call('removeAttributeNS', idOf(this), ns, String(name))
    }
    removeAttribute(name) {
      call('removeAttribute', idOf(this), String(name))
    }
    getBoundingClientRect() {
      const rect = call('rect', idOf(this))
      rect.toJSON = () => ({ ...rect, toJSON: undefined })
      return rect
    }
    getClientRects() {
      return [this.getBoundingClientRect()]
    }
    focus() {
      call('focus', idOf(this))
    }
    blur() {
      call('blur', idOf(this))
    }
    get classList() {
      const target = this,
        tokens = () =>
          String(target.className || '')
            .split(/\s+/)
            .filter(Boolean)
      return {
        contains: (value) => tokens().includes(value),
        add(...values) {
          target.className = [...new Set([...tokens(), ...values])].join(' ')
        },
        remove(...values) {
          target.className = tokens()
            .filter((v) => !values.includes(v))
            .join(' ')
        },
        toggle(value, force) {
          const exists = this.contains(value),
            next = force === undefined ? !exists : !!force
          next ? this.add(value) : this.remove(value)
          return next
        },
      }
    }
  }
  class HTMLElement extends Element {}
  class SVGMatrix {
    constructor(value = {}) {
      Object.assign(this, { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }, value)
    }
    inverse() {
      const { a, b, c, d, e, f } = this,
        det = a * d - b * c
      if (!det) throw new Error('Singular matrix')
      return new SVGMatrix({
        a: d / det,
        b: -b / det,
        c: -c / det,
        d: a / det,
        e: (c * f - d * e) / det,
        f: (b * e - a * f) / det,
      })
    }
    multiply(other) {
      const { a, b, c, d, e, f } = this
      return new SVGMatrix({
        a: a * other.a + c * other.b,
        b: b * other.a + d * other.b,
        c: a * other.c + c * other.d,
        d: b * other.c + d * other.d,
        e: a * other.e + c * other.f + e,
        f: b * other.e + d * other.f + f,
      })
    }
  }
  class SVGElement extends Element {
    get ownerSVGElement() {
      let current = this.parentElement
      while (current) {
        if (current.tagName === 'svg') return current
        current = current.parentElement
      }
      return null
    }
    get viewportElement() {
      return this.ownerSVGElement
    }
    getBBox() {
      return call('svgRead', idOf(this), 'getBBox')
    }
    getCTM() {
      const value = call('svgRead', idOf(this), 'getCTM')
      return value && new SVGMatrix(value)
    }
    getScreenCTM() {
      const value = call('svgRead', idOf(this), 'getScreenCTM')
      return value && new SVGMatrix(value)
    }
    get transform() {
      return {
        baseVal: {
          consolidate: () => {
            const value = call('svgRead', idOf(this), 'transform')
            return value && { matrix: new SVGMatrix(value) }
          },
        },
      }
    }
    getTotalLength() {
      return call('svgRead', idOf(this), 'getTotalLength')
    }
    getPointAtLength(value) {
      return call('svgRead', idOf(this), 'getPointAtLength', [Number(value)])
    }
    getComputedTextLength() {
      return call('svgRead', idOf(this), 'getComputedTextLength')
    }
  }
  class SVGSVGElement extends SVGElement {
    createSVGMatrix() {
      return new SVGMatrix()
    }
    createSVGPoint() {
      return {
        x: 0,
        y: 0,
        matrixTransform(matrix) {
          return {
            x: matrix.a * this.x + matrix.c * this.y + matrix.e,
            y: matrix.b * this.x + matrix.d * this.y + matrix.f,
          }
        },
      }
    }
  }
  for (const name of ['viewBox', 'width', 'height', 'x', 'y'])
    Object.defineProperty(SVGSVGElement.prototype, name, {
      get() {
        return { baseVal: call('svgRead', idOf(this), name) }
      },
    })
  class HTMLCanvasElement extends HTMLElement {
    getContext(type, options) {
      const id = idOf(this)
      if (['webgl', 'webgl2', 'experimental-webgl'].includes(type))
        return webgl.open(this, id, type, options)
      if (type !== '2d') return null
      let current = contexts.get(this)?.deref()
      if (!current) {
        if (!draw('open', id)) return null
        current = context(this, id)
        contexts.set(this, new WeakRef(current))
      }
      return current
    }
  }
  class HTMLImageElement extends HTMLElement {}
  for (const key of ['src', 'srcset', 'href', 'poster', 'alt'])
    Object.defineProperty(HTMLElement.prototype, key, {
      get() {
        return this.getAttribute(key) || ''
      },
      set(value) {
        this.setAttribute(key, value)
      },
    })
  for (const name of 'click dblclick mousedown mouseup mousemove mouseenter mouseleave mouseover mouseout contextmenu wheel pointerdown pointerup pointermove touchstart touchmove touchend load error input change focus blur keydown keyup'.split(
    ' '
  ))
    Object.defineProperty(HTMLElement.prototype, 'on' + name, {
      get() {
        return eventProperties.get(this)?.get(name) || null
      },
      set(callback) {
        const map = eventProperties.get(this) || new Map()
        eventProperties.set(this, map)
        const previous = map.get(name)
        if (previous) this.removeEventListener(name, previous)
        map.set(name, callback)
        if (typeof callback === 'function')
          this.addEventListener(name, callback)
      },
    })
  function retain(ids) {
    for (const id of ids) {
      const value = nodes.get(id)
      if (value) pinned.set(id, value)
    }
  }
  function node(id) {
    if (id == null) return null
    if (id === -1) return globalThis
    const existing = nodes.get(id)
    if (existing) return existing
    const info = call('describe', id)
    const Constructor =
      info.namespace === 'http://www.w3.org/2000/svg'
        ? info.name === 'svg'
          ? SVGSVGElement
          : SVGElement
        : info.name === 'CANVAS'
          ? HTMLCanvasElement
          : info.name === 'IMG'
            ? HTMLImageElement
            : info.type === 1
              ? HTMLElement
              : Node
    const value = mark(Object.create(Constructor.prototype))
    identities.set(value, id)
    nodes.set(id, value)
    if (info.owned) pinned.set(id, value)
    return value
  }
  function style(id, computed = false) {
    const target = node(id)
    const existing = !computed && styleObjects.get(target)?.deref()
    if (existing) return existing
    const read = (key) =>
      call(computed ? 'computed' : 'styleGet', idOf(target), String(key))
    const value = new Proxy(
      {
        getPropertyValue: read,
        setProperty(key, value, priority = '') {
          if (computed) throw new TypeError('Computed style is readonly')
          call('styleSet', id, String(key), String(value), String(priority))
        },
        removeProperty(key) {
          const previous = read(key)
          this.setProperty(key, '')
          return previous
        },
      },
      {
        get(target, key) {
          if (key === '__noproxy') return true
          if (key in target) return target[key]
          if (typeof key === 'symbol') return undefined
          if (key === 'cssText') return call('styleText', id)
          return read(key)
        },
        set(target, key, value) {
          if (computed) throw new TypeError('Computed style is readonly')
          call('styleSet', id, String(key), String(value))
          return true
        },
      }
    )
    if (!computed) styleObjects.set(target, new WeakRef(value))
    return value
  }
  function context(canvas, id) {
    const result = mark({ canvas })
    const drawing = (value) => {
      let ref = drawingHandles.get(value.drawing)
      if (!ref) {
        ref = mark({
          addColorStop(offset, color) {
            draw('object', idOf(canvas), 'addColorStop', [
              value.drawing,
              Number(offset),
              String(color),
            ])
          },
        })
        drawings.set(ref, value.drawing)
        drawingHandles.set(value.drawing, ref)
      }
      return ref
    }
    for (const key of schema.canvasProperties)
      Object.defineProperty(result, key, {
        get() {
          const value = draw('get', id, key)
          return value?.drawing ? drawing(value) : value
        },
        set(value) {
          draw('set', id, key, [
            drawings.has(value) ? { drawing: drawings.get(value) } : value,
          ])
        },
      })
    for (const key of schema.canvasMethods)
      result[key] = (...args) => {
        if (key === 'drawImage' || key === 'createPattern')
          args[0] = { node: idOf(args[0]) }
        const value = draw('call', id, key, args)
        if (value?.drawing) return drawing(value)
        return value
      }
    return result
  }
  // document is a view over this module's registered component roots. It is not
  // a second DOM tree; new nodes acquire a component owner when inserted.
  const document = mark(Object.create(Node.prototype))
  identities.set(document, 0)
  const documentQuery = (selector, all) =>
    all
      ? list(call('queryAll', 0, String(selector)))
      : node(call('query', 0, String(selector)))
  const boundary = mark({
    style: Object.create(null),
    nodeType: 1,
    tagName: 'BODY',
    nodeName: 'BODY',
    namespaceURI: 'http://www.w3.org/1999/xhtml',
    ownerDocument: document,
    querySelector: (selector) => documentQuery(selector, false),
    querySelectorAll: (selector) => documentQuery(selector, true),
    addEventListener: document.addEventListener.bind(document),
    removeEventListener: document.removeEventListener.bind(document),
    appendChild(child) {
      const roots = call('documentRoots', 0)
      if (roots.length !== 1)
        throw new Error('Use an explicit component container')
      return node(roots[0]).appendChild(child)
    },
    removeChild(child) {
      const parent = child.parentNode
      if (!list(call('documentRoots', 0)).includes(parent))
        throw new Error('Node is not a module root child')
      return parent.removeChild(child)
    },
    contains(child) {
      return list(call('documentRoots', 0)).some((root) => root.contains(child))
    },
  })
  Object.defineProperties(document, {
    nodeType: { value: 9 },
    nodeName: { value: '#document' },
    namespaceURI: { value: null },
    location: { value: globalThis.location },
    URL: { value: globalThis.location.href },
    cookie: { value: '' },
    ownerDocument: { value: null },
    defaultView: { value: globalThis },
    body: { value: boundary },
    documentElement: { value: boundary },
    head: { value: null },
    readyState: { value: 'complete' },
    implementation: {
      value: Object.freeze({
        createHTMLDocument() {
          // Detached documents share the module policy. Their base element is only
          // address metadata; it can never become a native browser <base>.
          const body = document.createElement('div'),
            head = document.createElement('div')
          const bases = new WeakSet(),
            child = Object.create(document)
          const append = head.appendChild.bind(head)
          head.appendChild = (value) =>
            bases.has(value) ? value : append(value)
          Object.defineProperties(child, {
            body: { value: body },
            head: { value: head },
            documentElement: { value: body },
            querySelector: { value: body.querySelector.bind(body) },
            querySelectorAll: { value: body.querySelectorAll.bind(body) },
            createElement: {
              value: (tag) => {
                if (String(tag).toLowerCase() !== 'base')
                  return document.createElement(tag)
                const base = {
                  nodeType: 1,
                  nodeName: 'BASE',
                  ownerDocument: child,
                  href: location.href,
                }
                bases.add(base)
                return base
              },
            },
          })
          return child
        },
      }),
    },
    querySelector: { value: (selector) => documentQuery(selector, false) },
    querySelectorAll: { value: (selector) => documentQuery(selector, true) },
    contains: {
      value: (value) => value === document || boundary.contains(value),
    },
    getElementById: {
      value: (id) =>
        list(call('queryAll', 0, '[id]')).find(
          (value) => value.id === String(id)
        ) || null,
    },
    createElement: { value: (tag) => node(call('create', 0, String(tag))) },
    createElementNS: {
      value: (ns, tag) => node(call('createNS', 0, String(tag), String(ns))),
    },
    createTextNode: { value: (text) => node(call('text', 0, String(text))) },
    createDocumentFragment: { value: () => node(call('fragment', 0)) },
  })
  class ResizeObserver {
    #tokens = new Map()
    constructor(callback) {
      this.callback = callback
    }
    observe(target) {
      if (this.#tokens.has(target)) return
      const token = call('observe', idOf(target), 'resize', (entries) =>
        this.callback(
          entries.map((entry) => ({
            target: node(entry.target),
            contentRect: {
              x: 0,
              y: 0,
              width: entry.width,
              height: entry.height,
            },
            contentBoxSize: [
              { inlineSize: entry.width, blockSize: entry.height },
            ],
            borderBoxSize: [
              { inlineSize: entry.width, blockSize: entry.height },
            ],
          })),
          this
        )
      )
      this.#tokens.set(target, token)
    }
    unobserve(target) {
      const token = this.#tokens.get(target)
      if (token) call('unobserve', token)
      this.#tokens.delete(target)
    }
    disconnect() {
      for (const token of this.#tokens.values()) call('unobserve', token)
      this.#tokens.clear()
    }
  }
  class MutationObserver {
    #tokens = new Map()
    constructor(callback) {
      this.callback = callback
    }
    observe(target, options) {
      if (this.#tokens.has(target)) call('unobserve', this.#tokens.get(target))
      const token = call(
        'observe',
        idOf(target),
        'mutation',
        (entries) =>
          this.callback(
            entries.map((entry) => ({
              ...entry,
              target: node(entry.target),
              addedNodes: list(entry.addedNodes),
              removedNodes: list(entry.removedNodes),
            })),
            this
          ),
        options
      )
      this.#tokens.set(target, token)
    }
    disconnect() {
      for (const token of this.#tokens.values()) call('unobserve', token)
      this.#tokens.clear()
    }
  }
  const started = Date.now()
  identities.set(globalThis, -1)
  Object.assign(globalThis, {
    Node,
    Element,
    HTMLElement,
    SVGElement,
    SVGSVGElement,
    SVGRect: class SVGRect {},
    HTMLCanvasElement,
    HTMLImageElement,
    document,
    ResizeObserver,
    MutationObserver,
    Image: function (width, height) {
      const image = document.createElement('img')
      if (width !== undefined) image.width = width
      if (height !== undefined) image.height = height
      return image
    },
    getComputedStyle: (value) => style(idOf(value), true),
    devicePixelRatio: platform.devicePixelRatio,
    performance: { now: () => Date.now() - started, timeOrigin: started },
    requestAnimationFrame: (callback) =>
      setTimeout(() => callback(performance.now()), 16),
    cancelAnimationFrame: clearTimeout,
    addEventListener: Node.prototype.addEventListener.bind(globalThis),
    removeEventListener: Node.prototype.removeEventListener.bind(globalThis),
  })
  globalThis.__vhtmlDOMNode = node
  globalThis.__vhtmlDOMEvent = (detail) => {
    if (detail.devicePixelRatio)
      globalThis.devicePixelRatio = detail.devicePixelRatio
    return {
      ...detail,
      target: node(detail.target),
      currentTarget: node(detail.currentTarget),
      relatedTarget: node(detail.relatedTarget),
      preventDefault() {
        call('event', detail.id, 'preventDefault')
        this.defaultPrevented = true
      },
      stopPropagation: () => call('event', detail.id, 'stopPropagation'),
      stopImmediatePropagation: () =>
        call('event', detail.id, 'stopImmediatePropagation'),
    }
  }
  globalThis.__vhtmlDOMContext = (id) => {
    const router = {}
    for (const name of ['params', 'query', 'current'])
      Object.defineProperty(router, name, {
        get: () => call('routerRead', id, name),
      })
    for (const name of [
      'push',
      'replace',
      'resolveHref',
      'setQuery',
      'setParams',
    ])
      router[name] = (value) => call('routerCall', id, name, value)
    const scope = {
      addCleanup: (callback) => call('cleanup', id, null, callback),
    }
    for (const name of ['mount', 'active', 'deactive', 'dispose'])
      scope['on' + name[0].toUpperCase() + name.slice(1)] = (callback) =>
        call(name, id, null, callback)
    for (const [name, clear] of [
      ['setTimeout', 'clearTimeout'],
      ['setInterval', 'clearInterval'],
      ['requestAnimationFrame', 'cancelAnimationFrame'],
    ]) {
      scope[name] = (callback, delay, ...args) => {
        const timer = globalThis[name](callback, delay, ...args)
        scope.addCleanup(() => globalThis[clear](timer))
        return timer
      }
      scope[clear] = globalThis[clear]
    }
    return {
      $node: node(id),
      $scope: Object.freeze(scope),
      $router: Object.freeze(router),
      $emit: (name, ...args) => call('emit', id, name, args),
    }
  }
  return () => {
    nodes.sweep()
    drawingHandles.sweep()
  }
}
