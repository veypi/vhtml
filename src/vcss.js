/*
 * vcss.js
 * Copyright (C) 2025 veypi <i@veypi.com>
 *
 * Distributed under terms of the GPL license.
 *
 * 组件样式作用域编译器（单遍 tokenizer，字符串/括号/方括号感知）
 *
 * 契约（test/vcss.test.js 锁定）：
 *   - 普通选择器追加 [vrefof="{scope}"]（组件编译出的后代元素携带 vrefof）
 *   - body / :root 映射为宿主节点选择器 [vref="{scope}"]，其后内容穿透不追加 vrefof
 *   - @keyframes 名称与 animation/animation-name 引用统一追加 "-{scope 字母数字}" 后缀
 */

// animation 简写中可能出现的非名称关键字
const ANIM_KEYWORDS = new Set([
  'ease', 'ease-in', 'ease-out', 'ease-in-out', 'linear', 'step-start', 'step-end',
  'infinite', 'normal', 'reverse', 'alternate', 'alternate-reverse',
  'none', 'forwards', 'backwards', 'both', 'running', 'paused',
])

class CSSParser {
  constructor() {
    this.scopeAttribute = ''
    this.scopeBody = ''
    this.scopeSuffix = ''
    this.scopedKeyframes = new Map()
  }

  /**
   * 解析 CSS 文本并添加作用域
   * @param {string} cssText
   * @param {string} scope 作用域标识（组件 URL）
   * @returns {string}
   */
  parse(cssText, scope) {
    this.scopeAttribute = `[vrefof="${scope}"]`
    this.scopeBody = `[vref="${scope}"]`
    this.scopeSuffix = scope.replace(/[^a-zA-Z0-9]/g, '')
    this.scopedKeyframes.clear()

    cssText = this.stripComments(cssText)
    this.collectKeyframes(cssText)
    return this.parseRules(cssText)
  }

  collectKeyframes(cssText) {
    const re = /@keyframes\s+([^\s{]+)/gi
    let m
    while ((m = re.exec(cssText)) !== null) {
      this.scopedKeyframes.set(m[1], m[1] + '-' + this.scopeSuffix)
    }
  }

  /** 移除注释；字符串字面量内的注释序列保留 */
  stripComments(cssText) {
    let out = ''
    let i = 0
    const n = cssText.length
    while (i < n) {
      const c = cssText[i]
      if (c === '"' || c === "'") {
        const end = this.scanString(cssText, i)
        out += cssText.slice(i, end)
        i = end
      } else if (c === '/' && cssText[i + 1] === '*') {
        i += 2
        while (i < n && !(cssText[i] === '*' && cssText[i + 1] === '/')) i++
        i = Math.min(i + 2, n)
      } else {
        out += c
        i++
      }
    }
    return out
  }

  /** 返回从 start（引号）开始的字符串字面量的结束下标（右引号之后） */
  scanString(s, start) {
    const q = s[start]
    let i = start + 1
    while (i < s.length) {
      if (s[i] === '\\') { i += 2; continue }
      if (s[i] === q) return i + 1
      i++
    }
    return s.length
  }

  /** 解析规则序列（样式表顶层或 @media/@supports 内部） */
  parseRules(cssText) {
    let out = ''
    let i = 0
    const n = cssText.length
    while (i < n) {
      // prelude：扫描到顶层 '{' 或 ';'（字符串感知）
      const start = i
      let inStr = null
      while (i < n) {
        const c = cssText[i]
        if (inStr) {
          if (c === '\\') i++
          else if (c === inStr) inStr = null
        } else if (c === '"' || c === "'") inStr = c
        else if (c === '{' || c === ';') break
        i++
      }
      const prelude = cssText.slice(start, i)
      if (i >= n) {
        out += prelude
        break
      }
      if (cssText[i] === ';') {
        // 无块 @规则（@import/@charset/@namespace 等）原样通过
        out += prelude + ';'
        i++
        continue
      }
      const block = this.readBlock(cssText, i)
      i = block.endIndex
      const ws = prelude.match(/^\s*/)[0]
      const name = prelude.trim()
      if (!name) {
        out += prelude + block.content
      } else if (name[0] === '@') {
        out += ws + this.processAtRule(name, block)
      } else {
        out += ws + this.scopeSelector(name) + this.processRuleContent(block.content)
      }
    }
    return out
  }

  /** 读取一对匹配大括号（含），字符串内的括号不计 */
  readBlock(cssText, start) {
    let i = start
    let depth = 0
    let inStr = null
    const n = cssText.length
    while (i < n) {
      const c = cssText[i]
      if (inStr) {
        if (c === '\\') i++
        else if (c === inStr) inStr = null
      } else if (c === '"' || c === "'") inStr = c
      else if (c === '{') depth++
      else if (c === '}') {
        depth--
        if (depth === 0) { i++; break }
      }
      i++
    }
    return { content: cssText.slice(start, i), endIndex: i }
  }

  processAtRule(prelude, block) {
    const lower = prelude.toLowerCase()
    if (lower.startsWith('@keyframes')) {
      const m = prelude.match(/@keyframes\s+([^\s{]+)/i)
      const scoped = m && this.scopedKeyframes.get(m[1])
      if (scoped) {
        // 锚定替换 @keyframes 声明中的名称 token；直接 replace(name) 会误伤
        // "@keyframes" 关键字内的相同子串（如名称 'a'/'m'）
        prelude = prelude.replace(/(@keyframes\s+)[^\s{]+/i, `$1${scoped}`)
      }
      return prelude + block.content
    }
    if (lower.startsWith('@media') || lower.startsWith('@supports')) {
      const inner = block.content.slice(1, -1)
      return prelude + '{' + this.parseRules(inner) + '}'
    }
    // 其他 @规则（@font-face 等）原样通过
    return prelude + block.content
  }

  /** 处理规则体内的 animation / animation-name 动画名引用 */
  processRuleContent(content) {
    content = content.replace(
      /(?<![-\w])animation-name\s*:\s*([^;}]+)(;|\})/gi,
      (m, names, term) => `animation-name: ${this.processAnimationNames(names)}${term}`,
    )
    content = content.replace(
      /(?<![-\w])animation\s*:\s*([^;}]+)(;|\})/gi,
      (m, value, term) => `animation: ${this.processAnimationValue(value)}${term}`,
    )
    return content
  }

  processAnimationValue(value) {
    let important = ''
    value = value.replace(/!important\s*$/i, () => {
      important = ' !important'
      return ''
    })
    return this.splitTopLevel(value, ',')
      .map(anim => this.renameSingleAnimation(anim.trim()))
      .join(', ') + important
  }

  processAnimationNames(names) {
    return this.splitTopLevel(names, ',')
      .map(n => {
        const t = n.trim()
        return this.scopedKeyframes.get(t) || t
      })
      .join(', ')
  }

  /** 在单个 animation 简写中定位动画名并重命名（跳过时间/次数/关键字/时间函数） */
  renameSingleAnimation(anim) {
    if (!anim) return anim
    const tokens = this.tokenizeValue(anim)
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i]
      if (/^-?(\d+\.?\d*|\.\d+)(m?s)$/i.test(t)) continue // 时间值 0.3s / 200ms
      if (/^\d+(\.\d+)?$/.test(t)) continue // 迭代次数
      if (/^(cubic-bezier|steps)\(/i.test(t)) continue // 时间函数
      if (ANIM_KEYWORDS.has(t.toLowerCase())) continue // 关键字
      // 首个剩余 token 即动画名
      const scoped = this.scopedKeyframes.get(t)
      if (scoped) tokens[i] = scoped
      break
    }
    return tokens.join(' ')
  }

  /** 括号感知空白分词（cubic-bezier(0.1, 0.7, ...) 含空格保持单 token） */
  tokenizeValue(value) {
    const tokens = []
    let depth = 0
    let cur = ''
    for (const c of value) {
      if (c === '(') depth++
      else if (c === ')') depth--
      if (/\s/.test(c) && depth === 0) {
        if (cur) { tokens.push(cur); cur = '' }
      } else {
        cur += c
      }
    }
    if (cur) tokens.push(cur)
    return tokens
  }

  /** 按顶层分隔符切分（括号/方括号/字符串感知） */
  splitTopLevel(value, sep) {
    const parts = []
    let paren = 0
    let bracket = 0
    let inStr = null
    let cur = ''
    for (let i = 0; i < value.length; i++) {
      const c = value[i]
      if (inStr) {
        cur += c
        if (c === '\\') { if (i + 1 < value.length) cur += value[++i] }
        else if (c === inStr) inStr = null
        continue
      }
      if (c === '"' || c === "'") { inStr = c; cur += c; continue }
      if (c === '(') paren++
      else if (c === ')') paren--
      else if (c === '[') bracket++
      else if (c === ']') bracket--
      if (c === sep && paren === 0 && bracket === 0) {
        parts.push(cur)
        cur = ''
        continue
      }
      cur += c
    }
    parts.push(cur)
    return parts
  }

  scopeSelector(selector) {
    return this.splitTopLevel(selector, ',')
      .map(s => this.scopeSingleSelector(s.trim()))
      .join(', ')
  }

  scopeSingleSelector(sel) {
    if (!sel || sel === '*') return sel

    // 宿主选择器开头：body / :root 映射为宿主节点，其后内容全部穿透
    const host = sel.match(/^(body|:root)(?=$|[.\[#: >+~])/)
    if (host) return this.scopeBody + sel.slice(host[0].length)

    // 首个顶层伪类/伪元素切分：主体加作用域，伪类部分原样保留
    // （锁定行为：.a:hover .b → .a[A]:hover .b，伪类后的后代不再加作用域）
    const idx = this.findTopLevelColon(sel)
    if (idx > 0) {
      return this.scopeSelectorChain(sel.slice(0, idx)) + sel.slice(idx)
    }
    return this.scopeSelectorChain(sel)
  }

  /** 查找首个顶层 ':'（方括号/字符串内的冒号忽略，如 [href*=":"]） */
  findTopLevelColon(sel) {
    let bracket = 0
    let inStr = null
    for (let i = 0; i < sel.length; i++) {
      const c = sel[i]
      if (inStr) {
        if (c === '\\') i++
        else if (c === inStr) inStr = null
        continue
      }
      if (c === '"' || c === "'") { inStr = c; continue }
      if (c === '[') bracket++
      else if (c === ']') bracket--
      else if (c === ':' && bracket === 0) return i
    }
    return -1
  }

  /** 为无伪类的选择器链加作用域：只作用于最后一个复合选择器 */
  scopeSelectorChain(part) {
    // 切分为复合选择器与组合器（顶层空白 / > + ~），保留原始分隔
    const tokens = [] // { sel: boolean, text: string }
    let paren = 0
    let bracket = 0
    let inStr = null
    let cur = ''
    let i = 0
    const n = part.length
    const flush = () => { if (cur) { tokens.push({ sel: true, text: cur }); cur = '' } }
    while (i < n) {
      const c = part[i]
      if (inStr) {
        cur += c
        if (c === '\\') { if (i + 1 < n) cur += part[++i] }
        else if (c === inStr) inStr = null
        i++
        continue
      }
      if (c === '"' || c === "'") { inStr = c; cur += c; i++; continue }
      if (c === '(') paren++
      else if (c === ')') paren--
      else if (c === '[') bracket++
      else if (c === ']') bracket--
      if (paren === 0 && bracket === 0 && (/\s/.test(c) || c === '>' || c === '+' || c === '~')) {
        flush()
        // 消费整个组合器：空白* [>+~]? 空白*
        let comb = ''
        while (i < n && /\s/.test(part[i])) comb += part[i++]
        if (i < n && (part[i] === '>' || part[i] === '+' || part[i] === '~')) comb += part[i++]
        while (i < n && /\s/.test(part[i])) comb += part[i++]
        tokens.push({ sel: false, text: comb })
        continue
      }
      cur += c
      i++
    }
    flush()

    for (let i = tokens.length - 1; i >= 0; i--) {
      const t = tokens[i]
      if (!t.sel) continue
      const host = t.text.match(/^(body|:root)(?=$|[.\[#:])/)
      if (host) t.text = this.scopeBody + t.text.slice(host[0].length)
      else t.text = t.text + this.scopeAttribute
      break
    }
    return tokens.map(t => t.text).join('')
  }
}

const parser = new CSSParser()

export default parser

export { CSSParser }
