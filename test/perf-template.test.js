import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadSrc, mount, flush } from './harness.js'

await loadSrc()
const { normalizeTemplate } = await import('../src/template-normalize.js')
const { templateLoader } = await import('../src/loader.js')
const comments = root => {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_COMMENT)
  const values = []
  while (walker.nextNode()) values.push(walker.currentNode.nodeValue)
  return values
}

test('template comments disappear before list cloning; anchors and explicit boundaries survive', async () => {
  const { app, host } = await mount('<template v-for="i in 100"><!-- developer --><b>{{i}}</b><!-- vhtml:keep boundary --></template>', {})
  const values = comments(host)
  assert.equal(values.filter(v => v.includes('developer')).length, 0)
  assert.equal(values.filter(v => v.includes('vhtml:keep')).length, 100)
  assert.ok(values.some(v => v.includes('vfor')))
  assert.equal(host.querySelectorAll('b').length, 100)
  app.destroy(); host.remove()
})

test('cached descriptors are normalized through nested template.content', async () => {
  const mod = await templateLoader.getModule('')
  const descriptor = await templateLoader.parser.parse('<body><template><!-- a --><template><!-- b --><b>x</b></template></template></body>', mod, '/normalized')
  const first = descriptor.body.querySelector('template')
  assert.equal(first.content.firstChild.nodeName, 'TEMPLATE')
  assert.equal(first.content.firstChild.content.firstChild.nodeName, 'B')
})

test('whitespace is opt-in; preserve, code, inline spaces and foreign content keep their nodes', () => {
  const root = document.createElement('div')
  root.innerHTML = `<section v-whitespace="compact">\n<b>a</b> <b>b</b>\n<pre>  x\n  y\n</pre><code>  z  </code><textarea>  q\n z</textarea><div style="white-space:pre-wrap">\n  \n</div><p v-whitespace="preserve">\n  \n</p><div no-vhtml><!-- external -->\n</div><div v-html="html"><!-- raw --></div><svg><!-- svg --><text> a </text></svg></section><aside>\n<b>x</b>\n</aside>`
  normalizeTemplate(root)
  const section = root.firstChild
  assert.equal(section.firstChild.nodeName, 'B')
  assert.equal(section.childNodes[1].nodeValue, ' ')
  assert.equal(root.querySelector('pre').textContent, '  x\n  y\n')
  assert.equal(root.querySelector('code').textContent, '  z  ')
  assert.equal(root.querySelector('textarea').textContent, '  q\n z')
  assert.equal(root.querySelector('[style]').textContent, '\n  \n')
  assert.equal(root.querySelector('p').textContent, '\n  \n')
  assert.deepEqual(comments(root), [' external ', ' raw ', ' svg '])
  assert.equal(root.querySelector('aside').firstChild.nodeValue, '\n')
})

test('empty v-if keeps only anchors across repeated branch switches', async () => {
  const { app, host } = await mount('<span v-if="show" ref="value">{{msg}}</span>', { show: true, msg: 'ok' })
  for (let i = 0; i < 3; i++) {
    app._data.show = false
    await flush()
    assert.equal(host.children.length, 0)
    assert.equal(host.childNodes.length, 2)
    assert.equal(app._data.$refs.value, null)
    app._data.show = true
    await flush()
    assert.equal(host.textContent, 'ok')
    assert.equal(host.children.length, 1)
  }
  app.destroy(); host.remove()
})

test('parseDom on a compiled list preserves row anchors and list updates', async () => {
  const { app, host } = await mount('<template v-for="n in items"><b>{{n}}</b></template>', { items: [1, 2] })
  const before = comments(host)
  app.parseDom(host, app._data)
  assert.deepEqual(comments(host), before)
  app._data.items.splice(0, 1)
  await flush()
  assert.equal(host.textContent, '2')
  app.destroy(); host.remove()
})
