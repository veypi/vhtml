/*
 * debug.js — vhtml 统一日志入口
 */

const MAX_LOG_RECORDS = 500
const records = []

export function hasClientDebug() {
  if (typeof localStorage === 'undefined' || !localStorage) return false
  try {
    return  Boolean(localStorage.debug)
  } catch (error) {
    return false
  }
}

export function isDebugEnabled() {
  return hasClientDebug()
}

function normalizeModulePath(value) {
  if (value === undefined || value === null || value === '') return '/'
  return value
}

function resolveModulePath(context = {}) {
  if (context.modulePath !== undefined) return normalizeModulePath(context.modulePath)
  if (context.module !== undefined) return normalizeModulePath(context.module)
  return ''
}

function buildLabel(channel, context = {}) {
  const parts = [`vhtml-${channel || 'log'}`]
  const modulePath = resolveModulePath(context)
  if (modulePath) parts.push(`module=${modulePath}`)
  const prefix = context.routerPrefix ?? context.prefix
  if (prefix !== undefined) parts.push(`prefix=${normalizeModulePath(prefix)}`)
  return `[${parts.join(' ')}]`
}

function shouldPrint(level) {
  if (level === 'warn' || level === 'error') return true
  return isDebugEnabled()
}

function consoleMethod(level) {
  if (level === 'error') return 'error'
  if (level === 'warn') return 'warn'
  return 'info'
}

export function log(level, channel, message, detail = undefined, context = {}) {
  const normalizedLevel = level || 'debug'
  const entry = {
    ts: Date.now(),
    level: normalizedLevel,
    channel: channel || 'log',
    message,
    detail,
    context: { ...context },
  }
  records.push(entry)
  if (records.length > MAX_LOG_RECORDS) records.splice(0, records.length - MAX_LOG_RECORDS)
  if (!shouldPrint(normalizedLevel)) return entry
  const method = consoleMethod(normalizedLevel)
  const label = buildLabel(channel, context)
  console[method](label, message, detail ?? '')
  return entry
}

export function debug(channel, message, detail = undefined, context = {}) {
  return log('debug', channel, message, detail, context)
}

export function info(channel, message, detail = undefined, context = {}) {
  return log('info', channel, message, detail, context)
}

export function warn(channel, message, detail = undefined, context = {}) {
  return log('warn', channel, message, detail, context)
}

export function error(channel, message, detail = undefined, context = {}) {
  return log('error', channel, message, detail, context)
}

export function getLogRecords() {
  return records.slice()
}

export function clearLogRecords() {
  records.length = 0
}
