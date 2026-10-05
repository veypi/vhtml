/* Module addresses and transport. Callers never concatenate scoped themselves. */

import { moduleRecord } from './execution/context.js'

function trimTrailingSlash(value) {
  if (!value || value === '/') return value || ''
  return value.endsWith('/') ? value.slice(0, -1) : value
}

export function normalizeScoped(scoped = '') {
  if (!scoped) return ''
  if (/^https?:\/\//.test(scoped)) {
    const url = new URL(scoped)
    const pathname = trimTrailingSlash(url.pathname)
    return `${url.origin}${pathname === '/' ? '' : pathname}`
  }
  const normalized = trimTrailingSlash(scoped)
  if (!normalized) return ''
  return normalized.startsWith('/') ? normalized : `/${normalized}`
}

export function getModulePath(source) {
  if (!source) return ''
  if (typeof source === 'string') {
    const v = source === '/' ? '' : source
    return v.endsWith('/') ? v.slice(0, -1) : v
  }
  const mod = source.$mod || source
  const v = mod?.scoped || ''
  if (!v || v === '/') return ''
  return v.endsWith('/') ? v.slice(0, -1) : v
}

export function resourcesFor(context = {}) {
  return (
    moduleRecord(context)?.resources ||
    new ModuleResources({
      ...moduleIdentity(getModulePath(context), window.location.origin),
      unsafe: false,
    })
  )
}

export function resourceKey(input, context) {
  return resourcesFor(context).resolve(input).href
}

// Normalize both canonical cache keys and compact DOM style references.
export function resourceMatcher(prefix) {
  if (!prefix || prefix === '/') return () => true
  const target = new URL(prefix, window.location.origin)
  const path = target.pathname.replace(/\/$/, '')
  const forms = path.endsWith('.html') ? [path, path.slice(0, -5)] : [path]
  return (key) => {
    if (typeof key !== 'string') return false
    const url = new URL(key, window.location.origin)
    return (
      url.origin === target.origin &&
      forms.some(
        (value) =>
          url.pathname === value || url.pathname.startsWith(value + '/')
      )
    )
  }
}

const resolvedResources = new WeakMap()
const SCHEME = /^[a-z][a-z\d+.-]*:/i
const HTTP = new Set(['http:', 'https:'])

export class ResourceError extends Error {
  constructor(message, input) {
    super(`[vhtml] ${message}: ${String(input)}`)
    this.name = 'ResourceError'
  }
}

export function moduleIdentity(scoped, origin) {
  const url = new URL(scoped || '/', origin)
  if (
    !HTTP.has(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new ResourceError('invalid module root', scoped)
  }
  url.pathname = url.pathname.replace(/\/+$/, '') + '/'
  return Object.freeze({
    origin: url.origin,
    scoped: url.pathname.slice(0, -1),
    root: url.href,
  })
}

export function readModuleMeta(response, entryURL) {
  const entry = new URL(entryURL)
  const unsafe = response.headers.has('vhtml-unsafe')
  if (unsafe && !response.headers.has('vhtml-scoped')) {
    throw new ResourceError('unsafe module requires vhtml-scoped', entryURL)
  }
  const identity = moduleIdentity(
    response.headers.get('vhtml-scoped') || '/',
    entry.origin
  )
  if (unsafe && !identity.scoped)
    throw new ResourceError(
      'unsafe module requires a non-root scoped prefix',
      entryURL
    )
  if (unsafe && !within(new URL(identity.root), entry)) {
    throw new ResourceError(
      'module entry is outside its declared root',
      entryURL
    )
  }
  return Object.freeze({ ...identity, unsafe })
}

function within(root, url) {
  const prefix = root.pathname.slice(0, -1)
  return (
    url.origin === root.origin &&
    (url.pathname === prefix || url.pathname.startsWith(root.pathname))
  )
}

function pathInput(input) {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  if (typeof Request !== 'undefined' && input instanceof Request)
    return input.url
  throw new TypeError('Resource URL must be a string, URL or Request')
}

export class ModuleResources {
  #root
  #fetch
  #closed = false
  #pending = new Set()
  #beaconBytes = 0

  constructor(meta, transport = {}) {
    this.meta = Object.freeze({
      ...moduleIdentity(meta.scoped, meta.origin),
      unsafe: !!meta.unsafe,
    })
    this.#root = new URL(this.meta.root)
    this.#fetch =
      transport.fetch || ((input, init) => globalThis.fetch(input, init))
  }

  resolve(input, { from, socket = false } = {}) {
    if (resolvedResources.has(input)) {
      if (resolvedResources.get(input) !== this)
        throw new ResourceError('foreign resource handle', input.href)
      return input
    }
    let raw = pathInput(input).trim()
    const { unsafe } = this.meta
    if (unsafe) {
      // Reject ambiguous path encodings instead of guessing how a server decodes them.
      const path = raw.split(/[?#]/, 1)[0]
      let decoded
      try {
        decoded = decodeURIComponent(path)
      } catch (_) {
        throw new ResourceError('invalid resource encoding', raw)
      }
      if (
        /[\u0000-\u001f\u007f\\]/.test(raw + decoded) ||
        /%(?:2f|5c|25)/i.test(path)
      ) {
        throw new ResourceError('ambiguous resource address', raw)
      }
      if (raw.startsWith('@'))
        throw new ResourceError('@ resource escape is forbidden', raw)
      if (raw.startsWith('//'))
        throw new ResourceError('protocol-relative address is forbidden', raw)
    }
    let base = this.#root
    if (from) {
      base = new URL(pathInput(from), this.#root)
      if (unsafe && !within(this.#root, base))
        throw new ResourceError('foreign source address', from)
    }
    let url
    if (raw.startsWith('@')) url = new URL(raw.slice(1), this.meta.origin)
    else if (SCHEME.test(raw) || raw.startsWith('//')) url = new URL(raw, base)
    else if (raw.startsWith('/')) url = new URL(raw.slice(1), this.#root)
    else url = new URL(raw, base)

    // Compare websocket destinations in the equivalent HTTP origin, before converting.
    const address = new URL(url)
    if (socket && address.protocol === 'ws:') address.protocol = 'http:'
    if (socket && address.protocol === 'wss:') address.protocol = 'https:'
    if (
      unsafe &&
      (!HTTP.has(address.protocol) ||
        address.username ||
        address.password ||
        !within(this.#root, address))
    ) {
      throw new ResourceError('resource is outside the module', raw)
    }
    if (socket) {
      if (!HTTP.has(address.protocol))
        throw new ResourceError('invalid websocket protocol', raw)
      url = address
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    }
    const result = Object.freeze({ href: url.href })
    resolvedResources.set(result, this)
    return result
  }

  async open(input, init = {}, resolveOptions) {
    if (this.#closed) throw new Error('Module resources are disposed')
    if (this.meta.unsafe && this.#pending.size >= 256)
      throw new Error('Module request limit exceeded')
    const resource = this.resolve(input, resolveOptions)
    const controller = new AbortController()
    const sourceRequest =
      typeof Request !== 'undefined' && input instanceof Request ? input : null
    const external = init.signal || sourceRequest?.signal
    const abort = () => controller.abort(external.reason)
    external?.addEventListener('abort', abort, { once: true })
    if (external?.aborted) abort()
    this.#pending.add(controller)
    let released = false
    const release = () => {
      if (released) return
      released = true
      external?.removeEventListener('abort', abort)
      this.#pending.delete(controller)
    }
    try {
      const options = { ...init, signal: controller.signal }
      if (this.meta.unsafe) options.redirect = 'error'
      const source = sourceRequest
        ? new Request(resource.href, sourceRequest)
        : resource.href
      const response = await this.#fetch(source, options)
      if (this.#closed || controller.signal.aborted)
        throw new Error('Module request was aborted')
      return {
        resource,
        response,
        release,
        abort: () => {
          controller.abort()
          release()
        },
      }
    } catch (error) {
      release()
      throw error
    }
  }

  async text(input, options) {
    const request = await this.open(input, undefined, options)
    try {
      if (!request.response.ok)
        throw Object.assign(
          new Error(
            `HTTP ${request.response.status}: ${request.resource.href}`
          ),
          { status: request.response.status, url: request.resource.href }
        )
      if (!request.response.body) return ''
      const reader = request.response.body.getReader(),
        decoder = new TextDecoder()
      let text = '',
        size = 0
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        size += chunk.value.length
        if (size > 4 * 1024 * 1024) {
          request.abort()
          throw new Error('Module source size limit exceeded')
        }
        text += decoder.decode(chunk.value, { stream: true })
      }
      return text + decoder.decode()
    } finally {
      request.release()
    }
  }

  sendBeacon(input, body, type) {
    if (this.#closed) return false
    const resource = this.resolve(input)
    const size =
      typeof body === 'string'
        ? new TextEncoder().encode(body).length
        : body?.byteLength || 0
    if (size + this.#beaconBytes > 65536) return false
    this.#beaconBytes += size
    // Accepted beacons may outlive module disposal; no callback or VM is retained.
    Promise.resolve()
      .then(() =>
        this.#fetch(resource.href, {
          method: 'POST',
          body,
          keepalive: true,
          redirect: this.meta.unsafe ? 'error' : 'follow',
          headers: type ? { 'Content-Type': type } : undefined,
        })
      )
      .catch(() => {})
      .finally(() => {
        this.#beaconBytes -= size
      })
    return true
  }

  dispose() {
    if (this.#closed) return
    this.#closed = true
    for (const controller of this.#pending) controller.abort()
    this.#pending.clear()
  }

  get pending() {
    return this.#pending.size
  }
}
