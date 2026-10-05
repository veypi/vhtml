import { createWeakHandles } from './handles.js'
import { cssProperty } from './render-policy.js'
import { parseFragment } from '../vendor/parse5.js'
import { instanceOf } from '../component-instance.js'
import { moduleRecord } from './context.js'
import { domSchema, htmlElements, templateAttributes } from './dom-schema.js'
import { initializeDOMRealm } from './dom-realm.js'
import { createCanvasBridge } from './canvas.js'
import { HTML_NS, SVG_NS, XLINK_NS, XML_NS, XMLNS_NS } from './svg.js'
import { createWebGLBridge } from './webgl.js'
import { initializeWebGLRealm } from './webgl-realm.js'
import { webglTypes } from './webgl-schema.js'

export function installDOM(executor, policy) {
  const nodes = new Map(),
    ids = new WeakMap(),
    created = new WeakSet(),
    roots = new Map(),
    events = new Map()
  const listeners = new Map(),
    observers = new Map()
  let sequence = 0,
    closed = false
  function owner(node) {
    for (let current = node; current; current = current.parentNode) {
      if (roots.has(current)) return roots.get(current)
      const execution = moduleRecord(
        instanceOf(current, false)?.runtime
      )?.execution
      if (execution && execution.engine !== executor) return null
    }
    return null
  }
  function id(node, allocation = false) {
    if (!node) return null
    if (allocation) created.add(node)
    const context = owner(node)
    const old = ids.get(node)
    const previous = old && nodes.get(old)
    if (
      !context &&
      !(
        !node.isConnected &&
        (created.has(node) || (previous?.context && !previous.context.closed))
      )
    )
      return null
    if (old && nodes.has(old)) return old
    if (nodes.size >= 10000) throw new Error('Module DOM node limit exceeded')
    const key = ++sequence
    ids.set(node, key)
    nodes.set(key, { node, context, held: false })
    return key
  }
  function node(key) {
    const record = nodes.get(key)
    if (
      closed ||
      !record ||
      record.context?.closed ||
      (!owner(record.node) &&
        !(
          !record.node.isConnected &&
          (created.has(record.node) || record.context)
        ))
    )
      throw new Error('Node is outside this module')
    return record.node
  }
  const canvas = createCanvasBridge(node)
  const webgl = createWebGLBridge(node)
  const contextOf = (key) => owner(node(key)) || nodes.get(key)?.context
  const rootsList = () =>
    [...roots.keys()].filter((root) => !owner(root.parentNode))
  function query(key, selector, all) {
    selector = policy.svg.selector(selector)
    const targets = key === 0 ? rootsList() : [node(key)],
      found = []
    for (const target of targets) {
      if (key === 0 && target.matches(selector)) found.push(target)
      found.push(...target.querySelectorAll(selector))
    }
    const result = [...new Set(found)].map((value) => id(value)).filter(Boolean)
    return all ? result : result[0] || null
  }
  function snapshot(event) {
    const key = ++sequence
    // A resize notification may be observed, but guest event methods must not
    // cancel or suppress the host window's event dispatch.
    if (event.currentTarget !== window) events.set(key, event)
    queueMicrotask(() => events.delete(key))
    const result = {
      id: key,
      target: event.target === window ? -1 : id(event.target),
      currentTarget:
        event.currentTarget === window ? -1 : id(event.currentTarget),
      relatedTarget: id(event.relatedTarget),
      ...(event.currentTarget === window
        ? { devicePixelRatio: window.devicePixelRatio || 1 }
        : {}),
    }
    for (const prop of 'type key code button buttons clientX clientY offsetX offsetY pageX pageY screenX screenY deltaX deltaY deltaMode wheelDelta detail ctrlKey shiftKey altKey metaKey defaultPrevented cancelable bubbles timeStamp pointerId pointerType'.split(
      ' '
    )) {
      const value = event[prop]
      if (['string', 'number', 'boolean'].includes(typeof value))
        result[prop] = value
    }
    return result
  }
  function removeListener(token) {
    const record = listeners.get(token)
    if (!record) return
    for (const target of record.targets)
      target.removeEventListener(record.type, record.handler, record.capture)
    listeners.delete(token)
  }
  function listen(key, type, callback, options = {}) {
    if (listeners.size >= 2048)
      throw new Error('Module event listener limit exceeded')
    const token = ++sequence
    const windowResize = key === -1 && type === 'resize'
    const record = {
      key,
      type: String(type),
      capture: !!options.capture,
      virtualRoot: key <= 0 && !windowResize,
      targets: windowResize ? [window] : key <= 0 ? rootsList() : [node(key)],
    }
    record.handler = (event) => {
      if (options.once) removeListener(token)
      callback(executor.invoke('__vhtmlDOMEvent', snapshot(event)))
    }
    for (const target of record.targets)
      target.addEventListener(record.type, record.handler, {
        capture: record.capture,
        passive: !!options.passive,
      })
    listeners.set(token, record)
    if (key > 0) contextOf(key)?.scope.addCleanup(() => removeListener(token))
    return token
  }
  function setStyle(target, name, value, priority = '') {
    policy.styleProperty(target, name, value, priority).catch(executor.onError)
  }
  function setAttribute(target, name, value) {
    if (target.namespaceURI === SVG_NS) {
      name = policy.svg.attribute(name)
      if (name === 'style') {
        setStyle(target, 'cssText', value)
        return
      }
      policy.svgValue(target.localName, name, value)
      policy.attribute(target, name, value).catch(executor.onError)
      return
    }
    name = String(name).toLowerCase()
    if (name === 'style') {
      setStyle(target, 'cssText', value)
      return
    }
    policy.checkAttribute(name)
    if (target.nodeName === 'CANVAS' && ['width', 'height'].includes(name))
      checkCanvasSize(target, name, value)
    // Validate addresses synchronously even when fetching the asset is asynchronous.
    if (
      ['src', 'poster', 'href', 'action', 'formaction'].includes(name) &&
      value &&
      !String(value).startsWith('#') &&
      !policy.ownsAsset(value)
    )
      policy.resources.resolve(String(value))
    policy.attribute(target, name, value).catch(executor.onError)
  }
  function makeNode(tag, namespace = HTML_NS) {
    tag = namespace === HTML_NS ? String(tag).toLowerCase() : String(tag)
    policy.checkElement(tag, namespace)
    return namespace === HTML_NS
      ? document.createElement(tag)
      : document.createElementNS(namespace, tag)
  }
  const make = (tag, namespace) => id(makeNode(tag, namespace), true)
  function checkCanvasSize(target, name, value) {
    const size = Number(value)
    if (!Number.isFinite(size) || size < 0 || size > 4096)
      throw new Error('Canvas dimension limit exceeded')
    let pixels = 0
    for (const { node: item } of nodes.values())
      if (item.nodeName === 'CANVAS')
        pixels +=
          (item === target && name === 'width' ? size : item.width) *
          (item === target && name === 'height' ? size : item.height)
    if (pixels > 16 * 1024 * 1024)
      throw new Error('Module canvas memory limit exceeded')
  }
  function append(parent, child, before = null) {
    if (roots.has(child))
      throw new Error('Component roots cannot be moved by a module')
    parent.insertBefore(child, before)
    const context = owner(parent)
    const retained = []
    const visit = (value) => {
      created.add(value)
      const record = nodes.get(ids.get(value))
      if (context) {
        if (record) {
          record.context = context
          retained.push(ids.get(value))
        }
        policy.bind(value, context)
      }
      for (const child of value.childNodes) visit(child)
    }
    visit(child)
    return retained
  }
  function setHTML(target, text) {
    if (String(text).length > 1024 * 1024)
      throw new Error('DOM markup limit exceeded')
    // Build detached, inert nodes before replacing anything. No browser HTML parser
    // ever sees attacker-controlled attributes, scripts or automatic resources.
    const tree =
        target.namespaceURI === SVG_NS
          ? parseFragment('<svg>' + String(text) + '</svg>').childNodes[0]
          : parseFragment(String(text)),
      fragment = document.createDocumentFragment()
    const build = (source, parent) => {
      if (source.nodeName === '#text') {
        parent.appendChild(document.createTextNode(source.value))
        return
      }
      if (source.nodeName === '#comment') return
      if (!source.tagName) throw new Error('Unsupported DOM namespace')
      const child = makeNode(source.tagName, source.namespaceURI)
      created.add(child)
      for (const attr of source.attrs)
        setAttribute(
          child,
          (attr.prefix ? attr.prefix + ':' : '') + attr.name,
          attr.value
        )
      for (const entry of source.childNodes || []) build(entry, child)
      parent.appendChild(child)
    }
    for (const child of tree.childNodes) build(child, fragment)
    target.replaceChildren()
    for (const child of [...fragment.childNodes]) append(target, child)
  }
  executor.expose('__vhtmlCollectDOM', (dead, pinned) => {
    for (const key of dead) {
      const record = nodes.get(key)
      if (record) record.held = false
    }
    for (const [key, record] of nodes) {
      if (!record.held && !owner(record.node)) {
        canvas.release(key)
        webgl.release(key)
        nodes.delete(key)
      }
    }
    return pinned.filter((key) => {
      const record = nodes.get(key)
      return !record || !owner(record.node)
    })
  })
  executor.expose('__vhtmlCanvasCall', (...args) => canvas.call(...args))
  executor.expose('__vhtmlWebGLCall', (...args) => webgl.call(...args))
  executor.capability('__vhtmlDOMCall', (action, key, arg, value, extra) => {
    if (action === 'create') return make(arg)
    if (action === 'createNS') return make(arg, String(value))
    if (action === 'text') return id(document.createTextNode(String(arg)), true)
    if (action === 'fragment')
      return id(document.createDocumentFragment(), true)
    if (action === 'describe') {
      const target = node(key)
      nodes.get(key).held = true
      return {
        type: target.nodeType,
        name: target.nodeName,
        namespace: target.namespaceURI,
        owned: !!owner(target),
      }
    }
    if (action === 'clone') {
      const copy = (source) => {
        if (!owner(source) && !created.has(source))
          throw new Error('Node is outside this module')
        const target =
          source.nodeType === 3
            ? document.createTextNode(source.nodeValue)
            : source.nodeType === 8
              ? document.createComment(source.nodeValue)
              : source.nodeType === 11
                ? document.createDocumentFragment()
                : makeNode(source.localName, source.namespaceURI)
        created.add(target)
        for (const attr of source.attributes || []) {
          // Compiler metadata is not a new DOM capability. Keep only style
          // ownership markers when a library clones an already rendered node.
          if (templateAttributes.has(attr.name)) {
            if (['vref', 'vrefof'].includes(attr.name))
              target.setAttribute(attr.name, attr.value)
          } else setAttribute(target, attr.name, attr.value)
        }
        if (source.nodeName === 'INPUT') {
          target.value = source.value
          target.checked = source.checked
        }
        if (source.nodeName === 'TEXTAREA') target.value = source.value
        if (arg)
          for (const child of source.childNodes) target.appendChild(copy(child))
        return target
      }
      return id(copy(node(key)))
    }
    if (action === 'query') return query(key, String(arg), false)
    if (action === 'queryAll') return query(key, String(arg), true)
    if (action === 'documentRoots') return rootsList().map((value) => id(value))
    if (action === 'event') {
      const event = events.get(key)
      if (
        [
          'preventDefault',
          'stopPropagation',
          'stopImmediatePropagation',
        ].includes(arg)
      )
        event?.[arg]()
      return
    }
    if (action === 'listen') return listen(key, arg, value, extra)
    if (action === 'unlisten') {
      removeListener(key)
      return
    }
    if (action === 'unobserve') {
      observers.get(key)?.observer.disconnect()
      observers.delete(key)
      return
    }
    if (action === 'observe') {
      if (observers.size >= 128)
        throw new Error('Module observer limit exceeded')
      const targets = key === 0 ? rootsList() : [node(key)],
        token = ++sequence
      const options =
        arg === 'mutation'
          ? {
              childList: !!extra?.childList,
              subtree: !!extra?.subtree,
              attributes: !!extra?.attributes,
              characterData: !!extra?.characterData,
              attributeOldValue: !!extra?.attributeOldValue,
              characterDataOldValue: !!extra?.characterDataOldValue,
              ...(extra?.attributeFilter
                ? { attributeFilter: [...extra.attributeFilter].map(String) }
                : {}),
            }
          : undefined
      const observer =
        arg === 'mutation'
          ? new window.MutationObserver((entries) => {
              if (closed) return
              const safe = entries
                .filter((entry) => id(entry.target))
                .map((entry) => ({
                  type: entry.type,
                  target: id(entry.target),
                  addedNodes: [...entry.addedNodes]
                    .map((entry) => id(entry))
                    .filter(Boolean),
                  removedNodes: [...entry.removedNodes]
                    .map((entry) => id(entry))
                    .filter(Boolean),
                  attributeName: entry.attributeName,
                  oldValue: entry.oldValue,
                }))
              if (safe.length) value(safe)
            })
          : new window.ResizeObserver((entries) => {
              if (closed) return
              value(
                entries
                  .filter((entry) => id(entry.target))
                  .map((entry) => ({
                    target: id(entry.target),
                    width: entry.contentRect.width,
                    height: entry.contentRect.height,
                  }))
              )
            })
      targets.forEach((target) => observer.observe(target, options))
      observers.set(token, { observer, key, options, type: arg })
      if (key)
        contextOf(key)?.scope.addCleanup(() => {
          observer.disconnect()
          observers.delete(token)
        })
      return token
    }
    const target = node(key),
      context = contextOf(key),
      scope = context?.scope
    if (action === 'svgRead') {
      if (target.namespaceURI !== SVG_NS)
        throw new Error('Expected a module SVG node')
      if (['viewBox', 'width', 'height', 'x', 'y'].includes(arg)) {
        const result = target[arg]?.baseVal
        return arg === 'viewBox'
          ? {
              x: result.x,
              y: result.y,
              width: result.width,
              height: result.height,
            }
          : { value: result?.value || 0 }
      }
      if (arg === 'transform') {
        const value = target.transform.baseVal.consolidate()?.matrix
        return value
          ? Object.fromEntries(
              ['a', 'b', 'c', 'd', 'e', 'f'].map((name) => [name, value[name]])
            )
          : null
      }
      if (
        ![
          'getBBox',
          'getCTM',
          'getScreenCTM',
          'getTotalLength',
          'getPointAtLength',
          'getComputedTextLength',
        ].includes(arg)
      )
        throw new Error('SVG geometry operation is unavailable')
      const result = target[arg](...(value || []).map(Number))
      if (result == null || typeof result === 'number') return result
      const fields =
        arg === 'getBBox'
          ? ['x', 'y', 'width', 'height']
          : arg === 'getPointAtLength'
            ? ['x', 'y']
            : ['a', 'b', 'c', 'd', 'e', 'f']
      return Object.fromEntries(fields.map((name) => [name, result[name]]))
    }
    if (
      action === 'setAttributeNS' ||
      action === 'attributeNS' ||
      action === 'removeAttributeNS'
    ) {
      if (![null, '', XLINK_NS, XML_NS, XMLNS_NS].includes(arg))
        throw new Error('Attribute namespace is unavailable')
      const name =
        arg === XLINK_NS
          ? 'xlink:' + String(value).split(':').pop()
          : arg === XML_NS
            ? 'xml:' + String(value).split(':').pop()
            : String(value)
      if (action === 'setAttributeNS') {
        setAttribute(target, name, extra)
        return
      }
      if (action === 'attributeNS') return policy.readAttribute(target, name)
      policy.attribute(target, name, null).catch(executor.onError)
      return
    }
    if (action === 'routerRead') {
      const router = context?.runtime.$sys.$router
      if (!router) return null
      if (arg === 'params' || arg === 'query') return { ...router[arg] }
      const current = router.current || {}
      return {
        path: current.path,
        fullPath: current.fullPath,
        hash: current.hash,
        params: { ...current.params },
        query: { ...current.query },
      }
    }
    if (action === 'routerCall') {
      const router = context?.runtime.$sys.$router
      if (!router) throw new Error('No router in this component')
      if (['push', 'replace', 'resolveHref'].includes(arg)) {
        policy.resources.resolve(String(value))
        const result = router[arg](String(value))
        return arg === 'resolveHref'
          ? result
          : Promise.resolve(result).then(() => undefined)
      }
      if (['setParams', 'setQuery'].includes(arg)) {
        const values = {}
        for (const [name, entry] of Object.entries(value || {})) {
          if (
            entry !== null &&
            !['string', 'number', 'boolean', 'undefined'].includes(typeof entry)
          )
            throw new TypeError('Router parameters must be scalar values')
          Object.defineProperty(values, name, {
            value: entry,
            enumerable: true,
          })
        }
        return Promise.resolve(router[arg](values)).then(() => undefined)
      }
      throw new Error('Router operation is not provided')
    }
    if (action === 'relative') {
      if (!domSchema.relatives.includes(arg))
        throw new Error('Unsupported DOM relation')
      return roots.has(target) &&
        [
          'parentNode',
          'parentElement',
          'nextSibling',
          'previousSibling',
          'nextElementSibling',
          'previousElementSibling',
        ].includes(arg)
        ? null
        : id(target[arg])
    }
    if (action === 'children')
      return [...target[arg === 'nodes' ? 'childNodes' : 'children']]
        .map((child) => id(child))
        .filter(Boolean)
    if (action === 'get') {
      if (!domSchema.read.includes(arg))
        throw new Error('DOM property is not provided')
      if (target.namespaceURI === SVG_NS && ['id', 'className'].includes(arg))
        return (
          policy.readAttribute(target, arg === 'className' ? 'class' : 'id') ||
          ''
        )
      return target[arg]
    }
    if (action === 'set') {
      if (
        ['SCRIPT', 'STYLE', 'LINK'].includes(target.nodeName) ||
        !domSchema.write.includes(arg)
      )
        throw new Error('DOM property is not writable')
      if (['width', 'height'].includes(arg) && target.nodeName === 'CANVAS')
        checkCanvasSize(target, arg, value)
      if (
        !['string', 'number', 'boolean'].includes(typeof value) &&
        value != null
      )
        throw new TypeError('DOM values must be scalar')
      if (
        target.namespaceURI === SVG_NS &&
        ['id', 'className', 'width', 'height'].includes(arg)
      )
        setAttribute(target, arg === 'className' ? 'class' : arg, value)
      else target[arg] = value
      return
    }
    if (action === 'attribute') return policy.readAttribute(target, String(arg))
    if (action === 'setAttribute') {
      setAttribute(target, arg, value)
      return
    }
    if (action === 'removeAttribute') {
      policy.checkAttribute(arg)
      policy.attribute(target, String(arg), null).catch(executor.onError)
      return
    }
    if (action === 'styleGet')
      return target.style.getPropertyValue(cssProperty(String(arg)))
    if (action === 'styleText') return target.style.cssText
    if (action === 'styleSet') {
      setStyle(target, arg, value, extra)
      return
    }
    if (action === 'computed')
      return window
        .getComputedStyle(target)
        .getPropertyValue(cssProperty(String(arg)))
    if (action === 'rect') {
      const rect = target.getBoundingClientRect()
      return Object.fromEntries(
        'x y top left right bottom width height'
          .split(' ')
          .map((name) => [name, rect[name]])
      )
    }
    if (action === 'contains') return target.contains(node(arg))
    if (action === 'compare') return target.compareDocumentPosition(node(arg))
    if (action === 'matches')
      return target.matches(policy.svg.selector(String(arg)))
    if (action === 'append') {
      return append(target, node(arg), value == null ? null : node(value))
    }
    if (action === 'remove') {
      const child = node(arg)
      if (roots.has(child) || child.parentNode !== target)
        throw new Error('Cannot remove this node')
      target.removeChild(child)
      created.add(child)
      return arg
    }
    if (action === 'html') {
      if (
        !htmlElements.has(target.localName) &&
        !roots.has(target) &&
        target.namespaceURI !== SVG_NS
      )
        throw new Error('Markup target is unavailable')
      setHTML(target, arg)
      return
    }
    if (action === 'htmlRead') return target.innerHTML
    if (action === 'focus') {
      target.focus()
      return
    }
    if (action === 'blur') {
      target.blur()
      return
    }
    if (action === 'cleanup') {
      if (scope.phase === 'disposed') value()
      else context.cleanups.add(value)
      return
    }
    if (action === 'mount') {
      scope.onMount(() => value())
      return
    }
    if (['active', 'deactive', 'dispose'].includes(action)) {
      scope['on' + action[0].toUpperCase() + action.slice(1)](() => value())
      return
    }
    if (action === 'emit') {
      context.runtime.$sys.$emit?.(String(arg), ...value)
      return
    }
    throw new Error(`DOM operation ${action} is not provided`)
  })
  executor.bootstrap(
    `(${initializeDOMRealm.toString()})(__vhtmlDOMCall,__vhtmlCanvasCall,${JSON.stringify(domSchema)},${JSON.stringify({ devicePixelRatio: window.devicePixelRatio || 1 })},${initializeWebGLRealm.toString()},__vhtmlWebGLCall,${JSON.stringify(webglTypes)},${createWeakHandles.toString()},__vhtmlCollectDOM)`,
    { maintenance: true }
  )
  return {
    attach(root, scope, runtime) {
      const context = { scope, runtime, closed: false, cleanups: new Set() }
      roots.set(root, context)
      policy.bind(root, context)
      const prevent = (event) => event.preventDefault()
      root.addEventListener('submit', prevent, true)
      const preventNavigation = (event) => {
        if (event.target.closest?.('a')) event.preventDefault()
      }
      root.addEventListener('click', preventNavigation, true)
      for (const record of listeners.values())
        if (record.virtualRoot && !record.targets.includes(root)) {
          root.addEventListener(record.type, record.handler, record.capture)
          record.targets.push(root)
        }
      for (const record of observers.values())
        if (record.key === 0) record.observer.observe(root, record.options)
      context.dispose = () => {
        if (context.closed) return
        for (const cleanup of closed ? [] : context.cleanups) {
          try {
            cleanup()
          } catch (error) {
            executor.onError(error)
          }
        }
        context.cleanups.clear()
        context.closed = true
        roots.delete(root)
        root.removeEventListener('submit', prevent, true)
        root.removeEventListener('click', preventNavigation, true)
        for (const [token, record] of listeners) {
          if (record.virtualRoot) {
            root.removeEventListener(
              record.type,
              record.handler,
              record.capture
            )
            record.targets = record.targets.filter((target) => target !== root)
          } else if (nodes.get(record.key)?.context === context)
            removeListener(token)
        }
        for (const [key, record] of nodes)
          if (record.context === context) {
            canvas.release(key)
            webgl.release(key)
            nodes.delete(key)
          }
      }
      scope.addCleanup(context.dispose)
      return executor.invoke('__vhtmlDOMContext', id(root))
    },
    value(value) {
      if (value?.nodeType) return executor.invoke('__vhtmlDOMNode', id(value))
      if (typeof Event !== 'undefined' && value instanceof Event)
        return executor.invoke('__vhtmlDOMEvent', snapshot(value))
    },
    dispose() {
      if (closed) return
      closed = true
      for (const context of roots.values()) context.dispose()
      for (const token of [...listeners.keys()]) removeListener(token)
      for (const { observer } of observers.values()) observer.disconnect()
      observers.clear()
      canvas.dispose()
      webgl.dispose()
      roots.clear()
      nodes.clear()
      events.clear()
    },
  }
}
