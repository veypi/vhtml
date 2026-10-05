import { domSchema } from './dom-schema.js'

// Native drawing objects remain here. Only module-owned integer references cross the VM.
export function createCanvasBridge(getNode) {
  const contexts = new Map(),
    objects = new Map()
  let sequence = 0
  function context(id) {
    const node = getNode(id)
    if (node.nodeName !== 'CANVAS')
      throw new TypeError('Expected a module canvas')
    if (!contexts.has(id)) {
      if (contexts.size >= 128)
        throw new Error('Module canvas count limit exceeded')
      const ctx = node.getContext('2d')
      if (!ctx) throw new Error('Canvas 2D is unavailable')
      contexts.set(id, ctx)
    }
    return contexts.get(id)
  }
  function object(ref, canvas) {
    const item = objects.get(ref)
    if (!item || item.canvas !== canvas)
      throw new TypeError('Foreign canvas object')
    return item.value
  }
  function reference(value, canvas) {
    for (const [ref, item] of objects)
      if (item.value === value && item.canvas === canvas)
        return { drawing: ref }
    if (objects.size >= 2048)
      throw new Error('Module drawing object limit exceeded')
    const ref = ++sequence
    objects.set(ref, { value, canvas })
    return { drawing: ref }
  }
  function scalar(value) {
    if (
      value === null ||
      ['number', 'string', 'boolean', 'undefined'].includes(typeof value)
    )
      return value
    if (
      Array.isArray(value) &&
      value.length <= 1024 &&
      value.every((v) => typeof v === 'number')
    )
      return value
    throw new TypeError('Unsupported drawing argument')
  }
  return {
    call(action, id, name, args = []) {
      if (action === 'collect') {
        for (const ref of args) objects.delete(ref)
        return
      }
      if (action === 'open') {
        const target = getNode(id)
        if (target.nodeName !== 'CANVAS')
          throw new TypeError('Expected a module canvas')
        if (contexts.has(id)) return true
        if (contexts.size >= 128)
          throw new Error('Module canvas count limit exceeded')
        const value = target.getContext('2d')
        if (!value) return false
        contexts.set(id, value)
        return true
      }
      const ctx = context(id)
      if (action === 'get') {
        if (!domSchema.canvasProperties.includes(name))
          throw new Error('Canvas property is unavailable')
        const result = ctx[name]
        if (typeof result !== 'object' || result === null) return result
        if (!['fillStyle', 'strokeStyle'].includes(name))
          throw new Error('Unsupported drawing result')
        return reference(result, id)
      }
      if (action === 'set') {
        if (!domSchema.canvasProperties.includes(name))
          throw new Error('Canvas property is unavailable')
        // filter:url() would access a document/resource outside the canvas API.
        if (name === 'filter' && String(args[0]).toLowerCase() !== 'none')
          throw new Error('Canvas filters are unavailable')
        ctx[name] = args[0]?.drawing
          ? object(args[0].drawing, id)
          : scalar(args[0])
        return
      }
      if (action === 'object') {
        const target = object(args[0], id)
        if (name !== 'addColorStop')
          throw new Error('Drawing object operation is unavailable')
        target.addColorStop(Number(args[1]), String(args[2]))
        return
      }
      if (action !== 'call' || !domSchema.canvasMethods.includes(name))
        throw new Error('Canvas operation is unavailable')
      const values = [...args]
      if (name === 'drawImage' || name === 'createPattern') {
        const source = getNode(values.shift()?.node)
        if (!['IMG', 'CANVAS'].includes(source.nodeName))
          throw new TypeError('Unsupported drawing source')
        values.unshift(source)
        for (let i = 1; i < values.length; i++) values[i] = scalar(values[i])
      } else
        for (let i = 0; i < values.length; i++) values[i] = scalar(values[i])
      const result = ctx[name](...values)
      if (/^create/.test(name)) {
        if (!result) return null
        return reference(result, id)
      }
      if (name === 'measureText')
        return Object.fromEntries(
          'width actualBoundingBoxLeft actualBoundingBoxRight fontBoundingBoxAscent fontBoundingBoxDescent actualBoundingBoxAscent actualBoundingBoxDescent emHeightAscent emHeightDescent hangingBaseline alphabeticBaseline ideographicBaseline'
            .split(' ')
            .map((key) => [key, Number(result[key]) || 0])
        )
      return result
    },
    release(id) {
      contexts.delete(id)
      for (const [key, item] of objects)
        if (item.canvas === id) objects.delete(key)
    },
    dispose() {
      contexts.clear()
      objects.clear()
    },
  }
}
