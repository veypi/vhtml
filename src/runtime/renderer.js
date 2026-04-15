/*
 * v.js
 * Copyright (C) 2024 veypi <i@veypi.com>
 *
 * Distributed under terms of the GPL license.
 */
import vget from '../vget.js'
import vproxy from '../vproxy.js'
import vrouter from '../vrouter.js'
import { parseAttrs as parseAttrsRuntime, parseAHref as parseAHrefRuntime, parseAttr as parseAttrRuntime, handleStyle as handleStyleRuntime, handleEvent as handleEventRuntime } from './attributes.js'
import { parseTextNode as parseTextNodeRuntime, parseVfor as parseVforRuntime, parseVif as parseVifRuntime } from './structure.js'
import { parseSlots as parseSlotsRuntime } from './slots.js'
import { parseRaw as parseRawRuntime, parseRef as parseRefRuntime, setupRef as setupRefRuntime, mountRef as mountRefRuntime } from './component.js'
import { clearParsed, disposeRuntimeSubtree, findNearestInstance, getRuntime, getScope, getSourceNodes, isParsed, markParsed, setSourceNodes } from './dom.js'

let rendererBootstrapped = false

function ensureRendererRuntime() {
  if (rendererBootstrapped) {
    return
  }
  rendererBootstrapped = true

  const globalStyle = document.createElement('style')
  globalStyle.innerHTML = `
    [vref] {
      display: block;
    }
    [vparsing] {
      display: none;
      -webkit-text-fill-color: transparent;
    }
    vslot, vrouter {
      display: block;
    }
    vrouter {
      height: 100%;
      width: 100%;
      overflow: auto;
    }
`
  if (document.head.firstChild) {
    document.head.insertBefore(globalStyle, document.head.firstChild)
  } else {
    document.head.appendChild(globalStyle)
  }
  const DelayCache = []
  const pendingDisposals = new WeakMap()
  const config = { attributes: false, childList: true, subtree: true, characterData: false }
  const runVdelay = (d) => {
    if (!d.isConnected) {
      return
    }
    let delay = d.getAttribute('vdelay')
    if (delay) {
      let fc = DelayCache[delay]
      if (fc) {
        fc(d)
      } else {
        console.error('delay not found:', delay, d)
      }
    }
  }
  const cancelPendingDisposal = (node) => {
    if (!node || node.nodeType !== 1) {
      return
    }
    const timer = pendingDisposals.get(node)
    if (timer) {
      cancelAnimationFrame(timer)
      pendingDisposals.delete(node)
    }
    node.querySelectorAll?.('*').forEach((child) => {
      const childTimer = pendingDisposals.get(child)
      if (childTimer) {
        cancelAnimationFrame(childTimer)
        pendingDisposals.delete(child)
      }
    })
  }
  const disposeNodeScope = (node) => {
    if (!node || node.nodeType !== 1) {
      return
    }
    if (!node.isConnected) {
      disposeRuntimeSubtree(node)
    }
  }
  const scheduleDisposeNodeScope = (node) => {
    if (!node || node.nodeType !== 1) {
      return
    }
    if (node.hasAttribute?.('data-vrouter-cache') || node.hasAttribute?.('data-vrouter-layout')) {
      return
    }
    cancelPendingDisposal(node)
    const timer = requestAnimationFrame(() => {
      pendingDisposals.delete(node)
      if (!node.isConnected) {
        disposeNodeScope(node)
      }
    })
    pendingDisposals.set(node, timer)
  }
  const callback = function(mutationsList, observer) {
    mutationsList.forEach(function(mutation) {
      for (let node of mutation.addedNodes) {
        if (node.nodeType === 1) { // 元素节点
          cancelPendingDisposal(node)
          runVdelay(node)
          node.querySelectorAll('*[vdelay]').forEach(runVdelay)
        }
      }
      for (let node of mutation.removedNodes) {
        scheduleDisposeNodeScope(node)
      }
    })
  }
  const observer = new MutationObserver(callback);
  observer.observe(document.body, config);

  function findLastAccess(code, data) {
    code = `with (sandbox) { ${code} }`
    const fn = new Function('sandbox', code);
    let res = {
      data: null,
      key: null,
    }
    const wrap = (tmp) => {
      return new Proxy(tmp, {
        // 拦截所有属性，防止到 Proxy 对象以外的作用域链查找。
        has(target, key) {
          return true;
        },
        get(target, key, receiver) {
          if (key === Symbol.unscopables) {
            return undefined;
          }
          let v = Reflect.get(target, key, receiver);
          res.data = target
          res.key = key
          if (typeof v === 'function') {
            console.warn('vhtml not support function with "v:" variables bind')
          }
          if (typeof v === 'object' && v) {
            return wrap(v)
          }
          return v
        },
        set(target, key, newValue, receiver) {
          // console.log('set', target, key, newValue)
          // return Reflect.set(target, key, newValue, receiver);
          return false
        }
      })
    }
    fn(wrap(data))
    return res
  }

  class vhtml {
    /** @type {HTMLElement} */
    app = null
    modulePath = null
    vget = vget
    vproxy = vproxy
    Wrap = vproxy.Wrap
    __noproxy = true
    $router = vrouter.$router
    constructor(id) {
      if (typeof id === 'string') {
        this.app = document.getElementById(id)
      } else if (id instanceof HTMLElement) {
        this.app = id
      } else {
        this.app = document.body
      }
      if (!this.app) {
        console.error(`Can't find element by id: ${id}`)
        return
      }
      let init = async () => {
        // vget.SetBaseFile(await vget.FetchFile(window.location.pathname))
        let mainParser = await vget.FetchUI(window.location.pathname, {}, true)
        this.modulePath = mainParser.mod?.scoped || ''
        this.parseRef('root', this.app, {}, mainParser.mod || {}, mainParser, true)
      }
      init()
    }
    watch(scope, target, callback, options) {
      const id = vproxy.Watch(target, callback, options)
      scope?.addWatcher(() => vproxy.Cancel(id))
      return id
    }
    findLastAccess(code, data) {
      return findLastAccess(code, data)
    }
    runtimeOf(node, fallbackRuntime = null) {
      if (!node) {
        return {
          instance: null,
          scope: null,
          runtime: fallbackRuntime,
        }
      }
      const instance = findNearestInstance(node, null)
      const nodeScope = getScope(node)
      const nodeRuntime = getRuntime(node)
      return {
        instance,
        scope: nodeScope || instance?.scope || null,
        runtime: nodeRuntime || instance?.runtime || fallbackRuntime,
      }
    }
    scopeOf(node) {
      return this.runtimeOf(node).scope
    }
    /**
    * @param{HTMLElement} dom
    * @param {Object} scopedData
     * */
    async parseDom(dom, scopedData = {}, runtime, scope = this.scopeOf(dom)) {
      if (runtime instanceof HTMLElement) {
        console.log(runtime)
        throw new Error('runtime error')
      }
      const nodeRuntime = this.runtimeOf(dom, runtime)
      const runtimeScope = scope || nodeRuntime.scope
      const activeRuntime = nodeRuntime.runtime || runtime
      let nodeName = dom.nodeName.toLowerCase()
      if (dom.nodeType === 3) {
        this.parseTextNode(dom, scopedData, activeRuntime, runtimeScope)
        return
      } else if (dom.nodeType === 8) {
        // comment node
        dom.remove()
        return
      } else if (dom.nodeType !== 1) {
        console.log('Other Node Type:', dom.nodeType, dom);
        return
      }
      if (dom.hasAttribute('no-vhtml') || isParsed(dom)) {
        return
      }
      if (!getSourceNodes(dom)) {
        setSourceNodes(dom, Array.from(dom.childNodes).map((node) => node.cloneNode(true)))
      }

      let vfortxt = dom.getAttribute('v-for')
      if (vfortxt !== null) {
        this.parseVfor(vfortxt, dom, scopedData, activeRuntime)
        return
      }
      if (nodeName.indexOf('-') !== -1) {
        let url = '/' + nodeName.split('-').join('/')
        let singleMode = dom.hasAttribute('single')
        this.parseRef(url, dom, scopedData, activeRuntime, null, singleMode)
        markParsed(dom)
        return
      }
      if (dom.getAttribute(':vsrc')) {
        let code = dom.getAttribute(':vsrc')
        dom.removeAttribute(':vsrc')
        let attrs = Array.from(dom.attributes).map(a => {
          let res = { name: a.name, value: a.value }
          return res
        })
        let oldChilds = Array.from(dom.childNodes)
        this.watch(runtimeScope, () => {
          clearParsed(dom)
          dom.setAttribute('vparsing', '')
          let vsrc = vproxy.Run(code, scopedData, activeRuntime)
          if (!vsrc) {
            return
          }
          Array.from(dom.attributes).forEach(a => { dom.removeAttribute(a.name) })
          dom.innerHTML = ''
          attrs.forEach(a => { dom.setAttribute(a.name, a.value) })
          oldChilds.forEach(c => { dom.appendChild(c.cloneNode(true)) })
          this.parseRef(vsrc, dom, scopedData, activeRuntime, null, false)
          markParsed(dom)
        })
        return
      }
      if (dom.getAttribute('vsrc')) {
        let singleMode = dom.hasAttribute('single')
        this.parseRef(dom.getAttribute('vsrc'), dom, scopedData, activeRuntime, null, singleMode)
        markParsed(dom)
        return
      }
      if (nodeName === 'div' && dom.getAttribute('v-html')) {
        let vhtmlCode = dom.getAttribute('v-html')
        dom.removeAttribute('v-html')
        dom.innerHTML = ''
        this.parseAttrs(dom, scopedData, activeRuntime)
        markParsed(dom)
        this.watch(runtimeScope, () => {
          let innerHTML = vproxy.Run(vhtmlCode, scopedData, activeRuntime)
          dom.innerHTML = innerHTML
          let childs = this.parseVif(Array.from(dom.childNodes), scopedData, activeRuntime)
          for (let n of childs) {
            this.parseDom(n, scopedData, activeRuntime, runtimeScope)
          }
        })
        return
      }
      if (nodeName === 'vslot') {
        this.parseSlots(dom, scopedData, activeRuntime)
        markParsed(dom)
        return
      }
      if (nodeName === 'vrouter') {
        this.parseAttrs(dom, scopedData, activeRuntime)
        vrouter.$router.mountView(this, dom, activeRuntime)
        return
      }
      this.parseAttrs(dom, scopedData, activeRuntime)
      let childs = this.parseVif(Array.from(dom.childNodes), scopedData, activeRuntime)
      for (let n of childs) {
        this.parseDom(n, scopedData, activeRuntime, runtimeScope)
      }
      markParsed(dom)
    }

    onMountedRun(dom, cb, once = true) {
      if (once) {
        if (dom.isConnected) {
          cb(dom)
          return
        }
        let did = DelayCache.push((dom) => {
          dom.removeAttribute('vdelay')
          cb(dom)
        })
        dom.setAttribute('vdelay', did - 1)
        return
      }
      if (dom.isConnected) {
        cb(dom)
      }
      let did = DelayCache.push(cb)
      dom.setAttribute('vdelay', did - 1)
    }

    async parseRaw(dom, data, runtime, code) {
      return parseRawRuntime(this, dom, data, runtime, code)
    }

    /**
    * @param{string} name
    * @param{HTMLElement} dom
     * */
    async parseRef(vsrc, dom, data, runtime, target, singleMode = false) {
      return parseRefRuntime(this, vsrc, dom, data, runtime, target, singleMode)
    }

    /**
    * @param {HTMLElement} dom
    * @parm {Object} data
    * @param {{heads:HTMLElement[],body:HTMLElement,scripts:HTMLElement[],setup:HTMLElement}} target
     * */
    async setupRef(dom, data, runtime, target, singleMode = false) {
      return setupRefRuntime(this, dom, data, runtime, target, singleMode)
    }

    async mountRef(dom, scopedData, runtime, target) {
      return mountRefRuntime(this, dom, scopedData, runtime, target)
    }

    parseAttrs(dom, data, runtime, attrs) {
      return parseAttrsRuntime(this, dom, data, runtime, attrs)
    }

    parseAHref(dom, data, runtime) {
      return parseAHrefRuntime(this, dom, data, runtime)
    }

    /**
    * @param {HTMLElement} dom
     * */
    parseAttr(dom, name, value, data, runtime) {
      return parseAttrRuntime(this, dom, name, value, data, runtime)
    }
    handleStyle(dom, attrName, value, data, runtime) {
      return handleStyleRuntime(this, dom, attrName, value, data, runtime)
    }
    handleEvent(dom, name, value, data, runtime) {
      return handleEventRuntime(this, dom, name, value, data, runtime)
    }

    parseTextNode(dom, data, runtime, scope = this.scopeOf(dom)) {
      return parseTextNodeRuntime(this, dom, data, runtime, scope)
    }
    parseVfor(vfortxt, dom, data, runtime) {
      return parseVforRuntime(this, vfortxt, dom, data, runtime)
    }

    parseVif(nodes, data, runtime) {
      return parseVifRuntime(this, nodes, data, runtime)
    }


    /**
    * @param {HTMLElement} dom
     * */
    parseSlots(dom, data, runtime) {
      return parseSlotsRuntime(this, dom, data, runtime)
    }
  }
  window.__VhtmlRuntime__ = vhtml
}

export function createVhtmlApp(target = document.body) {
  ensureRendererRuntime()
  const Runtime = window.__VhtmlRuntime__
  return new Runtime(target)
}

export function bootstrapVhtml(target = document.body) {
  ensureRendererRuntime()
  if (window.$vhtml) {
    console.error('vhtml already exists.')
    return window.$vhtml
  }
  window.$vhtml = createVhtmlApp(target)
  return window.$vhtml
}

export default { bootstrapVhtml, createVhtmlApp }
