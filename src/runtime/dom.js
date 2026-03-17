import { detachInstance } from './instance.js'

const nodeStore = new WeakMap()
const publicApiBound = new WeakSet()

function getStore(node, create = false) {
  if (!node) {
    return null
  }
  let store = nodeStore.get(node)
  if (!store && create) {
    store = {}
    nodeStore.set(node, store)
  }
  return store
}

function deleteValue(node, key) {
  const store = getStore(node)
  if (!store) {
    return
  }
  delete store[key]
  if (Object.keys(store).length === 0) {
    nodeStore.delete(node)
  }
}

function readValue(node, key, fallback = null) {
  return getStore(node)?.[key] ?? fallback
}

function writeValue(node, key, value) {
  if (value === undefined || value === null) {
    deleteValue(node, key)
    return value
  }
  getStore(node, true)[key] = value
  return value
}

function ensurePublicNodeAPI(node) {
  if (!node || publicApiBound.has(node)) {
    return
  }
  Object.defineProperties(node, {
    $data: {
      configurable: true,
      enumerable: false,
      get() {
        return getData(node)
      },
    },
    $sys: {
      configurable: true,
      enumerable: false,
      get() {
        return getSys(node)
      },
    },
    $ctx: {
      configurable: true,
      enumerable: false,
      get() {
        return getCtx(node)
      },
    },
    $mod: {
      configurable: true,
      enumerable: false,
      get() {
        return getMod(node)
      },
    },
    $router: {
      configurable: true,
      enumerable: false,
      get() {
        return getRouter(node)
      },
    },
  })
  publicApiBound.add(node)
}

export function getInstance(node) {
  return readValue(node, 'instance')
}

export function setInstance(node, instance) {
  ensurePublicNodeAPI(node)
  return writeValue(node, 'instance', instance)
}

export function findNearestInstance(node, fallback = null) {
  let current = node
  while (current) {
    const instance = getInstance(current)
    if (instance) {
      return instance
    }
    current = current.parentNode || current.host || null
  }
  return fallback
}

export function getScope(node) {
  return getInstance(node)?.scope ?? readValue(node, 'scope')
}

export function setScope(node, scope) {
  const instance = getInstance(node)
  if (instance) {
    instance.scope = scope || null
  }
  return writeValue(node, 'scope', scope)
}

export function getRuntime(node) {
  return getInstance(node)?.runtime ?? readValue(node, 'runtime')
}

export function setRuntime(node, runtime) {
  ensurePublicNodeAPI(node)
  const instance = getInstance(node)
  if (instance) {
    instance.runtime = runtime || null
    instance.sys = runtime?.$sys || null
    instance.ctx = runtime?.$ctx || null
    instance.mod = runtime?.$mod || null
  }
  writeValue(node, 'sys', runtime?.$sys || null)
  writeValue(node, 'ctx', runtime?.$ctx || null)
  writeValue(node, 'mod', runtime?.$mod || null)
  return writeValue(node, 'runtime', runtime)
}

export function getSys(node) {
  return getInstance(node)?.sys ?? readValue(node, 'sys')
}

export function setSys(node, sys) {
  ensurePublicNodeAPI(node)
  const instance = getInstance(node)
  if (instance) {
    instance.sys = sys || null
  }
  return writeValue(node, 'sys', sys)
}

export function getCtx(node) {
  return getInstance(node)?.ctx ?? readValue(node, 'ctx')
}

export function setCtx(node, ctx) {
  ensurePublicNodeAPI(node)
  const instance = getInstance(node)
  if (instance) {
    instance.ctx = ctx || null
  }
  return writeValue(node, 'ctx', ctx)
}

export function getMod(node) {
  return getInstance(node)?.mod ?? readValue(node, 'mod')
}

export function setMod(node, mod) {
  ensurePublicNodeAPI(node)
  const instance = getInstance(node)
  if (instance) {
    instance.mod = mod || null
  }
  return writeValue(node, 'mod', mod)
}

export function getModulePath(node) {
  return getMod(node)?.scoped || ''
}

export function setModulePath(node, modulePath) {
  const mod = getMod(node)
  if (mod && typeof mod === 'object') {
    mod.scoped = modulePath || ''
  }
  return writeValue(node, 'scoped', modulePath)
}

export function getRouter(node) {
  return getInstance(node)?.router ?? readValue(node, 'router')
}

export function setRouter(node, router) {
  ensurePublicNodeAPI(node)
  const instance = getInstance(node)
  if (instance) {
    instance.router = router || null
  }
  return writeValue(node, 'router', router)
}

export function findNearestRouter(node, fallback = null) {
  let current = node
  while (current) {
    const router = getRouter(current)
    if (router) {
      return router
    }
    current = current.parentNode || current.host || null
  }
  return fallback
}

export function getVsrc(node) {
  const instance = getInstance(node)
  return instance?.vsrc ?? readValue(node, 'vsrc', '')
}

export function setVsrc(node, value) {
  const instance = getInstance(node)
  if (instance) {
    instance.vsrc = value || ''
  }
  return writeValue(node, 'vsrc', value || null)
}

export function getEvents(node) {
  return getInstance(node)?.events ?? readValue(node, 'events')
}

export function ensureEvents(node) {
  const instance = getInstance(node)
  if (instance) {
    if (!instance.events) {
      instance.events = {}
    }
  }
  const store = getStore(node, true)
  if (!store.events) {
    store.events = {}
  }
  return instance?.events || store.events
}

export function getData(node) {
  return getInstance(node)?.data ?? readValue(node, 'data')
}

export function setData(node, value) {
  ensurePublicNodeAPI(node)
  const instance = getInstance(node)
  if (instance) {
    instance.data = value || null
  }
  return writeValue(node, 'data', value)
}

export function getSlotContents(node) {
  return getInstance(node)?.slots ?? readValue(node, 'slotContents')
}

export function setSlotContents(node, value) {
  const instance = getInstance(node)
  if (instance) {
    instance.slots = value || null
  }
  return writeValue(node, 'slotContents', value)
}

export function getSlotOutletState(node) {
  return getInstance(node)?.slotOutletState ?? readValue(node, 'slotOutletState')
}

export function setSlotOutletState(node, value) {
  const instance = getInstance(node)
  if (instance) {
    instance.slotOutletState = value || null
  }
  return writeValue(node, 'slotOutletState', value)
}

export function getSourceNodes(node) {
  return getInstance(node)?.sourceNodes ?? readValue(node, 'sourceNodes')
}

export function setSourceNodes(node, value) {
  const instance = getInstance(node)
  if (instance) {
    instance.sourceNodes = value || null
  }
  return writeValue(node, 'sourceNodes', value)
}

export function getVforData(node) {
  return getInstance(node)?.vforData ?? readValue(node, 'vforData')
}

export function setVforData(node, value) {
  const instance = getInstance(node)
  if (instance) {
    instance.vforData = value || null
  }
  return writeValue(node, 'vforData', value)
}

export function isParsed(node) {
  const instance = getInstance(node)
  return !!(instance?.parsed ?? readValue(node, 'parsed', false))
}

export function markParsed(node, value = true) {
  const instance = getInstance(node)
  if (instance) {
    instance.parsed = value
  }
  getStore(node, true).parsed = value
  return value
}

export function clearParsed(node) {
  deleteValue(node, 'parsed')
}

function purgeNodeState(node, preserveSourceNodes = true) {
  if (!node) {
    return
  }
  const sourceNodes = getSourceNodes(node)
  const instance = getInstance(node)
  nodeStore.delete(node)
  if (instance) {
    detachInstance(instance)
    setInstance(node, null)
  }
  if (preserveSourceNodes && sourceNodes !== undefined) {
    setSourceNodes(node, sourceNodes)
  }
}

function disposeInstanceSubtree(instance) {
  if (!instance) {
    return
  }
  const children = Array.from(instance.children)
  children.forEach((child) => {
    disposeInstanceSubtree(child)
  })
  instance.scope?.dispose(instance.host)
  purgeNodeState(instance.host)
}

export function disposeRuntimeSubtree(node) {
  if (!node || node.nodeType !== 1) {
    return
  }
  const instance = getInstance(node)
  if (instance) {
    disposeInstanceSubtree(instance)
    return
  }
  getScope(node)?.dispose(node)
  purgeNodeState(node)
  node.childNodes?.forEach((child) => {
    if (child.nodeType === 1) {
      disposeRuntimeSubtree(child)
    }
  })
}

export function clearNodeState(node) {
  purgeNodeState(node)
}
