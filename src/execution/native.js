import { prepareSource } from './source.js'
import { createExecutionScope } from './realm.js'
import { parseImports, importModule, importNative } from '../imports.js'
import { normalizeRoutesModule } from '../router/matcher.js'
import { compileCode, toPreview } from '../compile.js'
import { recordError } from '../errors.js'

const bindings = new WeakMap()
const missed = new Set()
const MAX_MISSED = 256

function identifierCode(code, key) {
  if (typeof code !== 'string') return ''
  const lines = code.split('\n')
  if (lines.length === 1) return toPreview(code)
  // These are lines within the original script passed to the executor, not
  // HTML file line numbers. Keep the relevant part of long setup scripts.
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`(^|[^\\p{ID_Continue}$])${escaped}(?![\\p{ID_Continue}$])`, 'u')
  const matches = []
  for (let i = 0; i < lines.length && matches.length < 3; i++) {
    if (pattern.test(lines[i])) matches.push(`script line ${i + 1}: ${lines[i].trim()}`)
  }
  return toPreview(matches.join('\n') || code)
}

function reportMissing(key, data, runtime, diagnostic) {
  if (typeof key !== 'string') return
  const source = diagnostic.source || runtime.source || runtime.diagnostic?.vsrc || window.location.href
  const code = identifierCode(diagnostic.code, key)
  const identity = JSON.stringify([source, key, diagnostic.label, code])
  if (missed.has(identity)) return
  if (missed.size >= MAX_MISSED) missed.delete(missed.values().next().value)
  missed.add(identity)
  const hint = 'Check spelling and scope. Template state must be assigned in <script setup> (name = value); const/let stay private. Module services use $mod.'
  const entry = recordError({
    kind: 'identifier', severity: 'warning', identifier: key,
    source, code, label: diagnostic.label || 'scope',
    component: runtime.diagnostic ? { ...runtime.diagnostic } : undefined,
    dataKeys: Object.keys(data || {}),
    message: `Unknown identifier "${key}"`, hint,
  })
  console.warn(`[vhtml] Unknown identifier "${key}"\n  Source: ${source}\n  ${diagnostic.label || 'Scope'}: ${code || '(source unavailable)'}\n  ${hint}`, entry)
}
function platformValue(key) {
  const value = window[key]
  // Native methods requiring a Window receiver; constructors keep their identity.
  if (typeof value !== 'function' || /^[A-Z]/.test(String(key))) return value
  if (!bindings.has(value)) bindings.set(value, value.bind(window))
  return bindings.get(value)
}
export function nativeScope(data, runtime = {}, locals = {}, diagnostic = {}) {
  return createExecutionScope(
    data,
    runtime.$mod,
    runtime.$sys,
    locals,
    new Proxy(window, { get: (_target, key) => platformValue(key) }),
    key => reportMissing(key, data, runtime, diagnostic)
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
      }, { source: runtime.source || runtime.diagnostic?.vsrc || window.location.href, code, label: 'Expression' })
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
      }, { source: source || runtime.source || runtime.diagnostic?.vsrc || window.location.href, code, label: 'Script' })
    )
  }
}
