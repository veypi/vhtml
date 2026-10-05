// Local browser integration fixture. Serves only this test page, fixtures and dist files.
import http from 'node:http'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { cases, vendors, component as libraryComponent, page as libraryPage } from './library-suite.mjs'
import { runtimeFiles, runtimePage } from './runtime-suite.mjs'
const root = fileURLToPath(new URL('../', import.meta.url)),
  requests = []
const scoped = '/modules/demo'
const component = `<body>
<button @click="count++">{{count}}</button><span id="ready">{{ready}}</span>
<img id="asset" src="/assets/pixel.png"><img id="denied" :src="'/../forbidden-image'">
<div id="css" :style="{backgroundImage:'url(/assets/pixel.png)'}">asset</div>
<div v-html="html"></div><input ref="input" v:value="text">
<script setup>
count = 1; ready = 'running'; text = 'hello'; html = '<img :src="&quot;/../forbidden-html&quot;">';
await fetch('/api/fetch').then(r => r.text());
await new Promise((resolve,reject) => {const xhr = new XMLHttpRequest(); xhr.open('GET','/api/xhr'); xhr.onload=resolve; xhr.onerror=reject; xhr.send()});
await new Promise((resolve,reject) => {const ws = new WebSocket('/api/socket'); ws.onmessage=() => {ws.close();resolve()};ws.onerror=reject});
await new Promise((resolve,reject) => {const es = new EventSource('/api/events'); es.onmessage=() => {es.close();resolve()};es.onerror=reject});
navigator.sendBeacon('/api/beacon','ping');
let blocked = 0;
for (const url of ['@/forbidden','/../forbidden','/redirect']) {try {await fetch(url)} catch (_) {blocked++}}
const lib = await import('./lib.js');
ready = [blocked, lib.answer, typeof window.__hostSecret, $node.ownerDocument.defaultView === window].join(':');
</script></body>`
const page = `<!doctype html><title>vhtml sandbox integration</title><h1>Sandbox browser test</h1><pre id="results">RUNNING</pre><div id="host"></div>
<script type="module">
import VHTML from '/dist/vhtml.min.js';
window.__hostSecret = 'native';
const results = document.querySelector('#results'), host=document.querySelector('#host');
const app = new VHTML({target:host});
try {
 await app.ready; await app.parseRef('/modules/demo/page',host);
 for(let i=0;i<100 && host.querySelector('#ready')?.textContent!=='3:42:undefined:true';i++) await new Promise(r=>setTimeout(r,100));
 if(host.querySelector('#ready')?.textContent!=='3:42:undefined:true') throw new Error('setup result: '+host.textContent);
 host.querySelector('button').click(); await new Promise(r=>setTimeout(r,100));
 if(host.querySelector('button').textContent!=='2') throw new Error('event binding');
 if(!host.querySelector('#asset').src.startsWith('blob:')) throw new Error('image bypassed resource service');
 if(!host.querySelector('#css').style.backgroundImage.includes('blob:')) throw new Error('CSS bypassed resource service');
 const desc = await app.templateLoader.fetchUI('/modules/demo/page.html');
 let rejected=0;
 for(const html of ['<img src="/forbidden" onerror="window.__hostSecret=1">','<iframe src="/forbidden"></iframe>','<svg><foreignObject><iframe src="/forbidden"></iframe></foreignObject></svg>','<style>@import "/forbidden";</style>','<div :onclick="1"></div>','<link rel="preload" as="image" imagesrcset="/forbidden-preload.png 1x">','<div popovertarget="outside"></div>']) {
  try { await app.templateLoader.parseUI(html,{$mod:desc.mod},location.origin+'/modules/demo/attack') } catch (_) { rejected++ }
 }
 if(rejected!==7) throw new Error('HTML rejection count '+rejected);
 app.destroy(); app.templateLoader.clear();
 await new Promise(r=>setTimeout(r,200));
 const log = await (await fetch('/log')).json();
 if(log.some(url=>url.startsWith('/forbidden'))) throw new Error('OUT OF SCOPE REQUEST: '+JSON.stringify(log));
 for(const required of ['/api/fetch','/api/xhr','/api/socket','/api/events','/api/beacon','/assets/pixel.png']) if(!log.includes('/modules/demo'+required)) throw new Error('Missing '+required);
 results.textContent = 'PASS: fetch / XHR / WebSocket / EventSource / Beacon; imports; constructor isolation; DOM events; image and CSS blobs; HTML rejection; redirect denied; no out-of-scope requests.\\n'+JSON.stringify(log,null,2);
} catch(error) {results.textContent='FAIL: '+error.stack;console.error(error)}
</script>`
const chartComponent = `<head><script src="/vendor/echarts.js"></script><script src="/vendor/chart.js"></script></head>
<body style="display:block;width:640px;height:720px">
<script>
try {
const chart=echarts.init($node);
chart.setOption({animation:false,tooltip:{formatter:()=>'<b>Sandbox tooltip</b>'},xAxis:{data:['A','B','C']},yAxis:{},series:[{type:'bar',data:[10,25,16],itemStyle:{color:new echarts.graphic.LinearGradient(0,0,0,1,[{offset:0,color:'#2563eb'},{offset:1,color:'#93c5fd'}])}}]});
chart.dispatchAction({type:'showTip',seriesIndex:0,dataIndex:1});
chart.on('click',()=>{$node.setAttribute('data-click','yes')});
chart.setOption({series:[{data:[12,28,18]}]});
chart.resize({width:600,height:320});
const second=document.createElement('div');second.style.cssText='width:640px;height:340px';const canvas=document.createElement('canvas');canvas.width=640;canvas.height=340;second.appendChild(canvas);$node.appendChild(second);
const other=new Chart(canvas,{type:'line',data:{labels:['A','B','C'],datasets:[{label:'Sandbox Chart.js',data:[4,8,6]}]},options:{animation:false,responsive:true}});
other.data.datasets[0].data=[7,10,8];other.update();
$node.setAttribute('data-isolation',[document.querySelector('#outside')===null,$node.ownerDocument.defaultView===window,typeof window.__hostSecret,document.cookie === ''].join(':'));
$node.setAttribute('data-charts','ready');
$scope.addCleanup(()=>{chart.dispose();other.destroy()});
} catch(error) { $node.setAttribute('data-error',error.message+' '+error.stack);throw error; }
</script></body>`
const chartPage = `<!doctype html><title>Sandbox charts</title><h1 id="outside">ECharts + Chart.js in unsafe module</h1><button id="dispose">Dispose charts</button><pre id="results">RUNNING</pre><div id="host"></div>
<script type="module">
import VHTML from '/dist/vhtml.min.js';window.__hostSecret='native';
const host=document.querySelector('#host'),results=document.querySelector('#results');
const originalError=console.error;console.error=(...args)=>{originalError(...args);for(const arg of args)if(arg?.message)host.dataset.hosterror=arg.message};
const app=new VHTML({target:host});
try {
 await app.ready;await app.parseRef('/modules/demo/charts',host);
 for(let i=0;i<100 && host.dataset.charts!=='ready';i++)await new Promise(r=>setTimeout(r,100));
 if(host.dataset.charts!=='ready')throw new Error(host.dataset.error || host.dataset.hosterror || 'Charts initialization did not complete');
 const canvases=[...host.querySelectorAll('canvas')];
 if(canvases.length!==2)throw new Error('Expected two chart canvases: '+canvases.length);
 for(const canvas of canvases){const pixels=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;if(!pixels.some((v,i)=>i%4===3&&v>0))throw new Error('Canvas is blank')}
 if(window.echarts||window.Chart)throw new Error('Library escaped into host Window');
 if(host.dataset.isolation!=='true:true:undefined:true')throw new Error('DOM isolation: '+host.dataset.isolation);
 if(!host.textContent.includes('Sandbox tooltip'))throw new Error('HTML tooltip missing');
 results.textContent='PASS: ECharts 6 and Chart.js 4 rendered, updated and resized using module DOM/Canvas. HTML tooltip rendered. Host globals are unavailable; DOM queries stay module-local.';
 document.querySelector('#dispose').addEventListener('click',()=>{const before=host.dataset.hosterror;app.destroy();app.templateLoader.clear();if(host.dataset.hosterror!==before)throw new Error('Dispose failed: '+host.dataset.hosterror);results.textContent+=' Disposed.'},{once:true});
} catch(error){results.textContent='FAIL: '+error.stack;console.error(error)}
</script>`
const server = http.createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname
  requests.push(path)
  if (path === '/runtime') {res.setHeader('Content-Type','text/html');res.end(runtimePage);return}
  if (Object.hasOwn(runtimeFiles, path)) {
    res.setHeader('vhtml-scoped', scoped);res.setHeader('vhtml-unsafe', '1')
    res.setHeader('Content-Type', path.endsWith('.js') ? 'text/javascript' : 'text/html')
    res.end(runtimeFiles[path]);return
  }
  if (path === '/libraries') {res.setHeader('Content-Type','text/html');res.end(libraryPage);return}
  const compatibility = path.match(/^\/modules\/compat\/([^/]+)\/(.+)$/)
  if (compatibility && cases[compatibility[1]]) {
    const [, name, file] = compatibility
    res.setHeader('vhtml-scoped','/modules/compat/'+name);res.setHeader('vhtml-unsafe','1')
    if (file === 'page.html') {res.setHeader('Content-Type','text/html');res.end(libraryComponent(name));return}
    if (file === 'env.js') {res.setHeader('Content-Type','text/javascript');res.end('export default mod => {}');return}
    if (file === 'api/data') {res.setHeader('Content-Type','application/json');res.end('{"answer":42}');return}
    if (file.startsWith('vendor/') && vendors[file.slice(7)]) {res.setHeader('Content-Type','text/javascript');res.end(await readFile(root+'node_modules/'+vendors[file.slice(7)]));return}
  }
  if (path.startsWith(scoped)) {
    res.setHeader('vhtml-scoped', scoped)
    res.setHeader('vhtml-unsafe', '1')
  }
  if (path === '/charts') {
    res.setHeader('Content-Type', 'text/html')
    res.end(chartPage)
    return
  }
  if (path === scoped + '/charts.html') {
    res.setHeader('Content-Type', 'text/html')
    res.end(chartComponent)
    return
  }
  if (
    path === scoped + '/vendor/echarts.js' ||
    path === scoped + '/vendor/chart.js'
  ) {
    res.setHeader('Content-Type', 'text/javascript')
    res.end(
      await readFile(
        root +
          (path.endsWith('/echarts.js')
            ? 'node_modules/echarts/dist/echarts.min.js'
            : 'node_modules/chart.js/dist/chart.umd.js')
      )
    )
    return
  }
  if (path === '/log') {
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify(requests))
    return
  }
  if (path === '/') {
    res.setHeader('Content-Type', 'text/html')
    res.end(page)
    return
  }
  if (path === scoped + '/page.html') {
    res.setHeader('Content-Type', 'text/html')
    res.end(component)
    return
  }
  if (path === scoped + '/env.js') {
    res.setHeader('Content-Type', 'text/javascript')
    res.end('export default mod => {}')
    return
  }
  if (path === scoped + '/lib.js') {
    res.setHeader('Content-Type', 'text/javascript')
    res.end('export const answer=42')
    return
  }
  if (path === scoped + '/redirect') {
    res.writeHead(302, { Location: '/forbidden-redirect' })
    res.end()
    return
  }
  if (path === scoped + '/api/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.write('data: hello\n\n')
    return
  }
  if (path.startsWith(scoped + '/api/')) {
    res.end('ok')
    return
  }
  if (path === scoped + '/assets/pixel.png') {
    res.setHeader('Content-Type', 'image/png')
    res.end(
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jN1kAAAAASUVORK5CYII=',
        'base64'
      )
    )
    return
  }
  if (/^\/dist\/(?:vendor\/)?[a-zA-Z0-9_.-]+\.js$/.test(path)) {
    try {
      res.setHeader('Content-Type', 'text/javascript')
      res.end(await readFile(root + path))
    } catch (_) {
      res.writeHead(404)
      res.end()
    }
    return
  }
  res.writeHead(404)
  res.end('not found')
})
server.on('upgrade', (req, socket) => {
  requests.push(req.url)
  if (req.url !== scoped + '/api/socket') {
    socket.destroy()
    return
  }
  const accept = createHash('sha1')
    .update(
      req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
    )
    .digest('base64')
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' +
      accept +
      '\r\n\r\n'
  )
  socket.write(Buffer.from([129, 5, ...Buffer.from('hello')]))
  socket.on('data', (data) => {
    if ((data[0] & 15) === 8) {
      socket.end(Buffer.from([136, 0]))
    }
  })
  socket.on('error', () => {})
})
const port = Number(process.env.VHTML_SANDBOX_PORT || 8135)
server.listen(port, '127.0.0.1', () =>
  console.log(`Sandbox test: http://127.0.0.1:${server.address().port}`)
)
