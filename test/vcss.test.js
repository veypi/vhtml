/*
 * vcss.test.js
 * vhtml 组件样式作用域编译器（src/vcss.js）行为测试
 *
 * 运行：node --test（仓库根目录）
 *
 * 作用域契约：
 *   - 普通选择器追加 [vrefof="{scope}"]（组件编译出的后代元素携带 vrefof）
 *   - body / :root 映射为宿主节点选择器 [vref="{scope}"]（宿主元素携带 vref）
 *   - body .xxx（有空格）为穿透写法：宿主后代不再追加 vrefof，可匹配运行时创建的 DOM
 *   - @keyframes 名称与 animation/animation-name 引用统一追加 "-{scope 字母数字}" 后缀
 */

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import parser from '../src/vcss.js'

const SCOPE = '/comp'
const A = `[vrefof="${SCOPE}"]`   // 后代作用域属性
const B = `[vref="${SCOPE}"]`     // 宿主属性
const SUFFIX = 'comp'             // SCOPE 去除非字母数字后的 keyframes 后缀

const parse = (css, scope = SCOPE) => parser.parse(css, scope)

// 普通选择器作用域
describe('plain selectors', () => {
  test('class selector gets scope attribute', () => {
    assert.equal(parse('.a{color:red}'), `.a${A}{color:red}`)
  })

  test('tag selector gets scope attribute', () => {
    assert.equal(parse('div{margin:0}'), `div${A}{margin:0}`)
  })

  test('id selector gets scope attribute', () => {
    assert.equal(parse('#app{display:flex}'), `#app${A}{display:flex}`)
  })

  test('comma separated selectors each get scope attribute', () => {
    assert.equal(parse('.a,.b{x:1}'), `.a${A}, .b${A}{x:1}`)
  })

  // 属性值内的逗号属于字符串，不应切断多选择器
  test('comma inside attribute value does not break selector splitting', () => {
    assert.equal(parse('.a[data-x="a,b"],.b{y:2}'), `.a[data-x="a,b"]${A}, .b${A}{y:2}`)
  })

  test('universal selector is left untouched', () => {
    assert.equal(parse('*{box-sizing:border-box}'), '*{box-sizing:border-box}')
  })

  test('attribute selector gets scope attribute', () => {
    assert.equal(parse('input[type="text"]{x:1}'), `input[type="text"]${A}{x:1}`)
  })

  // 属性值内的冒号不是伪类边界
  test('attribute selector containing ":" is not treated as pseudo class', () => {
    assert.equal(parse('.a[href*=":"]{x:1}'), `.a[href*=":"]${A}{x:1}`)
  })

  test('multiple rules are all processed', () => {
    assert.equal(parse('.a{x:1}.b{y:2}'), `.a${A}{x:1}.b${A}{y:2}`)
  })

  test('empty input returns empty', () => {
    assert.equal(parse(''), '')
  })
})

// 宿主选择器：body / :root → [vref="scope"]
describe('host selectors (body / :root)', () => {
  test('body maps to host', () => {
    assert.equal(parse('body{display:flex}'), `${B}{display:flex}`)
  })

  test(':root maps to host', () => {
    assert.equal(parse(':root{display:flex}'), `${B}{display:flex}`)
  })

  // 宿主 + 状态类（2026-08-10 修复：原实现把 body.desktop 错编译为永不命中的
  // body.desktop[vrefof=...]，aic 桌面模式拖拽/紧凑样式曾因此静默失效）
  test('body with class maps to host with class', () => {
    assert.equal(parse('body.desktop{x:1}'), `${B}.desktop{x:1}`)
  })

  test('body with id maps to host with id', () => {
    assert.equal(parse('body#main{x:1}'), `${B}#main{x:1}`)
  })

  test('body with attribute maps to host with attribute', () => {
    assert.equal(parse('body[data-x]{x:1}'), `${B}[data-x]{x:1}`)
  })

  test('body with pseudo class maps to host with pseudo class', () => {
    assert.equal(parse('body:hover{x:1}'), `${B}:hover{x:1}`)
  })

  test(':root with class maps to host with class', () => {
    assert.equal(parse(':root.dark{x:1}'), `${B}.dark{x:1}`)
  })

  test(':root with pseudo class maps to host with pseudo class', () => {
    assert.equal(parse(':root:hover{x:1}'), `${B}:hover{x:1}`)
  })

  test('body mixed with normal selector in comma list', () => {
    assert.equal(parse('body,.a{x:1}'), `${B}, .a${A}{x:1}`)
  })
})

// 组合器与穿透
describe('combinators and piercing', () => {
  // body .xxx（有空格）：穿透，后代不加 vrefof，可匹配运行时创建的 DOM
  test('body descendant pierces without scope attribute', () => {
    assert.equal(parse('body .title{x:1}'), `${B} .title{x:1}`)
  })

  test('body with class plus descendant pierces', () => {
    assert.equal(parse('body.desktop .brand{x:1}'), `${B}.desktop .brand{x:1}`)
  })

  test(':root descendant pierces', () => {
    assert.equal(parse(':root .title{x:1}'), `${B} .title{x:1}`)
  })

  // 普通后代：只给最后一段加作用域（前面段保持原样）
  test('descendant combinator scopes only the last part', () => {
    assert.equal(parse('.parent .child{x:1}'), `.parent .child${A}{x:1}`)
  })

  test('child combinator', () => {
    assert.equal(parse('.box>.child{x:1}'), `.box>.child${A}{x:1}`)
  })

  test('child combinator with spaces', () => {
    assert.equal(parse('.box > .child{x:1}'), `.box > .child${A}{x:1}`)
  })

  test('adjacent sibling combinator', () => {
    assert.equal(parse('.a + .b{x:1}'), `.a + .b${A}{x:1}`)
  })

  test('general sibling combinator', () => {
    assert.equal(parse('.a ~ .b{x:1}'), `.a ~ .b${A}{x:1}`)
  })

  test('multi-level descendant scopes only the last part', () => {
    assert.equal(parse('.a .b .c{x:1}'), `.a .b .c${A}{x:1}`)
  })
})

// 伪类与伪元素
describe('pseudo classes and elements', () => {
  test('pseudo class stays after scope attribute', () => {
    assert.equal(parse('.btn:hover{x:1}'), `.btn${A}:hover{x:1}`)
  })

  test('chained pseudo classes', () => {
    assert.equal(parse('.btn:active:focus{x:1}'), `.btn${A}:active:focus{x:1}`)
  })

  test('functional pseudo class', () => {
    assert.equal(parse('.item:nth-child(2n){x:1}'), `.item${A}:nth-child(2n){x:1}`)
  })

  test('tag with functional pseudo and hover', () => {
    assert.equal(parse('li:nth-child(odd):hover{x:1}'), `li${A}:nth-child(odd):hover{x:1}`)
  })

  test('pseudo element stays after scope attribute', () => {
    assert.equal(parse('.item::before{content:"x"}'), `.item${A}::before{content:"x"}`)
  })

  test('tag with pseudo element', () => {
    assert.equal(parse('input::placeholder{x:1}'), `input${A}::placeholder{x:1}`)
  })

  // 当前行为锁定：伪类与后代组合时，伪类分支优先生效，
  // 后代段 .b 不会追加作用域属性（近似穿透），编写样式时应注意
  test('pseudo class followed by descendant keeps descendant unscoped', () => {
    assert.equal(parse('.a:hover .b{x:1}'), `.a${A}:hover .b{x:1}`)
  })
})

// @media / @supports 递归处理
describe('at-rules: media / supports', () => {
  test('@media inner rules are scoped', () => {
    assert.equal(
      parse('@media (max-width:768px){.a{x:1}}'),
      `@media (max-width:768px){.a${A}{x:1}}`,
    )
  })

  test('@media inner host piercing rule', () => {
    assert.equal(
      parse('@media (max-width:768px){body .a{x:1}}'),
      `@media (max-width:768px){${B} .a{x:1}}`,
    )
  })

  test('@media multiple inner rules', () => {
    assert.equal(
      parse('@media (max-width:768px){.a{x:1}.b{y:2}}'),
      `@media (max-width:768px){.a${A}{x:1}.b${A}{y:2}}`,
    )
  })

  test('@supports inner rules are scoped', () => {
    assert.equal(
      parse('@supports (display:grid){.a{display:grid}}'),
      `@supports (display:grid){.a${A}{display:grid}}`,
    )
  })

  test('@font-face passes through untouched', () => {
    const css = '@font-face{font-family:"X";src:url(x.woff2)}'
    assert.equal(parse(css), css)
  })
})

// @keyframes 重命名与 animation 引用替换
describe('keyframes renaming', () => {
  test('@keyframes declaration gets suffix', () => {
    assert.equal(
      parse('@keyframes slideIn{from{opacity:0}to{opacity:1}}'),
      `@keyframes slideIn-${SUFFIX}{from{opacity:0}to{opacity:1}}`,
    )
  })

  test('keyframes inner blocks are not scoped', () => {
    assert.equal(
      parse('@keyframes a{from{color:red}50%{color:blue}to{color:green}}'),
      `@keyframes a-${SUFFIX}{from{color:red}50%{color:blue}to{color:green}}`,
    )
  })

  test('suffix strips non-alphanumeric chars from scope', () => {
    assert.equal(
      parse('@keyframes a{from{x:1}}', '/layout/header'),
      '@keyframes a-layoutheader{from{x:1}}',
    )
  })

  test('animation shorthand reference is renamed', () => {
    assert.equal(
      parse('@keyframes slideIn{from{opacity:0}}\n.a{animation:slideIn 0.5s infinite alternate;}'),
      `@keyframes slideIn-${SUFFIX}{from{opacity:0}}\n.a${A}{animation: slideIn-${SUFFIX} 0.5s infinite alternate;}`,
    )
  })

  test('animation with name after time/keyword/iteration-count', () => {
    assert.equal(
      parse('@keyframes slideIn{from{x:1}}.a{animation:0.5s linear 2 slideIn;}'),
      `@keyframes slideIn-${SUFFIX}{from{x:1}}.a${A}{animation: 0.5s linear 2 slideIn-${SUFFIX};}`,
    )
  })

  test('animation with cubic-bezier keeps bezier intact', () => {
    assert.equal(
      parse('@keyframes slideIn{from{x:1}}.a{animation:slideIn 0.5s cubic-bezier(0.1,0.7,1.0,0.1) infinite;}'),
      `@keyframes slideIn-${SUFFIX}{from{x:1}}.a${A}{animation: slideIn-${SUFFIX} 0.5s cubic-bezier(0.1,0.7,1.0,0.1) infinite;}`,
    )
  })

  // 括号感知的值分词：bezier 内含空格保持单 token，其后的动画名仍能命中
  test('animation name after spaced cubic-bezier is renamed', () => {
    assert.equal(
      parse('@keyframes slideIn{from{x:1}}.a{animation:0.5s cubic-bezier(0.1, 0.7, 1.0, 0.1) slideIn;}'),
      `@keyframes slideIn-${SUFFIX}{from{x:1}}.a${A}{animation: 0.5s cubic-bezier(0.1, 0.7, 1.0, 0.1) slideIn-${SUFFIX};}`,
    )
  })

  test('animation with steps timing function', () => {
    assert.equal(
      parse('@keyframes a{from{x:1}}.b{animation:steps(4, jump-start) 1s a;}'),
      `@keyframes a-${SUFFIX}{from{x:1}}.b${A}{animation: steps(4, jump-start) 1s a-${SUFFIX};}`,
    )
  })

  test('animation with !important keeps the flag', () => {
    assert.equal(
      parse('@keyframes a{from{x:1}}.b{animation:a 1s !important;}'),
      `@keyframes a-${SUFFIX}{from{x:1}}.b${A}{animation: a-${SUFFIX} 1s !important;}`,
    )
  })

  // 末位声明可以没有分号，动画名照常替换
  test('last animation declaration without semicolon is renamed', () => {
    assert.equal(
      parse('@keyframes a{from{x:1}}.b{animation:a 1s}'),
      `@keyframes a-${SUFFIX}{from{x:1}}.b${A}{animation: a-${SUFFIX} 1s}`,
    )
  })

  test('multiple animations in one shorthand', () => {
    assert.equal(
      parse('@keyframes fadeIn{from{x:1}}@keyframes slideUp{from{y:2}}.a{animation:fadeIn 1s, slideUp 2s;}'),
      `@keyframes fadeIn-${SUFFIX}{from{x:1}}@keyframes slideUp-${SUFFIX}{from{y:2}}.a${A}{animation: fadeIn-${SUFFIX} 1s, slideUp-${SUFFIX} 2s;}`,
    )
  })

  test('animation-name list is renamed', () => {
    assert.equal(
      parse('@keyframes fadeIn{from{x:1}}@keyframes slideUp{from{y:2}}.a{animation-name:fadeIn,slideUp;}'),
      `@keyframes fadeIn-${SUFFIX}{from{x:1}}@keyframes slideUp-${SUFFIX}{from{y:2}}.a${A}{animation-name: fadeIn-${SUFFIX}, slideUp-${SUFFIX};}`,
    )
  })

  // 未在同一样表中声明的动画名不替换；注意 animation 属性仍会被统一补空格规范化
  test('undeclared animation name is not renamed', () => {
    assert.equal(
      parse('.a{animation:external 1s;}'),
      `.a${A}{animation: external 1s;}`,
    )
  })

  // keyframes 映射在每次 parse 时清空，跨样表不泄漏
  test('keyframes map does not leak across parse calls', () => {
    parse('@keyframes once{from{x:1}}')
    assert.equal(
      parse('.a{animation:once 1s;}'),
      `.a${A}{animation: once 1s;}`,
    )
  })

  test('@keyframes inside @media is renamed and referenced', () => {
    assert.equal(
      parse('@media (max-width:768px){@keyframes m{from{x:1}}}.a{animation:m 1s;}'),
      `@media (max-width:768px){@keyframes m-${SUFFIX}{from{x:1}}}.a${A}{animation: m-${SUFFIX} 1s;}`,
    )
  })
})

// 注释处理
describe('comments', () => {
  test('leading comment is removed', () => {
    assert.equal(parse('/* c */.a{x:1}'), `.a${A}{x:1}`)
  })

  test('trailing comment is removed', () => {
    assert.equal(parse('.a{x:1}/* c */'), `.a${A}{x:1}`)
  })

  test('comment between rules is removed', () => {
    assert.equal(parse('.a{x:1}/* c */.b{y:2}'), `.a${A}{x:1}.b${A}{y:2}`)
  })

  test('comment inside rule body is removed', () => {
    assert.equal(parse('.a{x:1/* c */}'), `.a${A}{x:1}`)
  })

  test('multi-line comment is removed', () => {
    assert.equal(parse('/* line1\nline2 */.a{x:1}'), `.a${A}{x:1}`)
  })
})

// 健壮性：字符串字面量与无块 @规则
describe('robustness', () => {
  test('brace inside string does not break block matching', () => {
    assert.equal(parse('.a{content:"}"}'), `.a${A}{content:"}"}`)
  })

  test('comment sequence inside string is preserved', () => {
    assert.equal(parse('.a{content:"/* */"}'), `.a${A}{content:"/* */"}`)
  })

  test('@import passes through untouched', () => {
    assert.equal(parse('@import "x.css";\n.a{x:1}'), `@import "x.css";\n.a${A}{x:1}`)
  })
})
