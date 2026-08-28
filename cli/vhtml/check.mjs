#!/usr/bin/env node
/*
 * check.mjs — vhtml 静态检查器（v0.10.2，node 端执行）
 * Copyright (C) 2024 veypi <i@veypi.com>
 *
 * 契约（2026-08-28 定稿，v0.10.3 冻结后破坏性变更走大版本）：
 * - 用法：node check.mjs [--json] <file.html...>
 * - 退出码：0 = 无发现；1 = 有发现（E/W 任一）；2 = 工具故障
 *   （node/编译核缺失、IO 错误）——明确报错而非静默通过
 * - 输出：text = `<file>:<line>:<col> [E|W] <kind>: <message>` 每行一条；
 *   --json = findings 数组 [{file,line,col,severity,kind,message}]
 * - kind：syntax（表达式/语句编译失败）| vfor（v-for 结构非法）|
 *   directive（未知 v- 指令，拼写疑似）| vslot-pair | structure（标签失衡）
 * - 检查语义与运行时一致：表达式经任务 0 剥离的纯编译核 compileCode
 *   编译（只编译不执行，无副作用）；不抓语义错误与未定义标识符
 *   （has 恒 true + 运行期 warnMissedIdentifier 是运行时机制）
 * - 含 Go 模板语法（{{.）的文件视为服务端模板（如 rses/ui/root.html），
 *   跳过整体检查——运行时编译的是 Go 渲染后的产物，源码静态检查无意义
 *
 * 环境：VHTML_COMPILE_CORE = 纯编译核 compile.js 的绝对路径（Go 侧解析注入）
 */
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const corePath = process.env.VHTML_COMPILE_CORE
if (!corePath) {
  console.error('[vhtml check] VHTML_COMPILE_CORE not set (path to compile.js required)')
  process.exit(2)
}
let compileCode
try {
  ;({ compileCode } = await import(pathToFileURL(corePath).href))
} catch (e) {
  console.error(`[vhtml check] cannot load compile core at ${corePath}: ${e.message}`)
  process.exit(2)
}

const args = process.argv.slice(2)
const jsonMode = args.includes('--json')
const files = args.filter((a) => !a.startsWith('--'))
if (files.length === 0) {
  console.error('[vhtml check] no input files')
  process.exit(2)
}

const findings = []
const add = (file, line, col, severity, kind, message) =>
  findings.push({ file, line, col, severity, kind, message })

const vforRegex = /^\s*(?:\((\w+)\s*,\s*(\w+)\)|(\w+))\s+in\s+(.+?)\s*$/
const KNOWN_V = new Set([
  'v-if', 'v-else-if', 'v-else', 'v-for', 'v-show', 'v-html',
  'vslot', 'vslot-inherit', 'vref', 'vrefof', 'vsrc', 'no-vhtml',
  'single', 'unsafe',
])
const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
])
// 合法可省略闭合的标签：balance 检查时自动弹栈，不报警
const AUTOCLOSE_OK = new Set([
  'li', 'p', 'dt', 'dd', 'option', 'tr', 'td', 'th',
  'thead', 'tbody', 'tfoot', 'colgroup', 'html', 'head', 'body',
])

// compileCode 编译失败会经 errors.js reportError 打 console.error——
// 检查器自己产出 findings，静默化避免重复噪音
const origError = console.error
function tryCompile(code, isAsync) {
  console.error = () => {}
  try {
    compileCode(code, { async: isAsync })
    return null
  } catch (e) {
    return String(e?.message || e).split('\n')[0].slice(0, 160)
  } finally {
    console.error = origError
  }
}

const firstLine = (s) => String(s).split('\n')[0].slice(0, 160)
const blankKeepNewlines = (m) => m.replace(/[^\n]/g, ' ')

// 静态 import 剥离：与运行时 imports.js parseImports 同一正则——setup 脚本的
// import 语句在运行时被剥离后另行以 ESM 加载（绑定注入 data），剩余代码才
// 进 AsyncRun 编译；检查器照此预处理，保证「检查语义 = 运行时语义」
const staticImportRegex = /^[\s/]*import\s+([\w{},\s]+)\s+from\s+['"][^'"]+['"][;\s]*$/gm
const stripStaticImports = (code) => code.replace(staticImportRegex, '')

function checkAttr(file, line, col, name, value) {
  if (name === 'v-for') {
    const mm = vforRegex.exec(value)
    if (!mm) {
      add(file, line, col, 'E', 'vfor', `malformed v-for: "${firstLine(value)}" (expect "(k, i) in list" or "k in list")`)
      return
    }
    const err = tryCompile(mm[4], false)
    if (err) add(file, line, col, 'E', 'syntax', `v-for expression: ${err}`)
    return
  }
  if (name === 'v-if' || name === 'v-else-if' || name === 'v-show' || name === 'v-html') {
    if (!value) { add(file, line, col, 'W', 'directive', `${name} missing expression`); return }
    const err = tryCompile(value, false)
    if (err) add(file, line, col, 'E', 'syntax', `${name} expression: ${err}`)
    return
  }
  if (name.startsWith(':')) {
    if (!value) { add(file, line, col, 'W', 'directive', `${name} missing binding value`); return }
    const err = tryCompile(value, false)
    if (err) add(file, line, col, 'E', 'syntax', `binding ${name}: ${err}`)
    return
  }
  if (name.startsWith('@')) {
    // 修饰器独占形态（@click.stop / @dragover.prevent 无值）是合法 runtime 形态
    if (!value) {
      if (!name.includes('.')) add(file, line, col, 'W', 'directive', `${name} missing handler`)
      return
    }
    // compileCode 表达式/语句双路径与运行时 @event 一致
    const err = tryCompile(value, false)
    if (err) add(file, line, col, 'E', 'syntax', `handler ${name}: ${err}`)
    return
  }
  if (name.startsWith('v-') && !KNOWN_V.has(name)) {
    add(file, line, col, 'W', 'directive', `unknown directive "${name}" (v-fo typo?)`)
  }
}

function checkFile(file) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (e) {
    add(file, 1, 1, 'E', 'io', firstLine(e.message))
    return
  }
  // Go 模板文件（rses 壳 root.html 类）：运行时编译的是渲染后产物，源码跳过
  if (text.includes('{{.')) return
  const lineStarts = [0]
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') lineStarts.push(i + 1)
  }
  const lineCol = (idx) => {
    let lo = 0, hi = lineStarts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (lineStarts[mid] <= idx) lo = mid
      else hi = mid - 1
    }
    return [lo + 1, idx - lineStarts[lo] + 1]
  }

  let work = text

  // 1) HTML 注释整体遮蔽（运行时同样不编译注释内表达式）
  work = work.replace(/<!--[\s\S]*?(-->|$)/g, blankKeepNewlines)

  // 2) script 块：内联脚本按 async 语句块编译（setup/dispose/普通），src= 外链跳过
  work = work.replace(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/g, (m, attrs, body, off) => {
    if (!/\bsrc\s*=/.test(attrs) && body.trim()) {
      const [line, col] = lineCol(off)
      const err = tryCompile(stripStaticImports(body).trim(), true)
      if (err) add(file, line, col, 'E', 'syntax', `script block: ${err}`)
    }
    return blankKeepNewlines(m)
  })

  // 3) 标签：属性级检查 + vslot/标签 balance 记账（标签随后遮蔽，供 text 提取）
  const tagStack = []
  let vslotOpen = 0
  work = work.replace(/<\/?([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g, (m, name, attrText, off) => {
    const [line, col] = lineCol(off)
    const closing = m.startsWith('</')
    const selfClose = /\/\s*>$/.test(m)
    const lower = name.toLowerCase()

    if (!closing) {
      if (lower === 'vslot') vslotOpen++
      const attrRe = /([:@A-Za-z_][\w:.-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+)))?/g
      let a
      while ((a = attrRe.exec(attrText))) {
        const value = a[2] ?? a[3] ?? a[4] ?? ''
        checkAttr(file, line, col + 1 + a.index, a[1], value)
      }
      if (selfClose || VOID_TAGS.has(lower)) {
        if (selfClose && lower === 'vslot') vslotOpen--
      } else {
        tagStack.push({ name: lower, line })
      }
    } else {
      if (lower === 'vslot') {
        if (vslotOpen > 0) vslotOpen--
        else add(file, line, col, 'W', 'vslot-pair', 'closing </vslot> without opening')
      }
      // balance：弹掉可省略闭合标签后比对栈顶
      while (tagStack.length && AUTOCLOSE_OK.has(tagStack[tagStack.length - 1].name) && tagStack[tagStack.length - 1].name !== lower) {
        tagStack.pop()
      }
      if (tagStack.length && tagStack[tagStack.length - 1].name === lower) {
        tagStack.pop()
      } else {
        add(file, line, col, 'W', 'structure', `closing </${lower}> has no matching open tag`)
      }
    }
    return blankKeepNewlines(m)
  })

  // 4) 剩余 text 区：{{ }} 插值编译检查
  let mm
  const interpRe = /\{\{([\s\S]*?)\}\}/g
  while ((mm = interpRe.exec(work))) {
    const expr = mm[1].trim()
    if (!expr) continue
    const [line, col] = lineCol(mm.index)
    const err = tryCompile(expr, false)
    if (err) add(file, line, col, 'E', 'syntax', `interpolation: ${err}`)
  }

  // 5) 收尾：未闭合标签 / 未闭合 vslot
  for (const t of tagStack) {
    if (!AUTOCLOSE_OK.has(t.name)) add(file, t.line, 1, 'W', 'structure', `<${t.name}> never closed`)
  }
  if (vslotOpen > 0) add(file, 1, 1, 'W', 'vslot-pair', `${vslotOpen} <vslot> never closed`)
}

for (const f of files) checkFile(f)

if (jsonMode) {
  console.log(JSON.stringify(findings, null, 1))
} else if (findings.length === 0) {
  console.log('vhtml check: OK')
} else {
  for (const f of findings) {
    console.log(`${f.file}:${f.line}:${f.col} [${f.severity}] ${f.kind}: ${f.message}`)
  }
}
process.exit(findings.length > 0 ? 1 : 0)
