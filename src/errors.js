/*
 * errors.js — 全局错误登记表（v0.10.3 错误契约）
 *
 * 原则：静默失败是最恶劣的失败形态。模板/编译/表达式/挂载四类错误统一
 * 登记于此，__vhtml_dev.errors 是排障的唯一聚合入口。
 */

const MAX_ERROR_LOG = 100

export const errorLog = []

export function recordError(entry) {
  if (!entry) return null
  const item = { at: Date.now(), ...entry }
  errorLog.push(item)
  if (errorLog.length > MAX_ERROR_LOG) errorLog.shift()
  return item
}

/** 登记 + console.error 一步到位（错误该暴露就暴露） */
export function reportError(kind, message, extra = {}) {
  const item = recordError({ kind, message, ...extra })
  console.error(`[vhtml] ${kind} error`, item)
  return item
}
