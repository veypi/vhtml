import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setupDom } from './harness.js'
setupDom()
const { ModuleResources } = await import('../src/resource.js')
const { ModuleExecutor } = await import('../src/execution/module-executor.js')
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

async function fixture(
  fetch = async () => new Response(null, { status: 204 })
) {
  const resources = new ModuleResources(
    { origin: 'http://localhost', scoped: '/modules/demo', unsafe: true },
    { fetch }
  )
  const execution = await ModuleExecutor.create(resources)
  const host = document.createElement('div')
  document.body.append(host)
  const errors = []
  execution.engine.onError = (error) => errors.push(error)
  const cleanups = []
  const scope = { addCleanup: (fn) => cleanups.push(fn), phase: 'mounted' }
  const runtime = { $sys: {}, $mod: execution.mod }
  const data = execution.createData(host, scope, runtime)
  const disposeComponent = () => {
    scope.phase = 'disposed'
    cleanups.splice(0).forEach((fn) => fn())
  }
  return {
    execution,
    host,
    errors,
    resources,
    disposeComponent,
    run: (code) => execution.execute(code, data, runtime),
    read: (code) => execution.evaluate(code, data, runtime),
    dispose() {
      disposeComponent()
      execution.dispose()
      host.remove()
    },
  }
}

test('temporary DOM nodes are reclaimed without invalidating retained detached nodes or style views', async () => {
  const f = await fixture()
  try {
    await f.run(
      `kept=document.createElement('div');kept.id='kept';$node.appendChild(kept);kept.remove();style=document.createElement('div').style;style.width='12px'`
    )
    for (let batch = 0; batch < 120; batch++) {
      await f.run(
        `for(let i=0;i<100;i++){const node=document.createElement('div');node.style.color='red';$node.appendChild(node);node.remove()}`
      )
    }
    assert.equal(f.host.children.length, 0)
    await f.run(
      `style.height='9px';$node.appendChild(kept);same=kept===document.querySelector('#kept')`
    )
    assert.equal(f.read('same'), true)
    assert.equal(f.read('style.width'), '12px')
    assert.equal(f.read('style.height'), '9px')
    assert.deepEqual(f.errors, [])
  } finally {
    f.dispose()
  }
})

test('empty responses release their lease at headers; XHR and response clones accept null bodies', async () => {
  const f = await fixture()
  try {
    for (let i = 0; i < 300; i++)
      await f.run(`response=await fetch('/api/ping',{method:'HEAD'})`)
    assert.equal(f.resources.pending, 0)
    assert.equal(
      f.read('response.body === null && response.clone().body === null'),
      true
    )
    await f.run(
      `text=await response.text();xhrResult=await new Promise((resolve,reject)=>{const xhr=new XMLHttpRequest();xhr.open('HEAD','/api/ping');xhr.onload=()=>resolve([xhr.status,xhr.responseText]);xhr.onerror=()=>reject(new Error('XHR failed'));xhr.send()})`
    )
    assert.equal(f.read('text'), '')
    assert.equal(f.read('xhrResult.join(":")'), '204:')
  } finally {
    f.dispose()
  }
})

test('abandoned response bodies are cancelled; retained readers survive collection and clone cancellation', async () => {
  let cancelled = 0
  const f = await fixture(
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array([65]))
          },
          cancel() {
            cancelled++
          },
        })
      )
  )
  try {
    for (let i = 0; i < 300; i++) await f.run(`await fetch('/api/ignored')`)
    await tick()
    assert.equal(f.resources.pending, 0)
    assert.equal(cancelled, 300)
    await f.run(`reader=(await fetch('/api/read')).body.getReader()`)
    await f.run(`piece=await reader.read()`)
    assert.equal(f.read('piece.value[0]'), 65)
    assert.equal(f.resources.pending, 1)
    await f.run(`await reader.cancel();reader=null`)
    assert.equal(f.resources.pending, 0)
    await f.run(
      `original=await fetch('/api/clone');copy=original.clone();await original.body.cancel();piece=await copy.body.getReader().read()`
    )
    assert.equal(f.read('piece.value[0]'), 65)
    assert.equal(f.resources.pending, 1)
  } finally {
    f.dispose()
  }
})

test('late assets and styles cannot write into a disposed or rebound component', async () => {
  let resolveAsset
  const f = await fixture(
    () =>
      new Promise((resolve) => {
        resolveAsset = resolve
      })
  )
  try {
    await f.run(
      `$node.style.backgroundImage='url(/assets/late.png)'; image=new Image();image.src='/assets/late.png';$node.appendChild(image)`
    )
    const image = f.host.firstChild
    f.disposeComponent()
    f.host.style.backgroundImage = 'none'
    resolveAsset(
      new Response(new Uint8Array([1]), {
        headers: { 'Content-Type': 'image/png' },
      })
    )
    await tick()
    await tick()
    assert.equal(f.host.style.backgroundImage, 'none')
    assert.equal(image.getAttribute('src'), null)
    assert.deepEqual(f.errors, [])
  } finally {
    f.dispose()
  }
})

test('fatal VM exit closes module sockets, requests, observers and GPU contexts exactly once', async () => {
  const OriginalSocket = globalThis.WebSocket
  const OriginalObserver = window.MutationObserver
  let disconnected = 0
  window.MutationObserver = class {
    observe() {}
    disconnect() {
      disconnected++
    }
  }
  let socket,
    lost = 0
  globalThis.WebSocket = class {
    constructor() {
      socket = this
      this.closed = 0
    }
    close() {
      this.closed++
    }
  }
  const f = await fixture(
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array([1]))
          },
        })
      )
  )
  globalThis.WebSocket = OriginalSocket
  const canvas = document.createElement('canvas')
  canvas.getContext = () => ({
    getExtension: (name) =>
      name === 'WEBGL_lose_context'
        ? {
            loseContext() {
              lost++
            },
          }
        : null,
  })
  f.host.append(canvas)
  try {
    await f.run(
      `socket=new WebSocket('/api/live');response=await fetch('/api/open');gl=$node.querySelector('canvas').getContext('webgl2');observer=new MutationObserver(()=>{});observer.observe($node,{childList:true})`
    )
    await f
      .run(
        `let n=2000;function loop(){if(--n>0)Promise.resolve().then(loop)}loop()`
      )
      .catch(() => {})
    await tick()
    assert.equal(f.execution.engine.disposed, true)
    assert.equal(socket.closed, 1)
    assert.equal(lost, 1)
    assert.equal(disconnected, 1)
    assert.equal(
      f.host.dispatchEvent(new Event('submit', { cancelable: true })),
      true
    )
    assert.equal(f.resources.pending, 0)
    assert.ok(f.errors.some((error) => /microtask budget/.test(error.message)))
    f.execution.dispose()
    assert.equal(socket.closed, 1)
    assert.equal(lost, 1)
  } finally {
    f.dispose()
    window.MutationObserver = OriginalObserver
    globalThis.WebSocket = OriginalSocket
  }
})

test('attached DOM facades retain library data and object identity across VM turns', async () => {
  const f = await fixture()
  try {
    await f.run(
      `{const row=document.createElement('div');row.id='row';row.__data__={value:42};$node.appendChild(row)}`
    )
    await f.run(
      `answer=document.querySelector('#row').__data__.value;document.querySelector('#row').remove()`
    )
    assert.equal(f.read('answer'), 42)
    assert.deepEqual(f.errors, [])
  } finally {
    f.dispose()
  }
})

test('Canvas gradients are reclaimed while current styles and retained gradients stay usable', async () => {
  const f = await fixture()
  const native = {
    createLinearGradient: () => ({ addColorStop() {} }),
    fillStyle: '#000',
  }
  const canvas = document.createElement('canvas')
  canvas.getContext = () => native
  f.host.append(canvas)
  try {
    await f.run(
      `ctx=$node.querySelector('canvas').getContext('2d');kept=ctx.createLinearGradient(0,0,1,1);kept.addColorStop(0,'red')`
    )
    for (let batch = 0; batch < 30; batch++)
      await f.run(
        `for(let i=0;i<100;i++){const g=ctx.createLinearGradient(0,0,1,1);g.addColorStop(0,'red');ctx.fillStyle=g}`
      )
    await f.run(
      `ctx.fillStyle.addColorStop(1,'blue');ctx.fillStyle=kept;same=ctx.fillStyle===kept`
    )
    assert.equal(f.read('same'), true)
    assert.deepEqual(f.errors, [])
  } finally {
    f.dispose()
  }
})

test('a CPU interrupt also terminates module transport without waiting for another VM call', async () => {
  const OriginalSocket = globalThis.WebSocket
  let socket
  globalThis.WebSocket = class {
    constructor() {
      socket = this
    }
    close() {
      this.closed = true
    }
  }
  const f = await fixture()
  globalThis.WebSocket = OriginalSocket
  f.execution.engine.timeLimit = 15
  try {
    await f.run(`socket=new WebSocket('/api/live')`)
    await assert.rejects(f.run('while(true){}'), /interrupted/)
    await tick()
    assert.equal(f.execution.engine.disposed, true)
    assert.equal(socket.closed, true)
  } finally {
    f.dispose()
    globalThis.WebSocket = OriginalSocket
  }
})

test('removing an attribute and rebinding a host invalidate prior asynchronous writes', async () => {
  let complete
  const f = await fixture(
    () =>
      new Promise((resolve) => {
        complete = resolve
      })
  )
  try {
    const pending = f.execution.render.attribute(
      f.host,
      'style',
      'background-image:url(/assets/late.png)'
    )
    await f.run(
      `image=new Image();image.src='/assets/late.png';$node.appendChild(image);image.removeAttribute('src')`
    )
    f.execution.render.bind(f.host, { closed: false })
    f.host.style.backgroundImage = 'none'
    complete(
      new Response(new Uint8Array([1]), {
        headers: { 'Content-Type': 'image/png' },
      })
    )
    await pending
    await tick()
    assert.equal(f.host.style.backgroundImage, 'none')
    assert.equal(f.host.firstChild.getAttribute('src'), null)
  } finally {
    f.dispose()
  }
})
