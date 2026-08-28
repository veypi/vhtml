/*
 * build.mjs — 构建脚本（v0.10.2 方案 A：vite build + terser 补压缩）
 *
 * vite 5 的 vite:terser 插件对 lib + es 格式直接 return null（设计行为：
 * 库产物由使用方自行压缩），vite.config.js 里的 minify/terserOptions 对
 * 本仓库的 ES 库输出不生效——产物一直带注释且不做代码压缩。故在 vite
 * build 之后手动补 terser。
 *
 * 参数取舍（2026-08-28 定）：
 * - 不删 console.error / console.warn——v0.10.3 错误契约「错误该暴露就暴露」，
 *   排障依赖；只做 passes/toplevel 压缩 + 变量名混淆（不启用 unsafe、
 *   不启用 drop_console）。
 * - 不做 properties mangle——__vhtml_dev 与运行期属性名是公共契约，
 *   混淆属性名会破坏外部调试面。
 */
import { build } from 'vite'
import { minify } from 'terser'
import { readFileSync, writeFileSync, statSync } from 'node:fs'

await build({ configFile: 'vite.config.js' })

const out = 'dist/vhtml.min.js'
const before = statSync(out).size
const code = readFileSync(out, 'utf8')
const result = await minify(code, {
  ecma: 2020,
  module: true,
  compress: { passes: 2, toplevel: true },
  mangle: { toplevel: true },
  format: { comments: false },
})
writeFileSync(out, result.code)
const after = statSync(out).size
console.log(`terser: ${before} -> ${after} bytes`)
