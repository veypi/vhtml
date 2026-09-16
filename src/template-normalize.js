import { perfStats } from './perf-stats.js'

const HTML_NS = 'http://www.w3.org/1999/xhtml'
const PRESERVE_TEXT = new Set(['PRE', 'CODE', 'TEXTAREA', 'SCRIPT', 'STYLE'])

export function preserveComment(node) {
  // 结构锚点和显式内容边界不属于开发注释。
  return /^\s*(?:~\/?v(?:if|for|item|slot)\b|vhtml:keep\b)/.test(node.nodeValue || '')
}

/** 仅在模板进入缓存/开始编译前调用，不对 clone 后的每一行重复遍历。 */
export function normalizeTemplate(root, compact = false, preserve = false) {
  if (root.nodeType === 1) {
    if ((root.namespaceURI && root.namespaceURI !== HTML_NS) ||
        root.hasAttribute('no-vhtml') || root.hasAttribute('v-html')) return
    const mode = root.getAttribute('v-whitespace')
    // compact 是作者对这个区域“缩进换行无意义”的明确声明。
    if (mode === 'compact') compact = true
    if (mode === 'preserve') { compact = false; preserve = true }
    preserve ||= PRESERVE_TEXT.has(root.nodeName) ||
      /(?:pre|break-spaces|preserve)/.test(root.style?.whiteSpace || '')
  }
  const content = root.nodeName === 'TEMPLATE' ? root.content : root
  for (const child of Array.from(content.childNodes)) {
    if (child.nodeType === 8 && !preserveComment(child)) {
      child.remove()
      perfStats.templateCommentsRemoved++
    } else if (child.nodeType === 3 && compact && !preserve &&
        /^[\t\n\r ]*$/.test(child.nodeValue) && /[\n\r]/.test(child.nodeValue)) {
      // 单行空格（例如两个 span 之间）始终保留；NBSP 等内容字符也保留。
      child.remove()
      perfStats.templateWhitespaceRemoved++
    } else if (child.nodeType === 1) {
      normalizeTemplate(child, compact, preserve)
    }
  }
}
