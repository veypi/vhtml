// A WebGL object graph wholly inside the guest realm. Calls transfer scalars,
// binary data and private references; they never transfer native prototypes.
export function initializeWebGLRealm(call, node, nodeId, objectTypes) {
  const contexts = new WeakMap(),
    references = new WeakMap(),
    objects = new Map()
  const arrays = Object.fromEntries(
    [
      Int8Array,
      Uint8Array,
      Uint8ClampedArray,
      Int16Array,
      Uint16Array,
      Int32Array,
      Uint32Array,
      Float32Array,
      Float64Array,
    ].map((Type) => [Type.name, Type])
  )
  class WebGLRenderingContext {
    constructor() {
      throw new TypeError('Use canvas.getContext')
    }
  }
  class WebGL2RenderingContext extends WebGLRenderingContext {}
  Object.assign(globalThis, { WebGLRenderingContext, WebGL2RenderingContext })
  const classes = {}
  for (const name of objectTypes) {
    classes[name] = class {
      constructor() {
        throw new TypeError('Use WebGL create methods')
      }
    }
    globalThis[name] = classes[name]
  }
  function encode(value) {
    if (value == null || ['number', 'string', 'boolean'].includes(typeof value))
      return value
    if (references.has(value)) return { ref: references.get(value) }
    if (value instanceof ArrayBuffer) {
      if (value.byteLength > 16 * 1024 * 1024)
        throw new Error('WebGL transfer limit exceeded')
      return { type: 'ArrayBuffer', values: Array.from(new Uint8Array(value)) }
    }
    if (ArrayBuffer.isView(value)) {
      if (value.byteLength > 16 * 1024 * 1024)
        throw new Error('WebGL transfer limit exceeded')
      if (value instanceof DataView)
        return {
          type: 'Uint8Array',
          values: Array.from(
            new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
          ),
        }
      return { type: value.constructor.name, values: Array.from(value) }
    }
    if (Array.isArray(value)) return value.map(encode)
    try {
      return { node: nodeId(value) }
    } catch (_) {
      throw new TypeError('Unsupported WebGL value')
    }
  }
  function decode(value) {
    if (value == null || typeof value !== 'object') return value
    if (Array.isArray(value)) return value.map(decode)
    if (value.ref) {
      if (!objects.has(value.ref)) {
        const object = Object.create(classes[value.type].prototype)
        references.set(object, value.ref)
        objects.set(value.ref, object)
      }
      return objects.get(value.ref)
    }
    if (arrays[value.type]) return arrays[value.type].from(value.values)
    return value
  }
  function method(id, name, extension) {
    return (...args) => {
      const result = call(
        extension ? 'extensionCall' : 'call',
        id,
        extension ? extension + ':' + name : name,
        args.map(encode)
      )
      if (result.write) {
        const destination = args[result.write.index]
        const source = decode(result.write.value)
        if (destination instanceof DataView)
          new Uint8Array(
            destination.buffer,
            destination.byteOffset,
            destination.byteLength
          ).set(source)
        else destination.set(source)
      }
      if (/^delete/.test(name) && references.has(args[0]))
        objects.delete(references.get(args[0]))
      return decode(result.value)
    }
  }
  return {
    open(canvas, id, type, options = {}) {
      if (type === 'experimental-webgl') type = 'webgl'
      const cache = contexts.get(canvas) || new Map()
      const existing = cache.get(type)?.deref()
      if (existing) return existing
      const info = call('open', id, type, options)
      if (!info) return null
      const value = Object.create(
        (type === 'webgl2' ? WebGL2RenderingContext : WebGLRenderingContext)
          .prototype
      )
      Object.defineProperty(value, '__noproxy', { value: true })
      Object.defineProperty(value, 'canvas', { value: canvas })
      Object.assign(value, info.constants)
      for (const name of info.methods) value[name] = method(id, name)
      for (const name of [
        'drawingBufferWidth',
        'drawingBufferHeight',
        'drawingBufferColorSpace',
        'unpackColorSpace',
      ])
        Object.defineProperty(value, name, {
          get: () => call('get', id, name),
          ...(/ColorSpace$/.test(name)
            ? { set: (next) => call('set', id, name, String(next)) }
            : {}),
        })
      const extensions = new Map()
      value.getSupportedExtensions = () => call('supportedExtensions', id)
      value.getExtension = (name) => {
        name = String(name)
        if (!extensions.has(name)) {
          const info = call('extension', id, name)
          if (!info) return null
          const extension = { ...info.constants }
          for (const member of info.methods)
            extension[member] = method(id, member, name)
          extensions.set(name, extension)
        }
        return extensions.get(name)
      }
      cache.set(type, new WeakRef(value))
      contexts.set(canvas, cache)
      return value
    },
  }
}
