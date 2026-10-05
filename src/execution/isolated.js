import { newQuickJSWASMModuleFromVariant, variant } from '../vendor/quickjs.js'
import { prepareSource, expressionBody } from './source.js'
import { createReactiveCore } from '../reactive-core.js'
import { initializeRealm, createExecutionScope } from './realm.js'
import { DataID, trackExternal } from '../reactive.js'
import { foreignValue, registerForeign } from './foreign.js'

let enginePromise
let nextExecutor = 0
const getEngine = () =>
  (enginePromise ||= newQuickJSWASMModuleFromVariant(variant))

export class IsolatedExecutor {
  static async create(resources, options = {}) {
    const engine = await getEngine()
    return new IsolatedExecutor(engine, resources, options)
  }

  #vm
  #runtime
  #api
  #sources = new Map()
  #sourceJobs = new Map()
  #modules = new Map()
  #imports = new Map()
  #promises = new Set()
  #timers = new Map()
  #nextTimer = 0
  #deadline = Infinity
  #depth = 0
  #scheduled = false
  #disposed = false
  #fatal = null
  #maintenance = []
  #argumentMapper
  #disposeCallbacks = new Set()
  #views = new Map()
  #identity = ++nextExecutor
  #viewVersion = 0
  #subscriptions = new Map()
  #finalizer = new FinalizationRegistry(({ id, version }) => {
    if (!this.#disposed && this.#views.get(id)?.version === version) {
      this.#views.delete(id)
      this.#call('release', id).dispose()
    }
  })

  constructor(
    engine,
    resources,
    {
      timeLimit = 250,
      memoryLimit = 32 * 1024 * 1024,
      onError = console.error,
    } = {}
  ) {
    this.resources = resources
    this.timeLimit = timeLimit
    this.onError = onError
    this.#runtime = engine.newRuntime()
    this.#runtime.setMemoryLimit(memoryLimit)
    this.#runtime.setMaxStackSize(512 * 1024)
    this.#runtime.setInterruptHandler(
      () => this.#disposed || Date.now() > this.#deadline
    )
    this.#runtime.setModuleLoader(
      (name) => {
        const source = this.#sources.get(name)
        if (source === undefined)
          throw new Error(`Module was not prepared: ${name}`)
        return source
      },
      (base, name) => this.resources.resolve(name, { from: base }).href
    )
    this.#vm = this.#runtime.newContext()
    this.#api = this.#take(
      this.#vm.evalCode(
        `(${initializeRealm.toString()})(${createReactiveCore.toString()}, ${createExecutionScope.toString()})`
      )
    )
    this.#installImport()
    this.#installTimers()
    this.expose('__vhtmlNotify', (id) => this.#subscriptions.get(id)?.())
    this.expose('console', {
      log: (...args) => console.log('[vhtml module]', ...args),
      warn: (...args) => console.warn('[vhtml module]', ...args),
      error: (...args) => console.error('[vhtml module]', ...args),
    })
  }

  #assertAlive() {
    if (this.#disposed) throw new Error('Module executor is disposed')
  }

  #take(result) {
    if (result.error) {
      const detail = this.#vm.dump(result.error)
      result.error.dispose()
      const error = new Error(detail?.message || String(detail))
      error.name = detail?.name || 'Error'
      if (detail?.stack)
        error.stack = `${error.name}: ${error.message}\n${detail.stack}`
      if (
        error.name === 'InternalError' &&
        /interrupted|out of memory/i.test(error.message)
      ) {
        this.#fatal = error
        this.#scheduleJobs()
      }
      throw error
    }
    return result.value
  }

  #enter(fn, limit = this.timeLimit) {
    this.#assertAlive()
    if (this.#depth++ === 0) this.#deadline = Date.now() + limit
    try {
      return fn()
    } finally {
      if (--this.#depth === 0) this.#scheduleJobs()
    }
  }

  #scheduleJobs() {
    if (this.#scheduled || this.#disposed) return
    this.#scheduled = true
    queueMicrotask(() => {
      if (this.#disposed) return
      this.#deadline = Date.now() + this.timeLimit
      // Host callbacks during a job must not reset the running job's deadline.
      this.#depth++
      try {
        if (this.#fatal) throw this.#fatal
        let count = 0
        while (this.#runtime.hasPendingJob()) {
          const result = this.#runtime.executePendingJobs(1)
          if (result.error) {
            const error = this.#vm.dump(result.error)
            result.error.dispose()
            throw new Error(error?.message || String(error))
          }
          if (++count > 1000 || Date.now() > this.#deadline)
            throw new Error('Module microtask budget exceeded')
        }
        for (const collect of this.#maintenance)
          this.#take(
            this.#vm.callFunction(collect, this.#vm.undefined)
          ).dispose()
      } catch (error) {
        try {
          this.onError(error)
        } finally {
          this.onFatal(error)
        }
      } finally {
        this.#depth--
        this.#scheduled = false
      }
    })
  }

  #value(value, seen = new Set()) {
    const vm = this.#vm
    const reference = foreignValue(value)
    if (reference) {
      if (reference.executor !== this)
        throw new TypeError('Cross-module object references are not allowed')
      return this.#call('ref', reference.id)
    }
    if (value === undefined) return vm.undefined.dup()
    if (value === null) return vm.null.dup()
    if (typeof value === 'string') return vm.newString(value)
    if (typeof value === 'number') return vm.newNumber(value)
    if (typeof value === 'boolean') return (value ? vm.true : vm.false).dup()
    if (typeof value === 'bigint') return vm.newBigInt(value)
    if (
      !value ||
      typeof value !== 'object' ||
      (!Array.isArray(value) &&
        Object.getPrototypeOf(value) !== Object.prototype &&
        Object.getPrototypeOf(value) !== null)
    ) {
      const mapped = this.#argumentMapper?.(value)
      if (mapped !== undefined && mapped !== value)
        return this.#value(mapped, seen)
      throw new TypeError('Host objects cannot enter the isolated module')
    }
    if (seen.has(value))
      throw new TypeError('Cyclic host input is not supported')
    seen.add(value)
    const result = Array.isArray(value) ? vm.newArray() : vm.newObject()
    try {
      for (const [key, item] of Object.entries(value)) {
        const handle = this.#value(item, seen)
        try {
          vm.setProp(result, key, handle)
        } finally {
          handle.dispose()
        }
      }
      return result
    } catch (error) {
      result.dispose()
      throw error
    } finally {
      seen.delete(value)
    }
  }

  #fromPromise(promise, convert = (value) => this.#value(value)) {
    const deferred = this.#vm.newPromise()
    this.#promises.add(deferred)
    Promise.resolve(promise)
      .then((value) => {
        if (this.#disposed) return
        const handle = convert(value)
        try {
          deferred.resolve(handle)
        } finally {
          handle.dispose()
        }
      })
      .catch((error) => {
        if (this.#disposed) return
        const handle = this.#vm.newError({
          name: error.name,
          message: error.message,
        })
        try {
          deferred.reject(handle)
        } finally {
          handle.dispose()
        }
      })
      .finally(() => {
        if (!this.#disposed) {
          this.#promises.delete(deferred)
          deferred.dispose()
          this.#scheduleJobs()
        }
      })
    return deferred.handle.dup()
  }

  #installImport() {
    const fn = this.#vm.newFunction('__vhtmlImport', (specifier, referrer) => {
      const name = this.#vm.getString(specifier)
      const from = this.#vm.getString(referrer)
      return this.#fromPromise(this.#import(name, from), (handle) =>
        handle.dup()
      )
    })
    this.#vm.setProp(this.#vm.global, '__vhtmlImport', fn)
    fn.dispose()
  }

  #installTimers() {
    for (const [name, repeat] of [
      ['setTimeout', false],
      ['setInterval', true],
    ]) {
      const fn = this.#vm.newFunction(name, (callback, delay, ...args) => {
        if (this.#vm.typeof(callback) !== 'function')
          throw new TypeError('Timer callback must be a function')
        if (this.#timers.size >= 1024)
          throw new Error('Module timer limit exceeded')
        const id = ++this.#nextTimer
        const handles = [callback.dup(), ...args.map((arg) => arg.dup())]
        const invoke = () => {
          if (this.#disposed) return
          try {
            const result = this.#enter(() =>
              this.#take(
                this.#vm.callFunction(
                  handles[0],
                  this.#vm.undefined,
                  ...handles.slice(1)
                )
              )
            )
            result.dispose()
          } catch (error) {
            this.onError(error)
            // 持续抛错的 interval 不再按原周期空转（刷错误日志且占 CPU 配额），
            // 与 timeout 的 finally 清除对称；#clearTimer 幂等
            this.#clearTimer(id)
          } finally {
            if (!repeat) this.#clearTimer(id)
          }
        }
        const ms = Math.max(
          0,
          Math.min(2147483647, delay ? Number(this.#vm.dump(delay)) || 0 : 0)
        )
        const timer = (repeat ? setInterval : setTimeout)(invoke, ms)
        this.#timers.set(id, { timer, handles, repeat })
        return this.#vm.newNumber(id)
      })
      this.#vm.setProp(this.#vm.global, name, fn)
      fn.dispose()
    }
    this.expose('clearTimeout', (id) => this.#clearTimer(id))
    this.expose('clearInterval', (id) => this.#clearTimer(id))
  }

  #clearTimer(id) {
    const task = this.#timers.get(id)
    if (!task) return
    this.#timers.delete(id)
    ;(task.repeat ? clearInterval : clearTimeout)(task.timer)
    task.handles.forEach((handle) => handle.dispose())
  }

  /** Only framework-selected capabilities enter here; results are copied, never host references. */
  expose(name, value) {
    this.#assertAlive()
    const make = (item) => {
      if (typeof item === 'function')
        return this.#vm.newFunction(name, (...args) => {
          const result = item(...args.map((arg) => this.#vm.dump(arg)))
          return result && typeof result.then === 'function'
            ? this.#fromPromise(result)
            : this.#value(result)
        })
      if (
        item &&
        typeof item === 'object' &&
        Object.values(item).some((v) => typeof v === 'function')
      ) {
        const handle = this.#vm.newObject()
        try {
          for (const [key, member] of Object.entries(item)) {
            const child = make(member)
            try {
              this.#vm.setProp(handle, key, child)
            } finally {
              child.dispose()
            }
          }
          return handle
        } catch (error) {
          handle.dispose()
          throw error
        }
      }
      return this.#value(item)
    }
    const handle = make(value)
    try {
      this.#vm.setProp(this.#vm.global, name, handle)
    } finally {
      handle.dispose()
    }
  }

  mapArguments(mapper) {
    this.#argumentMapper = mapper
  }

  #packHandle(value) {
    const fn = this.#vm.getProp(this.#api, 'pack')
    try {
      const packed = this.#take(
        this.#vm.callFunction(fn, this.#vm.undefined, value)
      )
      try {
        return this.#view(this.#vm.dump(packed))
      } finally {
        packed.dispose()
      }
    } finally {
      fn.dispose()
    }
  }

  capability(name, callback) {
    const fn = this.#vm.newFunction(name, (...args) => {
      const result = callback(...args.map((arg) => this.#packHandle(arg)))
      return result && typeof result.then === 'function'
        ? this.#fromPromise(result)
        : this.#value(result)
    })
    this.#vm.setProp(this.#vm.global, name, fn)
    fn.dispose()
  }

  invoke(name, ...values) {
    return this.#enter(() => {
      const fn = this.#vm.getProp(this.#vm.global, name),
        args = values.map((value) => this.#value(value))
      try {
        const result = this.#take(
          this.#vm.callFunction(fn, this.#vm.undefined, ...args)
        )
        try {
          return this.#packHandle(result)
        } finally {
          result.dispose()
        }
      } finally {
        fn.dispose()
        args.forEach((value) => value.dispose())
      }
    })
  }

  #call(method, ...values) {
    return this.#enter(() => {
      const fn = this.#vm.getProp(this.#api, method)
      const args = []
      try {
        for (const value of values) args.push(this.#value(value))
        return this.#take(
          this.#vm.callFunction(fn, this.#vm.undefined, ...args)
        )
      } finally {
        fn.dispose()
        args.forEach((handle) => handle.dispose())
      }
    })
  }

  createScope(data = {}, mod = {}, sys = {}) {
    const value = this.#call('create', data, mod, sys)
    try {
      return this.#vm.getNumber(value)
    } finally {
      value.dispose()
    }
  }

  #transfer(op, args) {
    return trackExternal((notify) => {
      const handle = this.#call('transfer', op, args, Boolean(notify))
      let record
      try {
        record = this.#vm.dump(handle)
      } finally {
        handle.dispose()
      }
      if (record.subscription)
        this.#subscriptions.set(record.subscription, notify)
      return {
        value: this.#view(record.result),
        cancel: () => {
          this.#subscriptions.delete(record.subscription)
          if (!this.#disposed)
            this.#call('cancel', record.subscription).dispose()
        },
      }
    })
  }

  #view(record) {
    if (record.type === 'undefined') return undefined
    if (record.type === 'value') return record.value
    if (record.type === 'bigint') return BigInt(record.value)
    const existing = this.#views.get(record.id)?.ref.deref()
    if (existing) return existing
    if (record.type === 'promise') {
      const handle = this.#call('ref', record.id)
      const pending = this.#untilDisposed(this.#vm.resolvePromise(handle)).then(
        (result) => {
          const value = this.#take(result)
          try {
            return this.#packHandle(value)
          } finally {
            value.dispose()
          }
        }
      )
      handle.dispose()
      const version = ++this.#viewVersion
      this.#views.set(record.id, { ref: new WeakRef(pending), version })
      this.#finalizer.register(pending, { id: record.id, version })
      return pending
    }
    const executor = this
    const target =
      record.type === 'array'
        ? []
        : record.type === 'function'
          ? (...args) => args
          : {}
    const ref = () => proxy
    const proxy = new Proxy(target, {
      get(_target, key) {
        if (key === DataID)
          return `module:${executor.#identity}:${record.identity}`
        if (key === Symbol.iterator && record.type === 'array')
          return function* () {
            for (let i = 0; i < proxy.length; i++) yield proxy[i]
          }
        if (key === Symbol.toStringTag) return 'ModuleValue'
        if (typeof key === 'symbol') return undefined
        // Host Promise machinery must not assimilate guest objects.
        if (key === 'then') return undefined
        return executor.#transfer('get', [ref(), key])
      },
      set(_target, key, value) {
        return executor.#transfer('set', [ref(), String(key), value])
      },
      has(_target, key) {
        return (
          typeof key === 'string' && executor.#transfer('has', [ref(), key])
        )
      },
      deleteProperty(_target, key) {
        return executor.#transfer('delete', [ref(), String(key)])
      },
      ownKeys() {
        const keys = executor.#transfer('keys', [ref()])
        const result = Array.from(keys)
        if (record.type === 'array') result.push('length')
        return result
      },
      getOwnPropertyDescriptor(_target, key) {
        if (record.type === 'array' && key === 'length')
          return Reflect.getOwnPropertyDescriptor(target, key)
        if (typeof key !== 'string' || !executor.#transfer('has', [ref(), key]))
          return undefined
        return {
          configurable: true,
          enumerable: true,
          writable: true,
          value: proxy[key],
        }
      },
      apply(_target, receiver, args) {
        return executor.#transfer('call', [
          ref(),
          foreignValue(receiver)?.executor === executor ? receiver : undefined,
          args,
        ])
      },
    })
    registerForeign(proxy, {
      executor,
      id: record.id,
      wrap: (data, root) => executor.#transfer('wrap', [data, root]),
      setRoot: (data, root) => executor.#transfer('root', [data, root]),
      define: (...args) => executor.#transfer('define', args),
    })
    const version = ++this.#viewVersion
    this.#views.set(record.id, { ref: new WeakRef(proxy), version })
    this.#finalizer.register(proxy, { id: record.id, version })
    return proxy
  }

  data(scope) {
    return this.#transfer('data', [scope])
  }
  beginSetup(scope) {
    this.#call('beginSetup', scope).dispose()
  }
  finishSetup(scope) {
    this.#call('finishSetup', scope).dispose()
  }
  initializeModule(scope, bus, i18n) {
    this.#call('initializeModule', scope, bus, i18n).dispose()
  }

  async importModule(specifier, from = this.resources.meta.root) {
    return this.#packHandle(await this.#import(specifier, from))
  }

  read(code, scope, locals = {}, filename = this.resources.meta.root, data) {
    return this.#transfer('run', [
      scope,
      expressionBody(prepareSource(code, filename, { setup: true }).source),
      false,
      locals,
      data,
    ])
  }

  /** Execute framework bootstrap code inside the guest realm. */
  bootstrap(source, { maintenance = false } = {}) {
    const result = this.#enter(() => this.#take(this.#vm.evalCode(source)))
    if (maintenance) this.#maintenance.push(result)
    else result.dispose()
  }

  // A module installs its teardown here; standalone VMs only own their engine.
  onFatal = () => this.dispose()
  get disposed() {
    return this.#disposed
  }

  deliver(name, ...values) {
    if (this.#disposed) return
    return this.#enter(() => {
      const fn = this.#vm.getProp(this.#vm.global, name)
      const args = values.map((value) => this.#value(value))
      try {
        this.#take(
          this.#vm.callFunction(fn, this.#vm.undefined, ...args)
        ).dispose()
      } catch (error) {
        this.onError(error)
      } finally {
        fn.dispose()
        args.forEach((value) => value.dispose())
      }
    })
  }

  evaluate(code, scope, filename = this.resources.meta.root) {
    const result = this.#call(
      'run',
      scope,
      expressionBody(prepareSource(code, filename, { setup: true }).source),
      false
    )
    try {
      return this.#vm.dump(result)
    } finally {
      result.dispose()
    }
  }

  async execute(code, scope, filename = this.resources.meta.root, locals = {}, data) {
    const compiled = prepareSource(code, filename, { setup: true })
    for (const statement of compiled.imports) {
      const namespace = await this.#import(statement.source, filename)
      for (const binding of statement.bindings) {
        const args = [scope, binding.local].map((value) => this.#value(value))
        args.push(namespace.dup(), this.#value(binding.imported), this.#value(data))
        const fn = this.#vm.getProp(this.#api, 'bind')
        try {
          this.#take(
            this.#vm.callFunction(fn, this.#vm.undefined, ...args)
          ).dispose()
        } finally {
          fn.dispose()
          args.forEach((handle) => handle.dispose())
        }
      }
    }
    const body = expressionBody(compiled.source)
    // Large third-party bundles need a compilation budget separate from execution.
    this.#enter(() => this.#call('compile', body, true).dispose(), 1000)
    const result = this.#call('run', scope, body, true, locals, data)
    const resolved = this.#vm.resolvePromise(result)
    result.dispose()
    this.#scheduleJobs()
    const value = this.#take(await this.#untilDisposed(resolved))
    try {
      return this.#vm.dump(value)
    } finally {
      value.dispose()
      this.#scheduleJobs()
    }
  }

  async #prepare(url, seen = new Set()) {
    if (seen.has(url)) return
    seen.add(url)
    if (!this.#sourceJobs.has(url)) {
      const pending = this.resources.text(url).then((code) => {
        this.#assertAlive()
        const compiled = prepareSource(code, url)
        this.#sources.set(url, compiled.source)
        return compiled
      })
      this.#sourceJobs.set(url, pending)
      pending.catch(() => this.#sourceJobs.delete(url))
    }
    const compiled = await this.#sourceJobs.get(url)
    for (const spec of compiled.dependencies)
      await this.#prepare(
        this.resources.resolve(spec, { from: url }).href,
        seen
      )
  }

  #import(specifier, from) {
    this.#assertAlive()
    const url = this.resources.resolve(specifier, { from }).href
    if (this.#modules.has(url)) return Promise.resolve(this.#modules.get(url))
    if (this.#imports.has(url)) return this.#imports.get(url)
    const pending = (async () => {
      await this.#prepare(url)
      const value = this.#enter(() =>
        this.#take(
          this.#vm.evalCode(
            `import * as ns from ${JSON.stringify(url)}; export default ns;`,
            `${url}#vhtml-namespace`,
            { type: 'module' }
          )
        )
      )
      const completion = this.#vm.resolvePromise(value)
      value.dispose()
      this.#scheduleJobs()
      const exports = this.#take(await this.#untilDisposed(completion))
      const namespace = this.#vm.getProp(exports, 'default')
      exports.dispose()
      this.#modules.set(url, namespace)
      return namespace
    })()
    this.#imports.set(url, pending)
    pending.finally(() => this.#imports.delete(url)).catch(() => {})
    return pending
  }

  #untilDisposed(promise) {
    return new Promise((resolve, reject) => {
      const cancel = () => reject(new Error('Module executor is disposed'))
      this.#disposeCallbacks.add(cancel)
      promise
        .then(resolve, reject)
        .finally(() => this.#disposeCallbacks.delete(cancel))
    })
  }

  disposeScope(scope) {
    if (!this.#disposed) this.#call('drop', scope).dispose()
  }

  dispose() {
    if (this.#disposed) return
    this.#disposed = true
    this.#maintenance.forEach((handle) => handle.dispose())
    this.#maintenance.length = 0
    this.#subscriptions.clear()
    this.#views.clear()
    this.#disposeCallbacks.forEach((cancel) => cancel())
    this.#disposeCallbacks.clear()
    for (const id of this.#timers.keys()) this.#clearTimer(id)
    this.#promises.forEach((promise) => promise.dispose())
    this.#promises.clear()
    this.#modules.forEach((handle) => handle.dispose())
    this.#modules.clear()
    this.#api.dispose()
    this.#vm.dispose()
    this.#runtime.dispose()
  }
}
