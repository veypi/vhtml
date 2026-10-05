// Web-shaped facades created entirely in QuickJS. They never wrap a native instance.
export function installNetworkRealm(net, weakHandles) {
  delete globalThis.__vhtmlNetwork
  const intl = {}
  for (const type of [
    'DateTimeFormat',
    'NumberFormat',
    'RelativeTimeFormat',
    'PluralRules',
    'ListFormat',
    'Collator',
  ]) {
    intl[type] = class {
      constructor(locale, options = {}) {
        this.locale = locale
        this.options = options
      }
      format(...args) {
        return net.format(
          type,
          this.locale,
          this.options,
          'format',
          args.map((value) => (value instanceof Date ? value.getTime() : value))
        )
      }
      formatToParts(...args) {
        return net.format(
          type,
          this.locale,
          this.options,
          'formatToParts',
          args.map((value) => (value instanceof Date ? value.getTime() : value))
        )
      }
      select(...args) {
        return net.format(type, this.locale, this.options, 'select', args)
      }
      compare(...args) {
        return net.format(type, this.locale, this.options, 'compare', args)
      }
      resolvedOptions() {
        return net.format(
          type,
          this.locale,
          this.options,
          'resolvedOptions',
          []
        )
      }
    }
  }
  globalThis.Intl = intl
  const parameterHooks = new WeakMap()
  class URL {
    constructor(input, base) {
      this._value = net.url(
        String(input),
        base == null ? undefined : String(base)
      )
    }
    toString() {
      return this.href
    }
    toJSON() {
      return this.href
    }
    get searchParams() {
      if (!this._params) {
        const params = new URLSearchParams(this.search)
        parameterHooks.get(params).notify = () => {
          this.search = params.toString()
        }
        this._params = params
      }
      return this._params
    }
    static canParse(input, base) {
      try {
        new URL(input, base)
        return true
      } catch (_) {
        return false
      }
    }
    static parse(input, base) {
      try {
        return new URL(input, base)
      } catch (_) {
        return null
      }
    }
  }
  for (const key of [
    'href',
    'origin',
    'protocol',
    'username',
    'password',
    'host',
    'hostname',
    'port',
    'pathname',
    'search',
    'hash',
  ])
    Object.defineProperty(URL.prototype, key, {
      get() {
        return this._value[key]
      },
      ...(key === 'origin'
        ? {}
        : {
            set(value) {
              this._value = net.url(this.href, undefined, key, String(value))
              if (this._params)
                parameterHooks.get(this._params).replace(this.search)
            },
          }),
      enumerable: true,
    })
  globalThis.URL = URL
  globalThis.location = Object.freeze({
    ...net.url(net.root),
    toString() {
      return this.href
    },
  })
  const connections = new Map(),
    requestRecords = new WeakMap()
  const bytes = (value) => {
    if (value == null) return []
    if (typeof value === 'string') return net.encode(value)
    if (value instanceof Blob) return Array.from(value._bytes)
    if (value instanceof ArrayBuffer) return Array.from(new Uint8Array(value))
    if (ArrayBuffer.isView(value))
      return Array.from(
        new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
      )
    throw new TypeError(
      'Body must be a string, Blob, ArrayBuffer or typed array'
    )
  }
  class Event {
    constructor(type, init = {}) {
      this.type = String(type)
      this.defaultPrevented = false
      Object.assign(this, init)
    }
    preventDefault() {
      this.defaultPrevented = true
    }
    stopPropagation() {}
  }
  class EventTarget {
    #listeners = new Map()
    addEventListener(type, callback, options = {}) {
      if (!callback) return
      const entries = this.#listeners.get(type) || new Map()
      entries.set(callback, Boolean(options?.once))
      this.#listeners.set(type, entries)
    }
    removeEventListener(type, callback) {
      this.#listeners.get(type)?.delete(callback)
    }
    dispatchEvent(event) {
      event.target = event.currentTarget = this
      for (const [callback, once] of [
        ...(this.#listeners.get(event.type) || []),
      ]) {
        if (once) this.removeEventListener(event.type, callback)
        if (typeof callback === 'function') callback.call(this, event)
        else callback.handleEvent(event)
      }
      const handler = this['on' + event.type]
      if (typeof handler === 'function') handler.call(this, event)
      return !event.defaultPrevented
    }
  }
  class AbortSignal extends EventTarget {
    aborted = false
    reason = undefined
    throwIfAborted() {
      if (this.aborted) throw this.reason
    }
    static abort(reason) {
      const controller = new AbortController()
      controller.abort(reason)
      return controller.signal
    }
    static timeout(ms) {
      const controller = new AbortController()
      setTimeout(() => controller.abort(new Error('Timeout')), ms)
      return controller.signal
    }
  }
  class AbortController {
    signal = new AbortSignal()
    abort(
      reason = Object.assign(new Error('Aborted'), { name: 'AbortError' })
    ) {
      if (this.signal.aborted) return
      this.signal.aborted = true
      this.signal.reason = reason
      this.signal.dispatchEvent(new Event('abort'))
    }
  }
  class Headers {
    #values = new Map()
    constructor(init = []) {
      if (init instanceof Headers || Array.isArray(init))
        for (const [key, value] of init) this.append(key, value)
      else
        for (const [key, value] of Object.entries(init)) this.append(key, value)
    }
    #key(key) {
      key = String(key).toLowerCase()
      if (!/^[!#$%&'*+.^_`|~\w-]+$/.test(key))
        throw new TypeError('Invalid header name')
      return key
    }
    set(key, value) {
      value = String(value).trim()
      if (/[\r\n\0]/.test(value)) throw new TypeError('Invalid header')
      this.#values.set(this.#key(key), value)
    }
    append(key, value) {
      const old = this.get(key)
      this.set(key, old == null ? value : old + ', ' + value)
    }
    get(key) {
      return this.#values.get(this.#key(key)) ?? null
    }
    has(key) {
      return this.#values.has(this.#key(key))
    }
    delete(key) {
      this.#values.delete(this.#key(key))
    }
    entries() {
      return this.#values.entries()
    }
    keys() {
      return this.#values.keys()
    }
    values() {
      return this.#values.values()
    }
    forEach(callback, receiver) {
      for (const [key, value] of this) callback.call(receiver, value, key, this)
    }
    [Symbol.iterator]() {
      return this.entries()
    }
  }
  class TextEncoder {
    encoding = 'utf-8'
    encode(text = '') {
      return Uint8Array.from(net.encode(String(text)))
    }
    encodeInto(text, target) {
      const encoded = this.encode(text)
      if (encoded.length > target.length)
        throw new RangeError('Destination too small')
      target.set(encoded)
      return { read: text.length, written: encoded.length }
    }
  }
  class TextDecoder {
    constructor(encoding = 'utf-8', options = {}) {
      this.encoding = encoding
      this.options = options
    }
    decode(input = new Uint8Array(), options = {}) {
      if (options.stream)
        throw new TypeError('Streaming TextDecoder is not available')
      return net.decode(bytes(input), this.encoding, this.options)
    }
  }
  class Blob {
    constructor(parts = [], options = {}) {
      this._bytes = Uint8Array.from(parts.flatMap(bytes))
      this.type = String(options.type || '').toLowerCase()
    }
    get size() {
      return this._bytes.length
    }
    async arrayBuffer() {
      return this._bytes.slice().buffer
    }
    async text() {
      return net.decode(Array.from(this._bytes))
    }
    slice(start, end, type) {
      return new Blob([this._bytes.slice(start, end)], { type })
    }
  }
  class URLSearchParams {
    #entries = []
    constructor(init = '') {
      parameterHooks.set(this, {
        replace: (value) => {
          this.#entries = new URLSearchParams(value).#entries
        },
        notify() {},
      })
      if (typeof init === 'string')
        this.#entries = init
          .replace(/^\?/, '')
          .split('&')
          .filter(Boolean)
          .map((part) => {
            const index = part.indexOf('=')
            return [
              index < 0 ? part : part.slice(0, index),
              index < 0 ? '' : part.slice(index + 1),
            ].map((v) => decodeURIComponent(v.replace(/\+/g, ' ')))
          })
      else
        this.#entries = (
          init instanceof URLSearchParams || Array.isArray(init)
            ? [...init]
            : Object.entries(init)
        ).map(([key, value]) => [String(key), String(value)])
    }
    append(key, value) {
      this.#entries.push([String(key), String(value)])
      parameterHooks.get(this).notify()
    }
    get(key) {
      return (
        this.#entries.find((entry) => entry[0] === String(key))?.[1] ?? null
      )
    }
    getAll(key) {
      return this.#entries
        .filter((entry) => entry[0] === String(key))
        .map((entry) => entry[1])
    }
    has(key) {
      return this.#entries.some((entry) => entry[0] === String(key))
    }
    delete(key) {
      this.#entries = this.#entries.filter((entry) => entry[0] !== String(key))
      parameterHooks.get(this).notify()
    }
    set(key, value) {
      key = String(key)
      value = String(value)
      const first = this.#entries.find((entry) => entry[0] === key)
      if (first) {
        first[1] = value
        this.#entries = this.#entries.filter(
          (entry) => entry === first || entry[0] !== key
        )
      } else this.#entries.push([key, value])
      parameterHooks.get(this).notify()
    }
    sort() {
      this.#entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      parameterHooks.get(this).notify()
    }
    get size() {
      return this.#entries.length
    }
    entries() {
      return this.#entries[Symbol.iterator]()
    }
    keys() {
      return this.#entries.map((entry) => entry[0])[Symbol.iterator]()
    }
    values() {
      return this.#entries.map((entry) => entry[1])[Symbol.iterator]()
    }
    forEach(callback, receiver) {
      for (const [key, value] of this.#entries)
        callback.call(receiver, value, key, this)
    }
    toString() {
      return this.#entries
        .map((entry) =>
          entry.map((v) => encodeURIComponent(v).replace(/%20/g, '+')).join('=')
        )
        .join('&')
    }
    [Symbol.iterator]() {
      return this.#entries[Symbol.iterator]()
    }
  }
  const encodeBody = (value) => {
    if (value == null || typeof value === 'string') return value
    if (value instanceof URLSearchParams) return value.toString()
    return bytes(value)
  }
  class Request {
    constructor(input, init = {}) {
      const previous = input instanceof Request ? requestRecords.get(input) : {}
      this.url = net.resolve(
        input instanceof Request ? input.url : String(input)
      )
      this.method = String(
        init.method || previous.method || 'GET'
      ).toUpperCase()
      this.headers = new Headers(init.headers || previous.headers)
      this.credentials =
        init.credentials || previous.credentials || 'same-origin'
      this.cache = init.cache || previous.cache || 'default'
      this.signal = init.signal || previous.signal || new AbortSignal()
      const body =
        init.body === undefined ? previous.body : encodeBody(init.body)
      if (
        init.body instanceof URLSearchParams &&
        !this.headers.has('content-type')
      )
        this.headers.set(
          'content-type',
          'application/x-www-form-urlencoded;charset=UTF-8'
        )
      if (
        init.body instanceof Blob &&
        init.body.type &&
        !this.headers.has('content-type')
      )
        this.headers.set('content-type', init.body.type)
      requestRecords.set(this, {
        method: this.method,
        headers: [...this.headers],
        credentials: this.credentials,
        cache: this.cache,
        body,
        signal: this.signal,
      })
    }
    clone() {
      return new Request(this)
    }
  }
  const responseCleanups = new Map()
  const responses = weakHandles((dead) => dead.forEach(finishResponse))
  function finishResponse(id) {
    if (!id) return
    net.cancel(id)
    responses.delete(id)
    responseCleanups.get(id)?.()
    responseCleanups.delete(id)
  }
  class Response {
    #record
    constructor(body = null, init = {}) {
      this.status = init.status ?? 200
      this.statusText = init.statusText || ''
      this.headers = new Headers(init.headers)
      this.url = init.url || ''
      this.redirected = false
      this.type = 'basic'
      const record = {
        id: init._id,
        empty: init.empty ?? (body === null && !init._id),
        local: init._id ? null : Uint8Array.from(bytes(body)),
        used: false,
        locked: false,
      }
      this.#record = record
      if (record.id) {
        responses.set(record.id, record)
        if (init._cleanup) responseCleanups.set(record.id, init._cleanup)
      } else init._cleanup?.()
    }
    get ok() {
      return this.status >= 200 && this.status < 300
    }
    get bodyUsed() {
      return this.#record.used
    }
    get body() {
      const record = this.#record
      if (record.empty) return null
      const stream = {
        get locked() {
          return record.locked
        },
        getReader() {
          if (record.locked) throw new TypeError('Body is locked')
          record.locked = true
          let released = false
          return {
            async read() {
              if (released) throw new TypeError('Reader lock released')
              record.used = true
              if (record.done) return { done: true }
              if (record.local) {
                const value = record.local
                record.local = null
                record.done = true
                return { done: false, value }
              }
              let result
              try {
                result = await net.read(record.id)
              } catch (error) {
                record.done = true
                finishResponse(record.id)
                throw error
              }
              if (result.done) {
                record.done = true
                finishResponse(record.id)
              }
              return result.done
                ? result
                : { done: false, value: Uint8Array.from(result.value) }
            },
            cancel() {
              record.done = true
              record.used = true
              finishResponse(record.id)
              return Promise.resolve()
            },
            releaseLock() {
              record.locked = false
              released = true
            },
          }
        },
        cancel() {
          finishResponse(record.id)
          record.done = true
          return Promise.resolve()
        },
        async *[Symbol.asyncIterator]() {
          const reader = stream.getReader()
          try {
            while (true) {
              const chunk = reader ? await reader.read() : { done: true }
              if (chunk.done) break
              yield chunk.value
            }
          } finally {
            reader.releaseLock()
          }
        },
      }
      return stream
    }
    async arrayBuffer() {
      if (this.bodyUsed) throw new TypeError('Body already used')
      if (!this.body) return new ArrayBuffer(0)
      const chunks = [],
        reader = this.body.getReader()
      let total = 0
      try {
        while (true) {
          const item = reader ? await reader.read() : { done: true }
          if (item.done) break
          chunks.push(item.value)
          total += item.value.length
        }
      } finally {
        reader.releaseLock()
      }
      const all = new Uint8Array(total)
      let offset = 0
      for (const chunk of chunks) {
        all.set(chunk, offset)
        offset += chunk.length
      }
      return all.buffer
    }
    async text() {
      return net.decode(bytes(await this.arrayBuffer()))
    }
    async json() {
      return JSON.parse(await this.text())
    }
    async blob() {
      return new Blob([await this.arrayBuffer()], {
        type: this.headers.get('content-type') || '',
      })
    }
    clone() {
      const record = this.#record
      if (record.used || record.locked) throw new TypeError('Body already used')
      return new Response(record.local, {
        status: this.status,
        statusText: this.statusText,
        headers: [...this.headers],
        url: this.url,
        empty: record.empty,
        _id: record.id ? net.clone(record.id) : undefined,
      })
    }
    static json(value, init = {}) {
      const headers = new Headers(init.headers)
      if (!headers.has('content-type'))
        headers.set('content-type', 'application/json')
      return new Response(JSON.stringify(value), { ...init, headers })
    }
  }
  const abortRequest = (id) => () => net.cancel(id)
  function abortCleanup(signal, abort) {
    return () => signal.removeEventListener('abort', abort)
  }
  async function fetch(input, init = {}) {
    const request = new Request(input, init),
      options = requestRecords.get(request)
    request.signal.throwIfAborted()
    const id = net.start(),
      abort = abortRequest(id)
    request.signal.addEventListener('abort', abort, { once: true })
    try {
      const result = await net.fetch(id, request.url, {
        ...options,
        signal: undefined,
      })
      request.signal.throwIfAborted()
      return new Response(null, {
        ...result,
        _id: result.empty ? undefined : id,
        _cleanup: abortCleanup(request.signal, abort),
      })
    } catch (error) {
      net.cancel(id)
      request.signal.removeEventListener('abort', abort)
      throw error
    }
    // Abort remains meaningful until the body is consumed. The signal and callback are guest objects only.
  }
  class XMLHttpRequest extends EventTarget {
    readyState = 0
    status = 0
    statusText = ''
    responseType = ''
    response = null
    responseText = ''
    responseURL = ''
    timeout = 0
    withCredentials = false
    upload = new EventTarget()
    #method
    #url
    #headers
    #controller
    #responseHeaders = new Headers()
    #generation = 0
    open(method, url, async = true, user, password) {
      if (async === false)
        throw new TypeError(
          'Synchronous XMLHttpRequest is unavailable in an isolated module'
        )
      if (user !== undefined || password !== undefined)
        throw new TypeError('Use authorization headers')
      this.abort()
      this.#method = method
      this.#url = net.resolve(String(url))
      this.#headers = new Headers()
      this.readyState = 1
      this.dispatchEvent(new Event('readystatechange'))
    }
    setRequestHeader(key, value) {
      if (this.readyState !== 1 || this.#controller)
        throw new Error('Invalid state')
      this.#headers.append(key, value)
    }
    getResponseHeader(key) {
      return this.#responseHeaders.get(key)
    }
    getAllResponseHeaders() {
      return [...this.#responseHeaders]
        .map(([key, value]) => `${key}: ${value}\r\n`)
        .join('')
    }
    overrideMimeType(type) {
      this._mime = String(type)
    }
    send(body = null) {
      if (this.readyState !== 1 || this.#controller)
        throw new Error('Invalid state')
      const generation = ++this.#generation,
        controller = (this.#controller = new AbortController())
      let timedOut = false
      const timer =
        this.timeout > 0
          ? setTimeout(() => {
              timedOut = true
              controller.abort()
            }, this.timeout)
          : null
      this.dispatchEvent(new Event('loadstart'))
      ;(async () => {
        try {
          const response = await fetch(this.#url, {
            method: this.#method,
            headers: this.#headers,
            body,
            signal: controller.signal,
            credentials: this.withCredentials ? 'include' : 'same-origin',
          })
          if (generation !== this.#generation) return
          this.status = response.status
          this.statusText = response.statusText
          this.responseURL = response.url
          this.#responseHeaders = response.headers
          this.readyState = 2
          this.dispatchEvent(new Event('readystatechange'))
          const reader = response.body?.getReader(),
            chunks = []
          let loaded = 0
          while (true) {
            const chunk = reader ? await reader.read() : { done: true }
            if (generation !== this.#generation) return
            if (chunk.done) break
            chunks.push(chunk.value)
            loaded += chunk.value.length
            this.readyState = 3
            this.dispatchEvent(new Event('readystatechange'))
            this.dispatchEvent(
              new Event('progress', {
                loaded,
                total: Number(response.headers.get('content-length')) || 0,
              })
            )
          }
          const buffer = new Uint8Array(loaded)
          let offset = 0
          for (const chunk of chunks) {
            buffer.set(chunk, offset)
            offset += chunk.length
          }
          if (this.responseType === 'arraybuffer') this.response = buffer.buffer
          else if (this.responseType === 'blob')
            this.response = new Blob([buffer], {
              type: this._mime || response.headers.get('content-type'),
            })
          else {
            const text = net.decode(Array.from(buffer))
            if (this.responseType === 'json') {
              try {
                this.response = JSON.parse(text)
              } catch (_) {
                this.response = null
              }
            } else if (!this.responseType || this.responseType === 'text')
              this.response = this.responseText = text
            else throw new TypeError('Unsupported XMLHttpRequest responseType')
          }
          this.readyState = 4
          this.dispatchEvent(new Event('readystatechange'))
          this.dispatchEvent(new Event('load'))
        } catch (_) {
          if (generation !== this.#generation) return
          this.status = 0
          this.readyState = 4
          this.dispatchEvent(new Event('readystatechange'))
          this.dispatchEvent(
            new Event(
              timedOut
                ? 'timeout'
                : controller.signal.aborted
                  ? 'abort'
                  : 'error'
            )
          )
        } finally {
          if (timer !== null) clearTimeout(timer)
          if (generation === this.#generation) {
            this.#controller = null
            this.dispatchEvent(new Event('loadend'))
          }
        }
      })()
    }
    abort() {
      if (this.#controller) {
        this.#generation++
        this.#controller.abort()
        this.#controller = null
        this.readyState = 0
        this.status = 0
        this.dispatchEvent(new Event('abort'))
        this.dispatchEvent(new Event('loadend'))
      }
    }
  }
  class WebSocket extends EventTarget {
    static CONNECTING = 0
    static OPEN = 1
    static CLOSING = 2
    static CLOSED = 3
    readyState = 0
    bufferedAmount = 0
    binaryType = 'blob'
    protocol = ''
    extensions = ''
    #id
    constructor(url, protocols) {
      super()
      const result = net.socket(String(url), protocols)
      this.#id = result.id
      this.url = result.url
      connections.set(this.#id, this)
    }
    send(data) {
      if (this.readyState !== 1) throw new Error('WebSocket is not open')
      this.bufferedAmount = net.send(
        this.#id,
        typeof data === 'string' ? data : bytes(data)
      )
    }
    close(code, reason) {
      net.close(this.#id, code, reason)
      if (this.readyState !== 3) this.readyState = 2
    }
  }
  class EventSource extends EventTarget {
    static CONNECTING = 0
    static OPEN = 1
    static CLOSED = 2
    readyState = 0
    #id
    constructor(url, options = {}) {
      super()
      const result = net.eventSource(String(url), !!options.withCredentials)
      this.#id = result.id
      this.url = result.url
      this.withCredentials = !!options.withCredentials
      connections.set(this.#id, this)
    }
    close() {
      net.stopEvents(this.#id)
      this.readyState = 2
      connections.delete(this.#id)
    }
  }
  for (const [constructor, constants] of [
    [
      XMLHttpRequest,
      ['UNSENT', 'OPENED', 'HEADERS_RECEIVED', 'LOADING', 'DONE'],
    ],
    [WebSocket, ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']],
    [EventSource, ['CONNECTING', 'OPEN', 'CLOSED']],
  ]) {
    constants.forEach((name, i) => {
      Object.defineProperty(constructor, name, { value: i })
      Object.defineProperty(constructor.prototype, name, { value: i })
    })
  }
  globalThis.__vhtmlNetworkEvent = (id, detail) => {
    const connection = connections.get(id)
    if (!connection) return
    if (connection instanceof WebSocket) {
      if (detail.type === 'open') {
        connection.readyState = 1
        connection.protocol = detail.protocol
        connection.extensions = detail.extensions
      }
      if (detail.type === 'close') {
        connection.readyState = 3
        connections.delete(id)
      }
      if (Array.isArray(detail.data))
        detail.data =
          connection.binaryType === 'arraybuffer'
            ? Uint8Array.from(detail.data).buffer
            : new Blob([Uint8Array.from(detail.data)])
    } else {
      if (detail.type === 'open') connection.readyState = 1
      if (detail.type === 'error') connection.readyState = detail.closed ? 2 : 0
      if (detail.closed) connections.delete(id)
    }
    connection.dispatchEvent(new Event(detail.type, detail))
  }
  Object.assign(globalThis, {
    Event,
    EventTarget,
    AbortSignal,
    AbortController,
    Headers,
    Request,
    Response,
    Blob,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    fetch,
    XMLHttpRequest,
    WebSocket,
    EventSource,
    navigator: Object.freeze({
      userAgent: 'vhtml sandbox',
      language: 'zh-CN',
      sendBeacon: (url, data) =>
        net.beacon(
          String(url),
          encodeBody(data),
          data instanceof Blob
            ? data.type
            : data instanceof URLSearchParams
              ? 'application/x-www-form-urlencoded;charset=UTF-8'
              : typeof data === 'string'
                ? 'text/plain;charset=UTF-8'
                : ''
        ),
    }),
  })
  return () => responses.sweep()
}
