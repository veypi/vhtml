import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mount, flush, loadSrc } from './harness.js'

await loadSrc()
const { handleStyle } = await import('../src/compiler-attrs.js')

test('equivalent text/class/style results produce zero DOM mutations', async () => {
  const { app, host } = await mount(`<p class="static" :class="n ? ['hot', {on:true}] : 'on hot'" :style="n ? {color:'red', '--x':'1'} : '--x:1;color:red'"> {{n ? 'same' : 'same'}}:{{tail}} </p>`, { n: 0, tail: 'x' })
  const p = host.firstChild
  const mutations = []
  const observer = new MutationObserver(records => mutations.push(...records))
  observer.observe(p, { subtree: true, characterData: true, attributes: true, childList: true })
  app._data.n = 1
  await flush()
  assert.equal(mutations.length, 0)
  assert.equal(p.textContent, ' same:x ')
  app._data.tail = 'y'
  await flush()
  assert.equal(mutations.length, 1)
  assert.equal(p.textContent, ' same:y ')
  observer.disconnect()
  app.destroy(); host.remove()
})

test('class token differences preserve static classes and track object mutation', async () => {
  // happy-dom 20 的 :class / class 同名 localName 索引有缺陷，删 :class 后
  // getAttribute('class') 会返回旧 Attr。这里直接安装绑定；完整模板另在浏览器验证。
  const { app, host } = await mount('<b class="base"></b>', { classes: { base: true, active: true } })
  const b = host.firstChild
  handleStyle(b, 'class', 'classes', app._data, app._runtime)
  app._data.classes.active = false
  app._data.classes.base = false
  await flush()
  assert.equal(b.className, 'base')
  app._data.classes.new = true
  await flush()
  assert.equal(b.className, 'base new')
  app.destroy(); host.remove()
})

test('style diff handles deleted keys, CSS variables, camelCase, priority and string/object switches', async () => {
  const { app, host } = await mount('<b style="display:block"></b>', {
    styles: { color: 'red', fontSize: '12px', '--x': 'a', margin: '1px', marginLeft: '2px' },
  })
  const b = host.firstChild
  handleStyle(b, 'style', 'styles', app._data, app._runtime)
  delete app._data.styles.color
  app._data.styles.fontSize = '14px'
  app._data.styles['--x'] = 'b'
  await flush()
  assert.equal(b.style.color, '')
  assert.equal(b.style.fontSize, '14px')
  assert.equal(b.style.getPropertyValue('--x'), 'b')
  // 含分号的字符串由真实浏览器 fixture 覆盖；happy-dom 的 CSS 解析器会截断。
  app._data.styles = 'margin-left:2px;color:blue!important;--raw:"a:b"'
  await flush()
  assert.equal(b.style.fontSize, '')
  assert.equal(b.style.getPropertyValue('--x'), '')
  assert.equal(b.style.marginLeft, '2px')
  assert.equal(b.style.color, 'blue')
  assert.equal(b.style.getPropertyPriority('color'), 'important')
  assert.equal(b.style.getPropertyValue('--raw'), '"a:b"')
  assert.equal(b.style.display, 'block')
  app._data.styles = null
  await flush()
  assert.equal(b.style.color, '')
  assert.equal(b.style.display, 'block')
  app.destroy(); host.remove()
})

test('literal whitespace and preformatted interpolation survive updates', async () => {
  const { app, host } = await mount('<span>hello </span><b>{{name}}</b><pre>  {{name}}\n  next\n</pre>', { name: 'world' })
  assert.equal(host.firstChild.textContent, 'hello ')
  assert.equal(host.querySelector('pre').textContent, '  world\n  next\n')
  app._data.name = 'vhtml'
  await flush()
  assert.equal(host.querySelector('pre').textContent, '  vhtml\n  next\n')
  app.destroy(); host.remove()
})
