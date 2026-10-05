import { createWeakHandles } from './handles.js'
import { installNetworkRealm } from './network-realm.js'

const BODY_LIMIT = 16 * 1024 * 1024
const ACTIVE_LIMIT = 256

/** All native network objects stay in this closure. The guest sees IDs and copied records. */
export function installNetwork(
  executor,
  resources,
  { WebSocket: Socket = globalThis.WebSocket } = {}
) {
  const requests = new Map(),
    sockets = new Map(),
    events = new Map()
  let sequence = 0,
    closed = false
  const deliver = (id, event) => {
    if (!closed) executor.deliver('__vhtmlNetworkEvent', id, event)
  }
  const assertOpen = () => {
    if (closed) throw new Error('Module network is disposed')
  }
  const checkLimit = () => {
    assertOpen()
    if (requests.size + sockets.size + events.size >= ACTIVE_LIMIT)
      throw new Error('Module connection limit exceeded')
  }
  const request = (id) => {
    const record = requests.get(id)
    if (!record) throw new Error('Request is closed')
    return record
  }
  const release = (id) => {
    const record = requests.get(id)
    if (!record) return
    requests.delete(id)
    if (record.lease && --record.lease.refs === 0) record.lease.release()
  }
  const cancel = (id) => {
    const record = requests.get(id)
    if (!record) return
    if (!record.lease) record.controller?.abort()
    else if (record.lease.refs === 1) record.lease.abort()
    const cancellation = record.reader
      ? record.reader.cancel()
      : record.response?.body?.cancel()
    cancellation?.catch(() => {})
    release(id)
  }
  function body(input) {
    if (input == null) return undefined
    if (typeof input === 'string') return input
    if (!Array.isArray(input) || input.length > BODY_LIMIT)
      throw new TypeError('Unsupported or oversized request body')
    return Uint8Array.from(input)
  }
  const bridge = {
    root: resources.meta.root,
    url(input, base, property, value) {
      const parsed = new URL(
        String(input),
        base == null ? undefined : String(base)
      )
      if (property) {
        if (
          ![
            'href',
            'protocol',
            'username',
            'password',
            'host',
            'hostname',
            'port',
            'pathname',
            'search',
            'hash',
          ].includes(property)
        )
          throw new TypeError('Invalid URL property')
        parsed[property] = String(value)
      }
      return Object.fromEntries(
        [
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
        ].map((key) => [key, parsed[key]])
      )
    },
    resolve: (url, socket = false) =>
      resources.resolve(String(url), { socket }).href,
    encode: (text) => Array.from(new TextEncoder().encode(String(text))),
    decode: (bytes, encoding = 'utf-8', options = {}) =>
      new TextDecoder(encoding, options).decode(Uint8Array.from(bytes)),
    format(type, locale, options, method, args) {
      if (
        ![
          'DateTimeFormat',
          'NumberFormat',
          'RelativeTimeFormat',
          'PluralRules',
          'ListFormat',
          'Collator',
        ].includes(type) ||
        ![
          'format',
          'formatToParts',
          'select',
          'compare',
          'resolvedOptions',
        ].includes(method)
      )
        throw new Error('Unsupported Intl operation')
      const formatter = new Intl[type](locale, options)
      return formatter[method](...args)
    },
    start() {
      checkLimit()
      const id = ++sequence
      requests.set(id, { controller: new AbortController(), size: 0 })
      return id
    },
    async fetch(id, url, options = {}) {
      const record = request(id)
      try {
        const lease = await resources.open(String(url), {
          method: String(options.method || 'GET'),
          headers: options.headers || [],
          body: body(options.body),
          credentials: options.credentials || 'same-origin',
          cache: options.cache || 'default',
          signal: record.controller.signal,
        })
        if (closed || !requests.has(id)) {
          lease.abort()
          throw new Error('Request aborted')
        }
        record.lease = { ...lease, refs: 1 }
        record.response = lease.response
        const empty = lease.response.body === null
        if (empty) release(id)
        return {
          id,
          empty,
          status: lease.response.status,
          statusText: lease.response.statusText,
          url: lease.resource.href,
          headers: Array.from(lease.response.headers.entries()),
        }
      } catch (error) {
        release(id)
        throw error
      }
    },
    async read(id) {
      const record = request(id)
      record.reader ||= record.response.body?.getReader()
      try {
        const chunk = record.reader
          ? await record.reader.read()
          : { done: true }
        if (chunk.done) {
          release(id)
          return { done: true }
        }
        record.size += chunk.value.byteLength
        if (record.size > BODY_LIMIT) {
          cancel(id)
          throw new Error('Module response body limit exceeded')
        }
        return { done: false, value: Array.from(chunk.value) }
      } catch (error) {
        cancel(id)
        throw error
      }
    },
    clone(id) {
      checkLimit()
      const record = request(id),
        copy = record.response.clone(),
        next = ++sequence
      record.lease.refs++
      requests.set(next, { response: copy, lease: record.lease, size: 0 })
      return next
    },
    cancel,
    beacon: (url, data, type) =>
      resources.sendBeacon(String(url), body(data), type),
    socket(url, protocols) {
      checkLimit()
      if (!Socket) throw new Error('WebSocket is unavailable')
      const address = resources.resolve(String(url), { socket: true }).href
      const id = ++sequence,
        socket = new Socket(address, protocols)
      socket.binaryType = 'arraybuffer'
      sockets.set(id, socket)
      socket.onopen = () =>
        deliver(id, {
          type: 'open',
          protocol: socket.protocol,
          extensions: socket.extensions,
        })
      socket.onmessage = (event) =>
        deliver(id, {
          type: 'message',
          data:
            typeof event.data === 'string'
              ? event.data
              : Array.from(new Uint8Array(event.data)),
          origin: new URL(address).origin,
        })
      socket.onerror = () => deliver(id, { type: 'error' })
      socket.onclose = (event) => {
        sockets.delete(id)
        deliver(id, {
          type: 'close',
          code: event.code,
          reason: event.reason,
          wasClean: event.wasClean,
        })
      }
      return { id, url: address }
    },
    send(id, data) {
      const socket = sockets.get(id)
      if (!socket) throw new Error('WebSocket is closed')
      socket.send(body(data))
      return socket.bufferedAmount
    },
    close(id, code, reason) {
      sockets.get(id)?.close(code, reason)
    },
    eventSource(url, credentials = false) {
      checkLimit()
      const address = resources.resolve(String(url)).href
      const id = ++sequence
      const record = {
        stopped: false,
        controller: new AbortController(),
        timer: null,
        retry: 3000,
        lastId: '',
      }
      events.set(id, record)
      const connect = async () => {
        if (closed || record.stopped) return
        let lease
        try {
          lease = await resources.open(address, {
            signal: record.controller.signal,
            credentials: credentials ? 'include' : 'same-origin',
            headers: {
              Accept: 'text/event-stream',
              ...(record.lastId ? { 'Last-Event-ID': record.lastId } : {}),
            },
          })
          if (lease.response.status === 204) {
            stopEvents(id)
            deliver(id, { type: 'error', closed: true })
            return
          }
          if (
            !lease.response.ok ||
            !/^text\/event-stream(?:;|$)/i.test(
              lease.response.headers.get('Content-Type') || ''
            )
          )
            throw new Error('Invalid event stream')
          deliver(id, { type: 'open' })
          const reader = lease.response.body.getReader(),
            decoder = new TextDecoder()
          let buffer = '',
            data = [],
            eventType = '',
            first = true
          const line = (text) => {
            if (!text) {
              if (data.length)
                deliver(id, {
                  type: eventType || 'message',
                  data: data.join('\n'),
                  lastEventId: record.lastId,
                  origin: new URL(address).origin,
                })
              data = []
              eventType = ''
              return
            }
            if (text[0] === ':') return
            const colon = text.indexOf(':'),
              name = colon < 0 ? text : text.slice(0, colon)
            let value = colon < 0 ? '' : text.slice(colon + 1)
            if (value.startsWith(' ')) value = value.slice(1)
            if (name === 'data') data.push(value)
            if (name === 'event') eventType = value
            if (name === 'id' && !value.includes('\0')) record.lastId = value
            if (name === 'retry' && /^\d+$/.test(value))
              record.retry = Math.max(100, Math.min(2147483647, Number(value)))
          }
          while (!closed && !record.stopped) {
            const chunk = await reader.read()
            if (chunk.done) break
            buffer += decoder.decode(chunk.value, { stream: true })
            if (first) {
              buffer = buffer.replace(/^\uFEFF/, '')
              first = false
            }
            if (
              buffer.length + data.reduce((n, v) => n + v.length, 0) >
              BODY_LIMIT
            )
              throw new Error('Event message limit exceeded')
            let match
            while ((match = /\r\n|\r(?!$)|\n/.exec(buffer))) {
              line(buffer.slice(0, match.index))
              buffer = buffer.slice(match.index + match[0].length)
            }
          }
        } catch (_) {
          /* error event and bounded reconnect below */
        } finally {
          lease?.abort()
        }
        if (!closed && !record.stopped) {
          deliver(id, { type: 'error' })
          record.timer = setTimeout(connect, record.retry)
        }
      }
      queueMicrotask(connect)
      return { id, url: address }
    },
    stopEvents,
  }
  function stopEvents(id) {
    const record = events.get(id)
    if (!record) return
    record.stopped = true
    record.controller.abort()
    clearTimeout(record.timer)
    events.delete(id)
  }
  executor.expose('__vhtmlNetwork', bridge)
  executor.bootstrap(
    `(${installNetworkRealm.toString()})(__vhtmlNetwork,${createWeakHandles.toString()})`,
    { maintenance: true }
  )
  return () => {
    closed = true
    for (const id of requests.keys()) cancel(id)
    for (const id of events.keys()) stopEvents(id)
    for (const socket of sockets.values()) {
      socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null
      try {
        socket.close()
      } catch (_) {}
    }
    sockets.clear()
  }
}
