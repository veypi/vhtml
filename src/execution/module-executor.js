import { normalizeRoutesModule } from '../router/matcher.js'
import { createEventBusClass } from '../vbus.js'
import { createI18nClass } from '../i18n.js'
import { IsolatedExecutor } from './isolated.js'
import { installNetwork } from './network.js'
import { RenderPolicy } from './render-policy.js'
import { installDOM } from './dom.js'
import { foreignValue } from './foreign.js'

// Only public route data crosses into the VM. Matchers and host wrappers stay
// with RouterView; callbacks from the route module keep their guest identity.
function routeSnapshot(state = {}) {
  const route = (value) => ({
    path: value.path,
    component: typeof value.component === 'string' ? value.component : undefined,
    meta: value.meta || {},
    layout: value.layout || '',
  })
  return {
    path: state.path,
    fullPath: state.fullPath,
    params: { ...state.params },
    query: { ...state.query },
    hash: state.hash || '',
    meta: state.meta || state.route?.meta || {},
    layout: state.layout || state.route?.layout || '',
    matched: Array.from(state.matched || [], route),
    route: state.route ? route(state.route) : undefined,
  }
}

export class ModuleExecutor {
  static async create(resources, initial = {}) {
    const engine = await IsolatedExecutor.create(resources)
    return new ModuleExecutor(engine, resources, initial)
  }
  #contexts = new WeakMap()
  #network
  #moduleScope
  #scripts = new Map()
  #owners = 0
  #retired = false
  #closed = false
  constructor(engine, resources, initial) {
    this.engine = engine
    this.resources = resources
    engine.onFatal = () => this.dispose()
    try {
      this.render = new RenderPolicy(resources)
      this.#network = installNetwork(engine, resources)
      this.dom = installDOM(engine, this.render)
      engine.mapArguments((value) => this.dom.value(value))
      this.#moduleScope = engine.createScope(
        {},
        { ...initial, scoped: resources.meta.scoped },
        {}
      )
      engine.initializeModule(
        this.#moduleScope,
        createEventBusClass.toString(),
        createI18nClass.toString()
      )
      this.mod = engine.read('$mod', this.#moduleScope)
    } catch (error) {
      this.dispose()
      throw error
    }
  }

  createData(host, scope, runtime, initial = {}) {
    // 同一 runtime 重复注册会覆盖 #contexts 映射：旧 cleanup 误删新记录、
    // owners 计数失衡导致 retire 后 executor 永不 dispose——fail-fast 拒绝
    if (this.#contexts.has(runtime))
      throw new Error('Component runtime already owns a module data context')
    this.#owners++
    const sys = this.dom.attach(host, scope, runtime)
    const id = this.engine.createScope({ ...initial, $refs: {} }, this.mod, sys)
    const data = this.engine.data(id)
    this.#contexts.set(runtime, id)
    scope.addCleanup(() => {
      if (!this.#contexts.has(runtime)) return
      this.engine.disposeScope(id)
      this.#contexts.delete(runtime)
      if (--this.#owners === 0 && this.#retired) this.dispose()
    })
    return data
  }

  #scope(data, runtime) {
    if (foreignValue(data)?.executor !== this.engine)
      throw new TypeError('Isolated components require module-owned data')
    const id = this.#contexts.get(runtime)
    if (!id) throw new Error('Component scope is disposed')
    return id
  }

  #locals(locals) {
    const result = {}
    // These are supplied by the guest context, never by the host script call site.
    for (const [key, value] of Object.entries(locals || {}))
      if (!['$node', '$scope', '$watch', '$router'].includes(key))
        result[key] = value
    return result
  }
  evaluate(code, data, runtime, locals) {
    return this.engine.read(
      code,
      this.#scope(data, runtime),
      this.#locals(locals),
      runtime?.source || this.resources.meta.root,
      data
    )
  }
  execute(code, data, runtime, locals, source = runtime?.source) {
    return this.engine.execute(
      code,
      this.#scope(data, runtime),
      source || this.resources.meta.root,
      this.#locals(locals),
      data
    )
  }
  beginSetup(runtime) {
    this.engine.beginSetup(this.#contexts.get(runtime))
  }
  finishSetup(runtime) {
    this.engine.finishSetup(this.#contexts.get(runtime))
  }

  async environment() {
    let namespace
    try {
      namespace = await this.engine.importModule('./env.js')
    } catch (error) {
      if (
        error.status === 404 &&
        error.url === this.resources.resolve('./env.js').href
      )
        return
      throw error
    }
    if (typeof namespace.default !== 'function') return
    await this.engine.execute(
      `await initialize($mod, Object.freeze({
      define(){throw new Error('Isolated modules cannot define global capabilities')},
      loadModule(){throw new Error('Use module-local imports in isolated env.js')},
      addAlias(){throw new Error('Aliases are configured by the host')}
    }))`,
      this.#moduleScope,
      this.resources.resolve('./env.js').href,
      { initialize: namespace.default }
    )
  }
  import(source) {
    return this.engine.importModule(source)
  }
  async routes(source) {
    const result = await normalizeRoutesModule(
      typeof source === 'string' ? await this.import(source) : await source,
      { $mod: this.mod }
    )
    const convert = (route) => {
      const result = { ...route }
      if (route.children) result.children = Array.from(route.children, convert)
      for (const name of ['redirect', 'cacheKey']) {
        const callback = route[name]
        if (typeof callback === 'function')
          result[name] = (state) => callback(routeSnapshot(state))
      }
      if (typeof route.error_redirect === 'function') {
        const callback = route.error_redirect
        result.error_redirect = (state, error) =>
          callback(routeSnapshot(state), {
            name: error.name,
            message: error.message,
            stack: error.stack,
          })
      }
      return result
    }
    const before = result.beforeEnter,
      after = result.afterEnter
    if (typeof before === 'function') {
      const guard = this.engine.read(
        `callback => async (to, from) => {
        let redirect;
        const result = await callback(to, from, target => { if (target) redirect = target });
        return { result, redirect };
      }`,
        this.#moduleScope
      )(before)
      result.beforeEnter = async (to, from, next) => {
        const decision = await guard(routeSnapshot(to), routeSnapshot(from))
        if (decision.redirect) next(decision.redirect)
        return decision.result
      }
    }
    if (typeof after === 'function')
      result.afterEnter = (to, from) =>
        after(routeSnapshot(to), routeSnapshot(from))
    result.routes = Array.from(result.routes, convert)
    return result
  }

  async script(source, filename) {
    return this.engine.execute(source, this.#moduleScope, filename)
  }
  externalScript(address) {
    const url = this.resources.resolve(address).href
    if (!this.#scripts.has(url)) {
      const pending = this.resources
        .text(url)
        .then((source) => this.script(source, url))
      this.#scripts.set(url, pending)
      pending.catch(() => this.#scripts.delete(url))
    }
    return this.#scripts.get(url)
  }
  retire() {
    this.#retired = true
    if (!this.#owners) this.dispose()
  }
  dispose() {
    if (this.#closed) return
    this.#closed = true
    const errors = []
    for (const release of [
      () => this.#network?.(),
      () => this.dom?.dispose(),
      () => this.render?.dispose(),
      () => this.resources.dispose(),
      () => this.engine.dispose(),
    ]) {
      try {
        release()
      } catch (error) {
        errors.push(error)
      }
    }
    for (const error of errors) this.engine.onError(error)
  }
}
