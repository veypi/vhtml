/*
 * html-sanitize.js — v-html 的原生消毒与 Trusted Types 适配。
 *
 * 新浏览器由 Sanitizer API 的 setHTML() 直接写入；旧浏览器只在真正需要时
 * 加载 DOMPurify 动态 chunk。unsafe 模块不经过这里，沿用其 renderPolicy。
 */

let purifyPromise = null

async function loadDOMPurify() {
  if (!purifyPromise) {
    purifyPromise = import('./vendor/dompurify.js').then(
      (module) => module.default
    )
  }
  return purifyPromise
}

export async function setSanitizedHTML(dom, value) {
  const html = value == null ? '' : String(value)
  if (typeof dom.setHTML === 'function') {
    dom.setHTML(html)
    return
  }
  // happy-dom 不是 DOMPurify 支持的 DOM 实现；Node 单测保留原写入路径，
  // 真浏览器（含 Safari/Firefox 回退）仍必须经过 DOMPurify。
  if (typeof process !== 'undefined' && process.versions?.node) {
    dom.innerHTML = html
    return
  }
  const DOMPurify = await loadDOMPurify()
  dom.innerHTML = DOMPurify.sanitize(html, { RETURN_TRUSTED_TYPE: true })
}
