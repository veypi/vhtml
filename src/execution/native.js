import { prepareSource } from './source.js'
import { createExecutionScope } from './realm.js'
import { parseImports, importModule, importNative } from '../imports.js'
import { normalizeRoutesModule } from '../router/matcher.js'
import { compileCode } from '../compile.js'

const bindings = new WeakMap()
const missed = new Set()
function platformValue(key) {
  const value = window[key]
  // Native methods requiring a Window receiver; constructors keep their identity.
  if (typeof value !== 'function' || /^[A-Z]/.test(String(key))) return value
  if (!bindings.has(value)) bindings.set(value, value.bind(window))
  return bindings.get(value)
}
export function nativeScope(data, runtime = {}, locals = {}) {
  return createExecutionScope(
    data,
    runtime.$mod,
    runtime.$sys,
    locals,
    new Proxy(window, { get: (_target, key) => platformValue(key) }),
    (key) => {
      if (typeof key === 'string' && !missed.has(key)) {
        missed.add(key)
        console.warn(
          `[vhtml] identifier "${key}" is not defined in data/$mod/$sys/window`
        )
      }
    }
  )
}

export class NativeExecutor {
  constructor(resources) {
    this.resources = resources
  }
  import(source) {
    return importNative(this.resources.resolve(source).href)
  }
  async environment(mod, context, discovered) {
    if (discovered === false) return
    if (discovered === undefined) {
      const lease = await this.resources.open('./env.js', {
        signal: AbortSignal.timeout(10000),
      })
      try {
        if (lease.response.status === 404) return
        if (!lease.response.ok)
          throw new Error(`HTTP ${lease.response.status}: env.js`)
      } finally {
        lease.response.body?.cancel().catch(() => {})
        lease.release()
      }
    }
    const namespace = await this.import('./env.js')
    if (typeof namespace.default === 'function')
      await namespace.default(mod, context)
  }
  async routes(source, context) {
    return normalizeRoutesModule(
      typeof source === 'string' ? await this.import(source) : await source,
      context
    )
  }
  async script(source, filename, mod) {
    return this.execute(source, mod, { $mod: mod, source: filename })
  }
  externalScript(address, type = 'text/javascript') {
    const url = this.resources.resolve(address).href
    if (!this.scripts.has(url)) {
      const script = document.createElement('script')
      script.src = url
      script.type = type
      const pending = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          script.remove()
          reject(new Error(`Script load timeout: ${url}`))
        }, 15000)
        script.onload = () => {
          clearTimeout(timer)
          resolve()
        }
        script.onerror = () => {
          clearTimeout(timer)
          script.remove()
          reject(new Error(`Script load failed: ${url}`))
        }
        document.head.appendChild(script)
      })
      this.scripts.set(url, pending)
      pending.catch(() => this.scripts.delete(url))
    }
    return this.scripts.get(url)
  }
  scripts = new Map()
  evaluate(code, data, runtime = {}, locals = {}) {
    const source =
      runtime.source || this.resources?.meta.root || window.location.href
    const prepared = prepareSource(code, source, { setup: true }).source
    return compileCode(prepared)(
      nativeScope(data, runtime, {
        ...locals,
        __vhtmlImport: (specifier, source) =>
          importModule(specifier, runtime, source),
      })
    )
  }
  async execute(
    code,
    data,
    runtime = {},
    locals = {},
    source = runtime.source
  ) {
    const prepared = await parseImports(code, data, runtime, source)
    return compileCode(prepared, { async: true, label: 'AsyncRun' })(
      nativeScope(data, runtime, {
        ...locals,
        __vhtmlImport: (specifier, source) =>
          importModule(specifier, runtime, source),
      })
    )
  }
}
