/*
 * i18n.js
 * Copyright (C) 2026 veypi <i@veypi.com>
 *
 * Distributed under terms of the MIT license.
 */

class I18n {
  shared = { locale: 'zh-CN', fallback: 'en-US' }
  constructor(options = {}) {
    this.shared = options || this.shared
    this.messages = {}
    this._formatters = new Map() // 缓存 Intl 实例
  }

  setLocale(lang) {
    if (this.shared.locale === lang) return this
    this.shared.locale = lang
    document.documentElement.lang = lang
    this._formatters.clear() // 清空缓存
    return this
  }

  getLocale() {
    return this.shared.locale
  }

  load(messages, merge = true) {
    if (merge) {
      Object.keys(messages).forEach(lang => {
        this.messages[lang] = { ...this.messages[lang], ...messages[lang] }
      })
    } else {
      this.messages = messages
    }
    console.log(this.shared)
    return this
  }

  // 核心翻译：支持嵌套 key、插值、复数
  t(key, options = {}) {
    const {
      locale = this.shared.locale,
      fallback = this.shared.fallback,
      count,
      ...vars
    } = options

    const getNested = (obj, path) =>
      path.split('.').reduce((acc, part) => acc?.[part], obj)

    let str = getNested(this.messages[locale], key)
      || getNested(this.messages[fallback], key)
      || key

    // 复数处理
    if (count !== undefined && typeof str === 'object') {
      if (count === 0 && str.zero) str = str.zero
      else if (count === 1 && str.one) str = str.one
      else str = str.other || str.one || key
    }

    if (typeof str !== 'string') return key

    // 变量替换 {var} 或 {{var}}
    Object.keys(vars).forEach(k => {
      str = str.replace(new RegExp(`{{?${k}}}?`, 'g'), vars[k])
    })

    return str
  }

  // 日期格式化
  d(date, options = {}) {
    const { locale = this.shared.locale, ...fmtOptions } = options
    const cacheKey = `d:${locale}:${JSON.stringify(fmtOptions)}`

    if (!this._formatters.has(cacheKey)) {
      this._formatters.set(cacheKey, new Intl.DateTimeFormat(locale, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        ...fmtOptions
      }))
    }

    const d = typeof date === 'string' ? new Date(date) : date
    return this._formatters.get(cacheKey).format(d)
  }

  // 数字格式化
  n(num, options = {}) {
    const { locale = this.shared.locale, ...fmtOptions } = options
    const cacheKey = `n:${locale}:${JSON.stringify(fmtOptions)}`

    if (!this._formatters.has(cacheKey)) {
      this._formatters.set(cacheKey, new Intl.NumberFormat(locale, {
        minimumFractionDigits: 0,
        maximumFractionDigits: 2,
        ...fmtOptions
      }))
    }

    return this._formatters.get(cacheKey).format(num)
  }

  // 货币格式化（快捷方法）
  c(num, currency = 'CNY', options = {}) {
    return this.n(num, {
      style: 'currency',
      currency,
      ...options
    })
  }

  // 相对时间（几天前/后）
  rtf(value, unit = 'day', options = {}) {
    const { locale = this.shared.locale, ...fmtOptions } = options
    const cacheKey = `rtf:${locale}:${JSON.stringify(fmtOptions)}`

    if (!this._formatters.has(cacheKey)) {
      this._formatters.set(cacheKey, new Intl.RelativeTimeFormat(locale, {
        numeric: 'auto',
        ...fmtOptions
      }))
    }

    return this._formatters.get(cacheKey).format(value, unit)
  }

  has(key, locale = this.shared.locale) {
    const getNested = (obj, path) => path.split('.').reduce((acc, part) => acc?.[part], obj)
    return !!getNested(this.messages[locale], key)
  }

  getLocales() {
    return Object.keys(this.messages)
  }
}

export default I18n
