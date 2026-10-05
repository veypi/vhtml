import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setupDom } from './harness.js'
setupDom()
const { ModuleResources } = await import('../src/resource.js')
const { ModuleExecutor } = await import('../src/execution/module-executor.js')

async function fixture(tagName = 'div') {
  const requests = [],
    cleanups = [],
    errors = []
  const resources = new ModuleResources(
    { origin: 'http://localhost', scoped: '/modules/demo', unsafe: true },
    {
      fetch: async (url) => {
        requests.push(url)
        return new Response(new Uint8Array([1]), {
          headers: { 'Content-Type': 'image/png' },
        })
      },
    }
  )
  const execution = await ModuleExecutor.create(resources)
  execution.engine.onError = (error) => errors.push(error)
  const host = document.createElement(tagName)
  host.innerHTML = '<div id="inside"></div>'
  document.body.append(host)
  const outsider = document.createElement('div')
  outsider.id = 'outside'
  document.body.append(outsider)
  const scope = {
    addCleanup: (callback) => cleanups.push(callback),
    onMount: (callback) => callback(),
    onActive() {},
    onDeactive() {},
    onDispose() {},
  }
  const runtime = { $sys: {}, $mod: execution.mod },
    data = execution.createData(host, scope, runtime)
  return {
    execution,
    host,
    outsider,
    requests,
    errors,
    run: (code) => execution.execute(code, data, runtime),
    read: (code) => execution.evaluate(code, data, runtime),
    dispose() {
      for (const fn of cleanups) fn()
      execution.dispose()
      host.remove()
      outsider.remove()
    },
  }
}

test('standard node creation, styles, insertion and virtual ownerDocument keep module boundaries', async () => {
  const f = await fixture('chart-fixture')
  try {
    await f.run(
      `const child=document.createElement('div');child.id='created';child.style.width='120px';child.style.setProperty('height','32px');child.innerHTML='<b class="label">hello</b>'; $node.appendChild(child); created=child;`
    )
    assert.equal(f.host.querySelector('#created').style.width, '120px')
    assert.equal(f.host.querySelector('.label').textContent, 'hello')
    assert.equal(
      f.read('created instanceof HTMLElement && created instanceof Node'),
      true
    )
    assert.equal(
      f.read(
        'created.ownerDocument.defaultView === window && document === $node.ownerDocument'
      ),
      true
    )
    assert.equal(f.read("document.querySelector('#outside')"), null)
    assert.equal(f.read('$node.parentNode'), null)
    assert.equal(
      f.read(
        "created.constructor.constructor('return document')() === document"
      ),
      true
    )
    await f.run(
      `created.remove();$node.appendChild(created);created.classList.add('one','two');created.classList.remove('one')`
    )
    assert.equal(f.host.querySelector('#created').className, 'two')
    await assert.rejects(f.run('$node.appendChild($node)'), /roots/)
    for (const html of [
      '<img onerror="alert(1)">',
      '<script>1</script>',
      '<iframe src="/x"></iframe>',
      '<svg><foreignObject></foreignObject></svg>',
      '<div :onclick="1"></div>',
    ])
      await assert.rejects(
        f.run('created.innerHTML=' + JSON.stringify(html)),
        /unavailable|provided|namespace/
      )
    assert.equal(f.outsider.innerHTML, '')
  } finally {
    f.dispose()
  }
})

test('programmatic resource properties and CSS use the shared resolver; native objects never cross callbacks', async () => {
  const f = await fixture()
  try {
    await f.run(
      `image=new Image();$node.appendChild(image);image.src='/assets/a.png'; clicked=0;handler=function(e){clicked++;identity=(this===image && e.target===image && e.target.ownerDocument.defaultView===window)};image.addEventListener('click',handler)`
    )
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.match(f.host.querySelector('img').src, /^blob:/)
    f.host.querySelector('img').dispatchEvent(new Event('click'))
    assert.equal(f.read('identity'), true)
    await f.run(`image.removeEventListener('click',handler)`)
    f.host.querySelector('img').dispatchEvent(new Event('click'))
    assert.equal(f.read('clicked'), 1)
    assert.equal(f.requests[0], 'http://localhost/modules/demo/assets/a.png')
    await assert.rejects(f.run("image.src='@/secret'"), /forbidden/)
    await f.run(`image.style.backgroundImage='url(/../secret)'`)
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(f.requests.length, 1)
    assert.equal(f.errors.length, 1)
  } finally {
    f.dispose()
  }
})

test('canvas bridge copies measurements and supports gradients without exposing native canvas', async () => {
  const f = await fixture(),
    calls = []
  try {
    await f.run(
      `canvas=document.createElement('canvas');$node.appendChild(canvas)`
    )
    const nativeCanvas = f.host.querySelector('canvas')
    const gradient = {
      addColorStop: (...args) => calls.push(['stop', ...args]),
    }
    nativeCanvas.getContext = () => ({
      measureText: (text) => ({ width: text.length * 8 }),
      createLinearGradient: () => gradient,
      fillRect: (...args) => calls.push(['rect', ...args]),
      fillStyle: '#000',
    })
    await f.run(
      `context=canvas.getContext('2d');gradient=context.createLinearGradient(0,0,1,1);gradient.addColorStop(0,'red');context.fillStyle=gradient;context.fillRect(0,0,10,10);width=context.measureText('hi').width`
    )
    assert.equal(f.read('width'), 16)
    assert.equal(
      f.read(
        'context.canvas === canvas && context.canvas.ownerDocument.defaultView === window'
      ),
      true
    )
    assert.equal(
      f.read("context.measureText.constructor('return window')() === window"),
      true
    )
    assert.deepEqual(calls, [
      ['stop', 0, 'red'],
      ['rect', 0, 0, 10, 10],
    ])
    await assert.rejects(f.run('canvas.width=50000'), /limit/)
    await assert.rejects(
      f.run("canvas.setAttribute('height','50000')"),
      /limit/
    )
    await assert.rejects(f.run("context.filter='url(/outside)'"), /unavailable/)
  } finally {
    f.dispose()
  }
})

test('module MutationObserver only reports owned DOM and disconnects explicitly', async () => {
  const f = await fixture()
  try {
    await f.run(
      `mutations=[]; observer=new MutationObserver(entries=>{for(const entry of entries)mutations.push([entry.target.ownerDocument===document,entry.target.id])});observer.observe(document,{attributes:true,subtree:true})`
    )
    f.outsider.setAttribute('title', 'private')
    f.host.querySelector('#inside').setAttribute('title', 'local')
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.deepEqual(JSON.parse(f.read('JSON.stringify(mutations)')), [
      [true, 'inside'],
    ])
    await f.run('observer.disconnect()')
    f.host.querySelector('#inside').setAttribute('title', 'later')
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(f.read('mutations.length'), 1)
  } finally {
    f.dispose()
  }
})

test('guest cleanup can still use DOM before framework handles are released', async () => {
  const f = await fixture()
  await f.run(
    `$scope.addCleanup(()=>{$node.innerHTML='';$node.setAttribute('data-disposed','yes')})`
  )
  f.dispose()
  assert.equal(f.host.getAttribute('data-disposed'), 'yes')
  assert.equal(f.host.innerHTML, '')
  assert.equal(f.errors.length, 0)
})

test('external libraries execute once per module, including concurrent requests', async () => {
  let calls = 0
  const resources = new ModuleResources(
    { origin: 'http://localhost', scoped: '/modules/demo', unsafe: true },
    {
      fetch: async () => {
        calls++
        return new Response(
          'globalThis.libraryLoads=(globalThis.libraryLoads||0)+1'
        )
      },
    }
  )
  const execution = await ModuleExecutor.create(resources)
  try {
    await Promise.all([
      execution.externalScript('/vendor/lib.js'),
      execution.externalScript('/vendor/lib.js'),
    ])
    await execution.externalScript('/vendor/lib.js')
    assert.equal(calls, 1)
    assert.equal(
      execution.engine.evaluate(
        'globalThis.libraryLoads',
        execution.engine.createScope()
      ),
      1
    )
    assert.equal(globalThis.libraryLoads, undefined)
  } finally {
    execution.dispose()
  }
})

test('window resize is copied and cannot cancel host event listeners', async () => {
  const f = await fixture()
  let nativeCalls = 0
  const listener = () => nativeCalls++
  try {
    await f.run(
      `resizeCount=0;handler=function(event){resizeCount++;resizeIdentity=(this===window && event.target===window);event.stopImmediatePropagation()};window.addEventListener('resize',handler)`
    )
    window.addEventListener('resize', listener)
    window.dispatchEvent(new window.Event('resize'))
    assert.equal(f.read('resizeCount'), 1)
    assert.equal(f.read('resizeIdentity'), true)
    assert.equal(nativeCalls, 1)
    await f.run(`window.removeEventListener('resize',handler)`)
    window.dispatchEvent(new window.Event('resize'))
    assert.equal(f.read('resizeCount'), 1)
  } finally {
    window.removeEventListener('resize', listener)
    f.dispose()
  }
})

test('SVG ids, paint references, namespaces and selectors remain module-local', async () => {
  const f = await fixture()
  try {
    await f.run(
      `svg=document.createElementNS('http://www.w3.org/2000/svg','svg');$node.appendChild(svg);svg.innerHTML='<defs><linearGradient id="paint"><stop offset="0%" stop-color="red"/></linearGradient><path id="shape" d="M0 0L20 20"/></defs><rect width="20" height="20" fill="url(#paint)"/><use href="#shape"/>';svg.setAttribute('viewBox','0 0 20 20');`
    )
    const native = f.host.querySelector('svg'),
      paint = native.querySelector('linearGradient')
    assert.match(paint.id, /^vhtml-svg-/)
    assert.notEqual(paint.id, 'paint')
    assert.equal(native.getAttribute('viewBox'), '0 0 20 20')
    assert.ok(
      native.querySelector('rect').getAttribute('fill').includes(paint.id)
    )
    assert.equal(f.read("svg.querySelector('#paint').id"), 'paint')
    assert.equal(f.read("svg.querySelector('#paint').matches('#paint')"), true)
    assert.equal(
      f.read(
        'svg instanceof SVGSVGElement && svg.ownerDocument.defaultView===window'
      ),
      true
    )
    await f.run(
      `svg.querySelector('use').setAttributeNS('http://www.w3.org/1999/xlink','xlink:href','#shape')`
    )
    assert.equal(
      native
        .querySelector('use')
        .getAttributeNS('http://www.w3.org/1999/xlink', 'href'),
      '#' + native.querySelector('path').id
    )
    for (const code of [
      `svg.querySelector('use').setAttribute('href','/outside.svg#shape')`,
      `svg.querySelector('rect').setAttribute('fill','url(https://outside.test/a.svg#x)')`,
      `document.createElementNS('http://www.w3.org/2000/svg','foreignObject')`,
      `document.createElementNS('http://www.w3.org/2000/svg','animate')`,
      `svg.innerHTML='<script>1</script>'`,
    ])
      await assert.rejects(f.run(code), /unavailable|inside this module/)
    await f.run(`svg.querySelector('use').setAttribute('href','#outside')`)
    assert.notEqual(
      native.querySelector('use').getAttribute('href'),
      '#outside'
    )
    assert.equal(f.requests.length, 0)
  } finally {
    f.dispose()
  }
})

test('WebGL copies binary transfers and retains native objects behind context-owned handles', async () => {
  const f = await fixture(),
    calls = []
  class WebGLBuffer {}
  const gl = {
    ARRAY_BUFFER: 34962,
    ARRAY_BUFFER_BINDING: 34964,
    BUFFER_SIZE: 34660,
    RGBA: 6408,
    UNSIGNED_BYTE: 5121,
    STATIC_DRAW: 35044,
    createBuffer() {
      return new WebGLBuffer()
    },
    bindBuffer(target, buffer) {
      this.bound = buffer
      calls.push(['bind', buffer])
    },
    bufferData(target, data) {
      calls.push(['data', data])
      this.size = typeof data === 'number' ? data : data.byteLength
    },
    getParameter() {
      return this.bound
    },
    getBufferParameter() {
      return this.size
    },
    readPixels(x, y, w, h, format, type, data) {
      data.set([11, 22, 33, 255])
    },
    copyTexImage2D() {
      calls.push(['copyTexture'])
    },
    deleteBuffer(buffer) {
      calls.push(['delete', buffer])
      this.bound = null
    },
    getExtension() {
      return {
        loseContext() {
          calls.push(['lost'])
        },
      }
    },
  }
  try {
    await f.run(
      `canvas=document.createElement('canvas');other=document.createElement('canvas');$node.append(canvas,other)`
    )
    for (const canvas of f.host.querySelectorAll('canvas'))
      canvas.getContext = () => gl
    await f.run(
      `gl=canvas.getContext('webgl2');buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([1,2,3]),gl.STATIC_DRAW);pixel=new Uint8Array(4);gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel)`
    )
    assert.equal(
      f.read(
        `gl instanceof WebGL2RenderingContext && buffer instanceof WebGLBuffer && gl.canvas===canvas`
      ),
      true
    )
    assert.equal(
      f.read(`buffer.constructor.constructor('return globalThis')()===window`),
      true
    )
    assert.equal(
      f.read('gl.getParameter(gl.ARRAY_BUFFER_BINDING)===buffer'),
      true
    )
    assert.equal(f.read('JSON.stringify(Array.from(pixel))'), '[11,22,33,255]')
    assert.deepEqual(
      Array.from(calls.find(([name]) => name === 'data')[1]),
      [1, 2, 3]
    )
    await assert.rejects(
      f.run('other.getContext("webgl2").bindBuffer(gl.ARRAY_BUFFER,buffer)'),
      /Foreign/
    )
    await assert.rejects(
      f.run('gl.bufferData(gl.ARRAY_BUFFER,70*1024*1024,gl.STATIC_DRAW)'),
      /limit/
    )
    await assert.rejects(
      f.run('gl.copyTexImage2D(3553,0,6408,0,0,50000,100,0)'),
      /limit/
    )
    assert.equal(calls.filter(([name]) => name === 'data').length, 1)
    assert.equal(calls.filter(([name]) => name === 'copyTexture').length, 0)
    await f.run('gl.deleteBuffer(buffer)')
    await assert.rejects(
      f.run('gl.bindBuffer(gl.ARRAY_BUFFER,buffer)'),
      /deleted/
    )
  } finally {
    f.dispose()
  }
  assert.equal(calls.filter(([name]) => name === 'lost').length, 2)
})

test('real utility and DOM libraries run inside the isolated realm', async () => {
  const { readFile } = await import('node:fs/promises')
  const { vendors, cases } = await import('../scripts/library-suite.mjs')
  for (const name of ['lodash', 'dayjs', 'marked', 'jquery', 'd3']) {
    const f = await fixture()
    try {
      for (const file of cases[name].scripts)
        await f.execution.script(
          await readFile(
            new URL('../node_modules/' + vendors[file], import.meta.url),
            'utf8'
          )
        )
      await f.run(
        `const assert=(value,message)=>{if(!value)throw new Error(${JSON.stringify(name + ': ')}+message)};${cases[name].code}`
      )
      assert.equal(f.read('typeof window.__hostSecret'), 'undefined')
      assert.equal(f.errors.length, 0, name)
    } finally {
      f.dispose()
    }
  }
})

test('libraries can clone rendered template nodes without replaying compiler metadata', async () => {
  const f = await fixture()
  try {
    const source = f.host.querySelector('#inside')
    source.setAttribute('vrefof', '/modules/demo/page')
    source.setAttribute('vslot', 'header')
    source.innerHTML = '<span>template</span>'
    await f.run(
      `copy=$node.querySelector('#inside').cloneNode(true);copy.id='copy';$node.appendChild(copy)`
    )
    const copy = f.host.querySelector('#copy')
    assert.equal(copy.textContent, 'template')
    assert.equal(copy.getAttribute('vrefof'), '/modules/demo/page')
    assert.equal(copy.hasAttribute('vslot'), false)
  } finally {
    f.dispose()
  }
})
