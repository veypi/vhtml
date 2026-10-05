import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ModuleResources } from '../src/resource.js'
import { RenderPolicy } from '../src/execution/render-policy.js'

function policy() {
  const calls = []
  const resources = new ModuleResources(
    { origin: 'https://app.test', scoped: '/modules/demo', unsafe: true },
    {
      fetch: async (url, init) => {
        calls.push({ url, init })
        return new Response(new Uint8Array([1, 2, 3]), {
          headers: { 'Content-Type': 'image/png' },
        })
      },
    }
  )
  return { calls, render: new RenderPolicy(resources) }
}

test('HTML is parsed without browser side effects and resource attributes stay inert', async () => {
  const { calls, render } = policy()
  try {
    const html = await render.html(
      '<img src="/assets/a.png"><button @click="count++">go</button>'
    )
    assert.match(html, /:src=/)
    assert.doesNotMatch(html, /\ssrc=/)
    assert.equal(calls.length, 0)
    for (const html of [
      '<iframe src="/outside"></iframe>',
      '<svg onload="alert(1)"></svg>',
      '<img onerror="alert(1)">',
      '<div :srcdoc="html"></div>',
      '<x-node unsafe></x-node>',
    ])
      await assert.rejects(render.html(html), /unavailable|header/)
    assert.equal(calls.length, 0)
  } finally {
    render.dispose()
  }
})

test('CSS and DOM assets use one controlled fetch and reject automatic external loading', async () => {
  const { calls, render } = policy()
  try {
    const [url, style] = await Promise.all([
      render.asset('/assets/a.png'),
      render.style('background:url(/assets/a.png)', { declaration: true }),
    ])
    assert.match(url, /^blob:/)
    assert(style.includes(url))
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, 'https://app.test/modules/demo/assets/a.png')
    assert.equal(calls[0].init.redirect, 'error')
    await assert.rejects(render.style('@import "/a.css";'), /unavailable/)
    await assert.rejects(
      render.style('background:url(https://elsewhere.test/image)', {
        declaration: true,
      }),
      /outside/
    )
    await assert.rejects(
      render.style('background:image-set("https://elsewhere.test/image" 1x)', {
        declaration: true,
      }),
      /sandbox CSS/
    )
    assert.equal(calls.length, 1)
  } finally {
    render.dispose()
  }
})

test('CSS target constraints also cover siblings and pseudo-elements without changing keyframes', () => {
  const { render } = policy()
  try {
    const result = render.scopeStyles(
      'body + div::before{content:"x"}@keyframes spin{from{opacity:0}to{opacity:1}}',
      'module'
    )
    assert.match(
      result,
      /div:where\(\[vref="module"\],\[vref="module"\] \*\)::before/
    )
    assert.match(result, /@keyframes spin\{from\{opacity:0\}to\{opacity:1\}\}/)
  } finally {
    render.dispose()
  }
})

test('SVG markup and styles isolate fragment references and preserve framework bindings', async () => {
  const a = policy(),
    b = policy()
  try {
    const html = await a.render.html(
      '<svg ref="plot" viewBox="0 0 20 20"><defs><clipPath id="clip"><rect width="10" height="10"/></clipPath></defs><path :d="path" clip-path="url(#clip)"/><image href="/assets/p.png"/></svg>'
    )
    assert.match(html, /ref="plot"/)
    assert.match(html, /viewBox="0 0 20 20"/)
    assert.match(html, /:d="path"/)
    assert.match(html, /:href=/)
    assert.doesNotMatch(html, /<image href=/)
    const id = a.render.svg.id('clip')
    assert.ok(html.includes(id))
    assert.notEqual(id, b.render.svg.id('clip'))
    const style = a.render.scopeStyles(
      await a.render.style('#clip{fill:url(#clip)}'),
      'module'
    )
    assert.ok(style.includes(`:is(#clip,#${id})`))
    assert.ok(style.includes(`url(#${id})`))
    assert.equal(a.calls.length, 0)
    for (const html of [
      '<svg><use href="https://evil.test/x.svg#x"/></svg>',
      '<svg><path fill="url(/other.svg#x)"/></svg>',
      '<svg><foreignObject><div/></foreignObject></svg>',
      '<svg><set attributeName="href" to="/outside"/></svg>',
      '<svg><script>1</script></svg>',
    ])
      await assert.rejects(
        a.render.html(html),
        /unavailable|inside this module/
      )
  } finally {
    a.render.dispose()
    b.render.dispose()
  }
})

test('static templates and dynamic markup share the element and attribute policy', async () => {
  const { render, calls } = policy()
  try {
    for (const source of [
      '<link rel="preload" as="image" imagesrcset="/outside.png 1x">',
      '<body><link rel="stylesheet" href="/outside.css"></body>',
      '<head><link rel="stylesheet" href="/theme.css" imagesrcset="/outside.png"></head>',
      '<div popovertarget="host">native action</div>',
      '<marquee>unsupported native element</marquee>',
      '<div><script no-vhtml>1</script></div>',
    ])
      await assert.rejects(
        render.html(source),
        /unavailable|provided|stylesheets/
      )
    assert.equal(calls.length, 0)
    const html = await render.html(
      '<head><link rel="stylesheet" href="/theme.css"><script src="/vendor/chart.js"></script></head><body><chart-view :option="option" custom-prop="x"></chart-view><div vsrc="child" :items="items"><span vslot="header">header</span></div><vslot name="header" vbind="item"></vslot><vrouter history="memory" initial="/home" routes="./routes.js"></vrouter></body>'
    )
    assert.match(html, /data-vhtml-href="\/theme.css"/)
    assert.match(html, /data-vhtml-src="\/vendor\/chart.js"/)
    assert.match(html, /:option="option"/)
    assert.match(html, /custom-prop="x"/)
    assert.doesNotThrow(() => render.checkElement('canvas'))
    assert.throws(() => render.checkElement('script'), /unavailable/)
  } finally {
    render.dispose()
  }
})
