import { webglMethods, webglExtensions, webglTypes } from './webgl-schema.js'

const typed = Object.fromEntries(
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
const limit = 64 * 1024 * 1024
export function createWebGLBridge(getNode) {
  const contexts = new Map(),
    objects = new Map(),
    reverse = new WeakMap(),
    allocations = new Map()
  let sequence = 0,
    allocated = 0
  function constants(target) {
    const values = {}
    for (
      let object = target;
      object && object !== Object.prototype;
      object = Object.getPrototypeOf(object)
    )
      for (const key of Object.getOwnPropertyNames(object)) {
        const descriptor = Object.getOwnPropertyDescriptor(object, key)
        if (
          typeof descriptor.value === 'number' &&
          /^[A-Z][A-Z0-9_]*$/.test(key)
        )
          values[key] = descriptor.value
      }
    return values
  }
  function context(id) {
    getNode(id)
    const value = contexts.get(id)
    if (!value) throw new Error('WebGL context is unavailable')
    return value
  }
  function decode(value, id) {
    if (value == null || ['number', 'string', 'boolean'].includes(typeof value))
      return value
    if (Array.isArray(value)) {
      if (value.length > 1048576)
        throw new Error('WebGL argument limit exceeded')
      return value.map((item) => decode(item, id))
    }
    if (value.ref) {
      const item = objects.get(value.ref)
      if (!item || item.context !== id)
        throw new TypeError('Foreign or deleted WebGL object')
      return item.value
    }
    if (value.node) {
      const source = getNode(value.node)
      if (!['IMG', 'CANVAS', 'VIDEO'].includes(source.nodeName))
        throw new TypeError('Unsupported WebGL texture source')
      return source
    }
    if (value.type === 'ArrayBuffer' || typed[value.type]) {
      const Type = typed[value.type] || Uint8Array
      if (
        !Array.isArray(value.values) ||
        value.values.length * Type.BYTES_PER_ELEMENT > 16 * 1024 * 1024
      )
        throw new Error('WebGL transfer limit exceeded')
      const data = Type.from(value.values)
      return value.type === 'ArrayBuffer' ? data.buffer : data
    }
    throw new TypeError('Unsupported WebGL argument')
  }
  function encode(value, id) {
    if (value == null || ['number', 'string', 'boolean'].includes(typeof value))
      return value
    if (ArrayBuffer.isView(value))
      return { type: value.constructor.name, values: Array.from(value) }
    if (Array.isArray(value)) return value.map((item) => encode(item, id))
    const name = value.constructor?.name
    if (webglTypes.includes(name)) {
      if (!reverse.has(value)) {
        if (objects.size >= 4096)
          throw new Error('Module WebGL object limit exceeded')
        const ref = ++sequence
        reverse.set(value, ref)
        objects.set(ref, { value, context: id, type: name })
      }
      return { ref: reverse.get(value), type: name }
    }
    if (name === 'WebGLActiveInfo')
      return { name: value.name, size: value.size, type: value.type }
    if (name === 'WebGLShaderPrecisionFormat')
      return {
        rangeMin: value.rangeMin,
        rangeMax: value.rangeMax,
        precision: value.precision,
      }
    if (Object.getPrototypeOf(value) === Object.prototype)
      return Object.fromEntries(
        Object.entries(value).filter(
          ([, item]) =>
            item == null ||
            ['number', 'boolean', 'string'].includes(typeof item)
        )
      )
    throw new TypeError('Unrecognized native WebGL result')
  }
  function reserve(key, bytes) {
    if (!Number.isFinite(bytes) || bytes < 0 || bytes > limit)
      throw new Error('WebGL allocation limit exceeded')
    const total = allocated - (allocations.get(key) || 0) + bytes
    if (total > limit) throw new Error('Module WebGL memory limit exceeded')
    allocations.set(key, bytes)
    allocated = total
  }
  function allocation(gl, id, name, args) {
    if (name === 'bufferData') {
      const bindings = new Map([
        [gl.ARRAY_BUFFER, gl.ARRAY_BUFFER_BINDING],
        [gl.ELEMENT_ARRAY_BUFFER, gl.ELEMENT_ARRAY_BUFFER_BINDING],
        [gl.COPY_READ_BUFFER, gl.COPY_READ_BUFFER_BINDING],
        [gl.COPY_WRITE_BUFFER, gl.COPY_WRITE_BUFFER_BINDING],
        [gl.PIXEL_PACK_BUFFER, gl.PIXEL_PACK_BUFFER_BINDING],
        [gl.PIXEL_UNPACK_BUFFER, gl.PIXEL_UNPACK_BUFFER_BINDING],
        [gl.TRANSFORM_FEEDBACK_BUFFER, gl.TRANSFORM_FEEDBACK_BUFFER_BINDING],
        [gl.UNIFORM_BUFFER, gl.UNIFORM_BUFFER_BINDING],
      ])
      const buffer = gl.getParameter(bindings.get(args[0]))
      if (buffer) {
        const ref = encode(buffer, id).ref
        reserve(
          `${id}:${ref}`,
          typeof args[1] === 'number' ? args[1] : args[1]?.byteLength || 0
        )
      }
    }
    if (
      name === 'copyTexImage2D' ||
      /^(?:compressed)?tex(?:Image|Storage)[23]D$/i.test(name) ||
      /^renderbufferStorage/.test(name)
    ) {
      let width,
        height,
        depth = 1,
        levels = 1,
        samples = 1
      if (name === 'texImage2D' && args.length === 6) {
        width = args[5]?.naturalWidth || args[5]?.videoWidth || args[5]?.width
        height =
          args[5]?.naturalHeight || args[5]?.videoHeight || args[5]?.height
      } else if (name === 'copyTexImage2D') {
        width = args[5]
        height = args[6]
      } else if (name === 'texStorage2D' || name === 'texStorage3D') {
        levels = args[1]
        width = args[3]
        height = args[4]
        if (name.endsWith('3D')) depth = args[5]
      } else if (name === 'renderbufferStorage') {
        width = args[2]
        height = args[3]
      } else if (name === 'renderbufferStorageMultisample') {
        samples = args[1]
        width = args[3]
        height = args[4]
      } else {
        width = args[3]
        height = args[4]
        if (name.endsWith('3D')) depth = args[5]
      }
      if (
        ![width, height, depth, levels, samples].every(
          (v) => Number.isFinite(v) && v >= 0
        ) ||
        width > 4096 ||
        height > 4096 ||
        depth > 256 ||
        levels > 16 ||
        samples > 16
      )
        throw new Error('WebGL texture dimension limit exceeded')
      const binding = name.startsWith('renderbuffer')
        ? gl.RENDERBUFFER_BINDING
        : args[0] === gl.TEXTURE_3D
          ? gl.TEXTURE_BINDING_3D
          : args[0] === gl.TEXTURE_2D_ARRAY
            ? gl.TEXTURE_BINDING_2D_ARRAY
            : args[0] === gl.TEXTURE_2D
              ? gl.TEXTURE_BINDING_2D
              : gl.TEXTURE_BINDING_CUBE_MAP
      const resource = gl.getParameter(binding)
      if (resource) {
        const ref = encode(resource, id).ref
        const face = String(args[0])
        reserve(
          `${id}:${ref}:${face}:${name.includes('Storage') ? 'storage' : args[1]}`,
          ((width * height * depth * 16 * Math.max(1, samples) * 4) / 3) *
            (name.includes('Storage') && args[0] === gl.TEXTURE_CUBE_MAP
              ? 6
              : 1)
        )
      }
    }
    if (name === 'shaderSource' && String(args[1]).length > 1024 * 1024)
      throw new Error('Shader size limit exceeded')
    if (name.startsWith('draw')) {
      const count = name.includes('Range')
        ? args[3]
        : name.includes('Arrays')
          ? args[2]
          : name.includes('Elements')
            ? args[1]
            : 0
      const instances = name.includes('Instanced') ? args.at(-1) : 1
      if (count * instances > 4 * 1024 * 1024)
        throw new Error('WebGL draw size limit exceeded')
    }
  }
  function releaseObject(ref) {
    const item = objects.get(ref)
    if (!item) return
    objects.delete(ref)
    reverse.delete(item.value)
    const prefix = `${item.context}:${ref}`
    for (const [key, bytes] of allocations)
      if (key === prefix || key.startsWith(prefix + ':')) {
        allocated -= bytes
        allocations.delete(key)
      }
  }
  return {
    call(action, id, name, args = []) {
      if (action === 'open') {
        const canvas = getNode(id)
        if (canvas.nodeName !== 'CANVAS')
          throw new TypeError('Expected a module canvas')
        if (!contexts.has(id)) {
          if (contexts.size >= 8)
            throw new Error('Module WebGL context limit exceeded')
          const options = {}
          for (const key of 'alpha antialias depth stencil premultipliedAlpha preserveDrawingBuffer failIfMajorPerformanceCaveat desynchronized'.split(
            ' '
          ))
            if (key in (args || {})) options[key] = !!args[key]
          const gl = canvas.getContext(name, options)
          if (!gl) return null
          contexts.set(id, { gl, type: name, extensions: new Map() })
        }
        const record = context(id)
        if (record.type !== name) return null
        return {
          constants: constants(record.gl),
          methods: webglMethods.filter(
            (method) => typeof record.gl[method] === 'function'
          ),
        }
      }
      const record = context(id),
        gl = record.gl
      if (action === 'get') {
        if (
          ![
            'drawingBufferWidth',
            'drawingBufferHeight',
            'drawingBufferColorSpace',
            'unpackColorSpace',
          ].includes(name)
        )
          throw new Error('WebGL property is unavailable')
        return gl[name]
      }
      if (action === 'set') {
        if (
          !['drawingBufferColorSpace', 'unpackColorSpace'].includes(name) ||
          !['srgb', 'display-p3'].includes(args)
        )
          throw new Error('WebGL property is unavailable')
        gl[name] = args
        return
      }
      if (action === 'supportedExtensions')
        return (gl.getSupportedExtensions() || []).filter((value) =>
          Object.hasOwn(webglExtensions, value)
        )
      if (action === 'extension') {
        if (!Object.hasOwn(webglExtensions, name)) return null
        const extension = gl.getExtension(name)
        if (!extension) return null
        record.extensions.set(name, extension)
        return {
          constants: constants(extension),
          methods: webglExtensions[name].filter(
            (method) => typeof extension[method] === 'function'
          ),
        }
      }
      let target = gl,
        method = name
      if (action === 'extensionCall') {
        const [extension, member] = name.split(':')
        if (!webglExtensions[extension]?.includes(member))
          throw new Error('WebGL extension operation is unavailable')
        target = record.extensions.get(extension)
        method = member
        if (!target) throw new Error('WebGL extension is unavailable')
      } else if (action !== 'call' || !webglMethods.includes(method))
        throw new Error('WebGL operation is unavailable')
      if (
        (method.startsWith('create') ||
          method === 'getUniformLocation' ||
          method === 'fenceSync') &&
        objects.size >= 4096
      )
        throw new Error('Module WebGL object limit exceeded')
      const values = args.map((value) => decode(value, id))
      if (method === 'clientWaitSync' && values[2] > 1000000)
        throw new Error('WebGL wait limit exceeded')
      allocation(gl, id, method, values)
      const result = target[method](...values)
      if (method.startsWith('delete') && args[0]?.ref)
        releaseObject(args[0].ref)
      const write =
        method === 'readPixels' ? 6 : method === 'getBufferSubData' ? 2 : -1
      return {
        value: encode(result, id),
        ...(write >= 0 && ArrayBuffer.isView(values[write])
          ? { write: { index: write, value: encode(values[write], id) } }
          : {}),
      }
    },
    release(id) {
      const record = contexts.get(id)
      if (record) {
        record.gl.getExtension('WEBGL_lose_context')?.loseContext()
        contexts.delete(id)
      }
      for (const [ref, item] of objects)
        if (item.context === id) releaseObject(ref)
    },
    dispose() {
      for (const id of [...contexts.keys()]) this.release(id)
    },
  }
}
