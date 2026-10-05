// Shared lookup semantics; serialized into QuickJS without host closures.
export function createExecutionScope(
  data,
  mod,
  sys,
  locals = {},
  platform = globalThis,
  missing
) {
  return new Proxy(data, {
    has: () => true,
    get(target, key, receiver) {
      if (key === Symbol.unscopables) return undefined
      if (key === '$data') return data
      if (key === '$mod') return mod
      if (key === '$sys') return sys
      for (const pool of [data, mod, sys, locals]) {
        if (pool && key in pool)
          return pool === data ? Reflect.get(target, key, receiver) : pool[key]
      }
      const value = platform[key]
      if (value === undefined) missing?.(key)
      return value
    },
    set: (target, key, value, receiver) =>
      Reflect.set(target, key, value, receiver),
  })
}

// Serialized into the isolated engine together with createReactiveCore. No host closures.
export function initializeRealm(createReactiveCore, createExecutionScope) {
  const core = createReactiveCore({
    schedule: (callback) => Promise.resolve().then(callback),
  })
  const scopes = new Map(),
    refs = new Map(),
    identities = new WeakMap(),
    subscriptions = new Map()
  const functions = new Map()
  let nextScope = 0,
    nextRef = 0,
    nextSubscription = 0
  const global = globalThis
  global.window = global.self = global
  function pack(value) {
    if (value === undefined) return { type: 'undefined' }
    if (typeof value === 'bigint')
      return { type: 'bigint', value: String(value) }
    if (
      value === null ||
      (typeof value !== 'object' && typeof value !== 'function')
    )
      return { type: 'value', value }
    let id = identities.get(value)
    if (!id) {
      id = ++nextRef
      identities.set(value, id)
    }
    refs.set(id, value)
    return {
      type:
        value instanceof Promise
          ? 'promise'
          : typeof value === 'function'
            ? 'function'
            : Array.isArray(value)
              ? 'array'
              : 'object',
      id,
      identity: value[core.DataID] || id,
    }
  }
  const frame = (id) => {
    const result = scopes.get(id)
    if (!result) throw new Error('Component scope is disposed')
    return result
  }
  const create = (input, mod, sys) => {
    const id = ++nextScope,
      data = core.Wrap(input)
    const record = {
      data,
      mod: core.Wrap(mod),
      sys,
      watches: new Set(),
      pendingWatches: null,
      locals: {},
    }
    record.locals.$watch = (target, callback, options) => {
      let handle,
        cancelled = false
      const register = () => {
        if (!cancelled) {
          handle = core.Watch(target, callback, options)
          record.watches.add(handle)
        }
      }
      if (record.pendingWatches) record.pendingWatches.push(register)
      else register()
      return () => {
        cancelled = true
        core.Cancel(handle)
        record.watches.delete(handle)
      }
    }
    scopes.set(id, record)
    return id
  }
  function compile(body, async) {
    const key = `${async}:${body}`
    if (!functions.has(key)) {
      if (functions.size >= 512) functions.delete(functions.keys().next().value)
      const Constructor = async
        ? Object.getPrototypeOf(async function () {}).constructor
        : Function
      functions.set(key, new Constructor('scope', `with(scope){\n${body}\n}`))
    }
    return key
  }
  function run(id, body, async, locals = {}, data) {
    const record = frame(id)
    // Each invocation has its own locals, including across await and event reentry.
    const scope = createExecutionScope(
      data === undefined ? record.data : data,
      record.mod,
      record.sys,
      { ...record.locals, ...locals },
      global
    )
    const key = compile(body, async)
    return functions.get(key).call(global, scope)
  }
  function operation(op, args) {
    const [object, key, value] = args
    switch (op) {
      case 'run':
        return run(...args)
      case 'get':
        return object[key]
      case 'set':
        object[key] = value
        return true
      case 'has':
        return key in object
      case 'delete':
        return delete object[key]
      case 'keys':
        return Object.keys(object)
      case 'call':
        return object.apply(key, value)
      case 'wrap':
        return core.Wrap(object, key)
      case 'root':
        core.SetDataRoot(object, key)
        return true
      case 'define':
        core.defineProperty(...args)
        return true
      case 'data':
        return frame(object).data
      default:
        throw new Error(`Unknown operation ${op}`)
    }
  }
  return {
    create,
    run,
    pack,
    compile,
    initializeModule(id, busSource, i18nSource) {
      const mod = frame(id).mod
      const Bus = Function(`return (${busSource})()`)()
      const I18n = Function(`return (${i18nSource})`)()(core.Wrap)
      const bus = new Bus(),
        i18n = new I18n(core.Wrap({ locale: 'zh-CN', fallback: 'en-US' }))
      const builtins = {
        scoped: mod.scoped,
        fetch: global.fetch,
        $bus: bus,
        $i18n: i18n,
        $t: (key, params) => i18n.t(key, params),
        define: (name, value, options) =>
          core.defineProperty(mod, name, value, options),
      }
      for (const [name, value] of Object.entries(builtins)) {
        delete mod[name]
        core.defineProperty(mod, name, value, {
          writable: false,
          configurable: false,
        })
      }
    },
    beginSetup(id) {
      frame(id).pendingWatches = []
    },
    finishSetup(id) {
      const record = frame(id),
        queue = record.pendingWatches || []
      record.pendingWatches = null
      queue.forEach((register) => register())
    },
    data: (id) => frame(id).data,
    ref: (id) => {
      if (!refs.has(id)) throw new Error('Released module value')
      return refs.get(id)
    },
    release: (id) => refs.delete(id),
    transfer(op, args, notify) {
      if (!notify) return { result: pack(operation(op, args)), subscription: 0 }
      const id = ++nextSubscription
      const captured = core.capture(
        () => operation(op, args),
        () => global.__vhtmlNotify(id)
      )
      subscriptions.set(id, captured.cancel)
      return { result: pack(captured.value), subscription: id }
    },
    cancel(id) {
      subscriptions.get(id)?.()
      subscriptions.delete(id)
    },
    stats: () => core.stats,
    bind(id, name, namespace, imported, data) {
      Object.defineProperty(data === undefined ? frame(id).data : data, name, {
        enumerable: true,
        configurable: true,
        get: () => (imported === '*' ? namespace : namespace[imported]),
      })
    },
    drop(id) {
      const record = scopes.get(id)
      if (!record) return
      record.watches.forEach(core.Cancel)
      scopes.delete(id)
    },
  }
}
