/*
 * compile-stats.js — 编译耗时统计（__vhtml_dev 观测层）
 *
 * 纯计数模块：compile.js / compiler.js 共用，零 DOM 依赖（node 端 check /
 * 基准加载安全）。数据经 reactive.js 挂到 __vhtml_dev.compileStats，
 * 用于编译/渲染占比诊断。不构成公共契约（__vhtml_dev 观测层本身即非契约）。
 */
export const compileStats = {
  /** compileNode 调用次数（含 v-for 行、递归、组件标签解析） */
  nodeCompiles: 0,
  /** compileNode 累计耗时 ms（帧耗时 = 总 − 子递归增量） */
  nodeMs: 0,
  /** compileCode 调用次数（含缓存命中） */
  codeCompiles: 0,
  /** compileCode 累计耗时 ms（含缓存查找） */
  codeMs: 0,
  /** v-for 新建条目的行数（reconcile 首建；缓存命中不含） */
  vforLines: 0,
}

/** 计时基准：node 端（check/基准）与浏览器均可用 */
export const now = () =>
  typeof performance !== 'undefined' ? performance.now() : Date.now()
