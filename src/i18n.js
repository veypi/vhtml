/*
 * i18n.js — 国际化
 * Copyright (C) 2026 veypi <i@veypi.com>
 */

class I18n {
  constructor(sharedState) {
    // 共享状态模式：ModuleContextManager 传入 sharedLocale 对象
    // 多个 I18n 实例共享同一个 locale，一处修改处处生效
    this._shared = sharedState || { locale: 'zh-CN', fallback: 'en-US' }
    this.messages = {}
    this._formatters = new Map()
  }

  get locale() { return this._shared.locale }
  set locale(lang) { this._shared.locale = lang }

  get fallback() { return this._shared.fallback }

  setLocale(lang) {
    if (this._shared.locale === lang) return this
    this._shared.locale = lang
    document.documentElement.lang = lang
    this._formatters.clear()
    return this
  }

  getLocale() {
    return this._shared.locale
  }

  load(messages, merge = true) {
    messages = messages || {}
    if (merge) {
      Object.keys(messages).forEach(lang => {
        if (!this.messages[lang]) this.messages[lang] = {}
        Object.keys(messages[lang] || {}).forEach(key => {
          this.messages[lang][key] = messages[lang][key]
        })
      })
    } else {
      Object.keys(this.messages).forEach(lang => delete this.messages[lang])
      Object.keys(messages).forEach(lang => {
        this.messages[lang] = messages[lang] || {}
      })
    }
    return this
  }

  t(key, options = {}) {
    const {
      locale = this.locale,
      fallback = this.fallback,
      count,
      ...vars
    } = options
    const replaceVars = count === undefined ? vars : { ...vars, count }

    let str = this.messages[locale]?.[key]
      || this.messages[fallback]?.[key]
      || key

    if (count !== undefined && typeof str === 'object') {
      if (count === 0 && str.zero) str = str.zero
      else if (count === 1 && str.one) str = str.one
      else str = str.other || str.one || key
    }

    if (typeof str !== 'string') return key

    Object.keys(replaceVars).forEach(k => {
      str = str.replace(new RegExp(`{{?${k}}}?`, 'g'), replaceVars[k])
    })

    return str
  }

  d(date, options = {}) {
    const { locale = this.locale, ...fmtOptions } = options
    const cacheKey = `d:${locale}:${JSON.stringify(fmtOptions)}`
    if (!this._formatters.has(cacheKey)) {
      this._formatters.set(cacheKey, new Intl.DateTimeFormat(locale, {
        year: 'numeric', month: 'short', day: 'numeric', ...fmtOptions
      }))
    }
    const d = typeof date === 'string' ? new Date(date) : date
    return this._formatters.get(cacheKey).format(d)
  }

  n(num, options = {}) {
    const { locale = this.locale, ...fmtOptions } = options
    const cacheKey = `n:${locale}:${JSON.stringify(fmtOptions)}`
    if (!this._formatters.has(cacheKey)) {
      this._formatters.set(cacheKey, new Intl.NumberFormat(locale, {
        minimumFractionDigits: 0, maximumFractionDigits: 2, ...fmtOptions
      }))
    }
    return this._formatters.get(cacheKey).format(num)
  }

  c(num, currency = 'CNY', options = {}) {
    return this.n(num, { style: 'currency', currency, ...options })
  }

  rtf(value, unit = 'day', options = {}) {
    const { locale = this.locale, ...fmtOptions } = options
    const cacheKey = `rtf:${locale}:${JSON.stringify(fmtOptions)}`
    if (!this._formatters.has(cacheKey)) {
      this._formatters.set(cacheKey, new Intl.RelativeTimeFormat(locale, {
        numeric: 'auto', ...fmtOptions
      }))
    }
    return this._formatters.get(cacheKey).format(value, unit)
  }

  has(key, locale = this.locale) {
    const value = this.messages[locale]?.[key]
    if (value === undefined) return false
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return true
    return value.one !== undefined || value.other !== undefined
  }

  getLocales() {
    return Object.keys(this.messages)
  }
}

export default I18n
