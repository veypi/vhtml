// 在依赖收集期生成快照，DOM 回调不再读取可能已经原地变化的响应式对象。
export function classValue(value) {
  const tokens = new Set()
  const add = value => {
    if (typeof value === 'string') {
      for (const token of value.split(/\s+/)) if (token) tokens.add(token)
    } else if (Array.isArray(value)) {
      value.forEach(add)
    } else if (value && typeof value === 'object') {
      for (const key in value) if (value[key]) add(key)
    }
  }
  add(value)
  return [...tokens].sort().join(' ')
}

// 每个 document 共用一个脱离文档的 CSS 解析器，不给每个绑定增加宿主节点。
const styleParsers = new WeakMap()
export function styleValue(value, doc) {
  // 先读取所有代理字段，避免 getter 中嵌套求值复用解析器时污染它。
  const entries = value && typeof value === 'object' ? Object.entries(value) : null
  let parser = styleParsers.get(doc)
  if (!parser) {
    parser = doc.createElement('div').style
    styleParsers.set(doc, parser)
  }
  parser.cssText = typeof value === 'string' ? value : ''
  if (entries) {
    for (let [key, val] of entries) {
      if (val == null) continue
      if (!key.startsWith('--')) {
        key = key === 'cssFloat' ? 'float' : key.replace(/[A-Z]/g, m => '-' + m.toLowerCase()).replace(/^ms-/, '-ms-')
      }
      val = String(val)
      const important = /\s*!important\s*$/i.test(val)
      parser.setProperty(key, important ? val.replace(/\s*!important\s*$/i, '') : val, important ? 'important' : '')
    }
  }
  const result = new Map()
  for (let i = 0; i < parser.length; i++) {
    const key = parser.item(i)
    result.set(key, [parser.getPropertyValue(key), parser.getPropertyPriority(key)])
  }
  return result
}

export function sameStyle(a, b) {
  if (a.size !== b.size) return false
  for (const [key, [value, priority]] of a) {
    const next = b.get(key)
    if (!next || next[0] !== value || next[1] !== priority) return false
  }
  return true
}

// Shared by live native styles and the isolated policy's pending declaration.
export function patchStyle(style, next, previous) {
  let writes = 0
  for (const key of previous.keys()) {
    if (!next.has(key) && style.getPropertyValue(key)) {
      style.removeProperty(key)
      writes++
    }
  }
  for (const [key, [value, priority]] of next) {
    if (style.getPropertyValue(key) === value && style.getPropertyPriority(key) === priority)
      continue
    style.setProperty(key, value, priority)
    writes++
  }
  return writes
}

export function setBoundAttribute(dom, key, value) {
  if (typeof value === 'function') {
    value = value()
  }
  // 属性名映射表
  const propertyMap = {
    htmlfor: 'htmlFor',
    readonly: 'readOnly',
    maxlength: 'maxLength',
    minlength: 'minLength',
    cellspacing: 'cellSpacing',
    cellpadding: 'cellPadding',
    rowspan: 'rowSpan',
    colspan: 'colSpan',
    tabindex: 'tabIndex',
    usemap: 'useMap',
    frameborder: 'frameBorder',
    contenteditable: 'contentEditable',
    spellcheck: 'spellcheck',
    autocapitalize: 'autocapitalize',
  }

  // 需要使用 DOM 属性设置的属性
  const domProperties = new Set([
    'value',
    'checked',
    'selected',
    'disabled',
    'readOnly',
    'maxLength',
    'minLength',
    'htmlFor',
    'tabIndex',
    'scrollTop',
    'scrollLeft',
    'scrollWidth',
    'scrollHeight',
    'clientWidth',
    'clientHeight',
    'offsetWidth',
    'offsetHeight',
    'style',
    'dataset',
  ])

  // 布尔属性
  const booleanAttributes = new Set([
    'checked',
    'selected',
    'disabled',
    'readonly',
    'required',
    'hidden',
    'autofocus',
    'multiple',
    'novalidate',
  ])

  // 转换属性名
  const lowerKey = key.toLowerCase()
  const mappedKey = propertyMap[lowerKey] || key

  // 设置属性的策略：
  if (domProperties.has(mappedKey)) {
    // DOM 属性
    if (value === undefined) {
      dom[mappedKey] = ''
    } else {
      dom[mappedKey] = value
    }
  } else if (booleanAttributes.has(lowerKey)) {
    // 布尔属性
    if (value) {
      dom.setAttribute(lowerKey, '')
    } else {
      dom.removeAttribute(lowerKey)
    }
  } else {
    // 其他属性使用 setAttribute
    if (value === undefined) {
      dom.removeAttribute(key)
    } else {
      dom.setAttribute(key, value)
    }
  }
}
