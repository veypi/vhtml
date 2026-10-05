// Fixed, local packages are served under each test module's resource prefix.
export const vendors = {
  'echarts.js': 'echarts/dist/echarts.min.js',
  'chart.js': 'chart.js/dist/chart.umd.js',
  'd3.js': 'd3/dist/d3.min.js',
  'lodash.js': 'lodash/lodash.min.js',
  'dayjs.js': 'dayjs/dayjs.min.js',
  'axios.js': 'axios/dist/axios.min.js',
  'jquery.js': 'jquery/dist/jquery.min.js',
  'marked.js': 'marked/lib/marked.umd.js',
  'three.module.js': 'three/build/three.module.min.js',
  'three.core.min.js': 'three/build/three.core.min.js',
}
export const cases = {
  lodash: {
    scripts: ['lodash.js'],
    code: `assert(_.sumBy([{n:2},{n:3}],'n')===5,'sumBy');assert(_.get({a:{b:7}},'a.b')===7,'get');$node.textContent=JSON.stringify(_.groupBy([1,2,3],v=>v%2));`,
  },
  dayjs: {
    scripts: ['dayjs.js'],
    code: `assert(dayjs('2024-02-28').add(2,'day').format('YYYY-MM-DD')==='2024-03-01','date arithmetic');$node.textContent=dayjs('2024-02-28').add(2,'day').format('YYYY-MM-DD');`,
  },
  marked: {
    scripts: ['marked.js'],
    code: `const html=marked.parse('**sandbox**');assert(html.includes('<strong>sandbox</strong>'),'markdown');$node.innerHTML=html;`,
  },
  axios: {
    scripts: ['axios.js'],
    code: `const result=await axios.get('/api/data');assert(result.data.answer===42,'request');let denied=false;try{await axios.get('@/forbidden-axios')}catch(_){denied=true};assert(denied,'network boundary');$node.textContent=JSON.stringify(result.data);`,
  },
  jquery: {
    scripts: ['jquery.js'],
    code: `const root=$($node);root.append('<div class="item"><span>Hello</span></div>');root.find('span').text('jQuery DOM');root.find('.item').css('width','120px');assert(root.find('span').text()==='jQuery DOM','DOM text');let clicked=0;root.find('span').on('click',()=>clicked++).trigger('click');assert(clicked===1,'event');const copy=root.find('.item').clone();root.append(copy);assert($('<b>parsed</b>').text()==='parsed','detached document');assert(root.find('.item').length===2,'clone');$scope.addCleanup(()=>root.off());`,
  },
  d3: {
    scripts: ['d3.js'],
    code: `const svg=d3.select($node).append('svg').attr('width',320).attr('height',180).attr('viewBox','0 0 320 180');const gradient=svg.append('defs').append('linearGradient').attr('id','paint');gradient.append('stop').attr('offset','0%').attr('stop-color','#06b6d4');gradient.append('stop').attr('offset','100%').attr('stop-color','#2563eb');svg.selectAll('rect').data([30,80,130]).join('rect').attr('x',(_,i)=>20+i*90).attr('y',d=>160-d).attr('width',60).attr('height',d=>d).attr('fill','url(#paint)').on('click',function(event){const p=d3.pointer(event);assert(p.length===2,'pointer');$node.setAttribute('data-click','yes')});assert(svg.selectAll('rect').size()===3,'data join');assert($node.querySelector('#paint')!==null,'scoped id');const scale=d3.scaleBand().domain(['A','B','C']).range([20,290]);svg.append('g').attr('transform','translate(0,165)').call(d3.axisBottom(scale));`,
  },
  'echarts-svg': {
    scripts: ['echarts.js'],
    code: `const chart=echarts.init($node,null,{renderer:'svg'});chart.setOption({animation:false,xAxis:{data:['A','B','C']},yAxis:{},series:[{type:'bar',data:[10,25,16],itemStyle:{color:new echarts.graphic.LinearGradient(0,0,0,1,[{offset:0,color:'#9333ea'},{offset:1,color:'#ddd6fe'}])}}]});chart.setOption({series:[{data:[12,28,18]}]});chart.on('click',()=>{$node.setAttribute('data-click','yes')});assert($node.querySelector('svg')!==null,'SVG renderer');$scope.addCleanup(()=>chart.dispose());`,
  },
  three: {
    scripts: [],
    code: `const THREE=await import('./vendor/three.module.js');const renderer=new THREE.WebGLRenderer({alpha:true,antialias:false,preserveDrawingBuffer:true});renderer.setSize(320,180);$node.appendChild(renderer.domElement);const scene=new THREE.Scene();const camera=new THREE.PerspectiveCamera(60,320/180,.1,100);camera.position.z=3;const geometry=new THREE.BoxGeometry();const material=new THREE.MeshNormalMaterial();const cube=new THREE.Mesh(geometry,material);cube.rotation.set(.4,.6,0);scene.add(cube);renderer.render(scene,camera);const gl=renderer.getContext();assert(gl instanceof WebGL2RenderingContext,'WebGL2 context');assert(gl.canvas.ownerDocument.defaultView===window,'context boundary');const pixel=new Uint8Array(4);gl.readPixels(160,90,1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);assert(pixel[3]>0,'GPU pixel');assert(gl.getError()===gl.NO_ERROR,'GL error');$node.setAttribute('data-pixel',Array.from(pixel).join(','));$scope.addCleanup(()=>{geometry.dispose();material.dispose();renderer.dispose();renderer.forceContextLoss()});`,
  },
  webgl1: {
    scripts: [],
    code: `const canvas=document.createElement('canvas');canvas.width=320;canvas.height=180;$node.appendChild(canvas);const gl=canvas.getContext('webgl',{preserveDrawingBuffer:true});assert(gl,'WebGL1 available');gl.clearColor(.1,.6,.9,1);gl.clear(gl.COLOR_BUFFER_BIT);const pixel=new Uint8Array(4);gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);assert(pixel[2]>200 && pixel[3]===255,'WebGL1 readback');assert(gl.getParameter(gl.VERSION).includes('WebGL'),'parameters');const buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([1,2,3]),gl.STATIC_DRAW);assert(gl.getBufferParameter(gl.ARRAY_BUFFER,gl.BUFFER_SIZE)===12,'buffer transfer');assert(buffer.constructor.constructor('return globalThis')()===window,'GPU object boundary');gl.deleteBuffer(buffer);$scope.addCleanup(()=>gl.getExtension('WEBGL_lose_context').loseContext());`,
  },
}
export function component(name) {
  const entry = cases[name]
  return `<head>${entry.scripts.map((file) => `<script src="/vendor/${file}"></script>`).join('')}</head><body style="display:block;width:320px;height:220px"></body><script>try{const assert=(test,message)=>{if(!test)throw new Error(message)};${entry.code};assert(typeof window.__hostSecret==='undefined','host global');assert(document.querySelector('#outside')===null,'host DOM');$node.setAttribute('data-result','PASS')}catch(error){$node.setAttribute('data-result','FAIL: '+error.message+' '+error.stack);throw error}</script>`
}
export const page = `<!doctype html><meta charset="utf-8"><title>Sandbox library compatibility</title><style>body{font:14px system-ui;margin:24px}main{display:flex;gap:16px;flex-wrap:wrap}.card{width:340px;border:1px solid #ddd;padding:12px;border-radius:8px}.status{white-space:pre-wrap;overflow-wrap:anywhere}h2{margin:0 0 8px}button{padding:8px 16px}</style><h1 id="outside">Unsafe module library compatibility</h1><button id="dispose">Dispose all</button><pre id="summary">RUNNING</pre><main></main><script type="module">
import VHTML from '/dist/vhtml.min.js';window.__hostSecret='native';const apps=[],results=[],root=document.querySelector('main'),summary=document.querySelector('#summary');
for(const name of ${JSON.stringify(Object.keys(cases))}){
 const card=document.createElement('section');card.className='card';card.innerHTML='<h2>'+name+'</h2><pre class="status">RUNNING</pre><div class="host" id="case-'+name+'"></div>';root.append(card);const host=card.querySelector('.host'),status=card.querySelector('.status');
 try{const app=new VHTML({target:host});apps.push(app);await app.ready;await app.parseRef('/modules/compat/'+name+'/page',host);for(let i=0;i<100&&!host.dataset.result;i++)await new Promise(r=>setTimeout(r,50));const result=host.dataset.result||'FAIL: script initialization';status.textContent=result;results.push([name,result]);}catch(error){status.textContent='FAIL: '+error.message;results.push([name,status.textContent])}
 summary.textContent=results.map(([name,result])=>name+': '+result.split('\\n')[0]).join('\\n');
}
if(Object.values({lodash:window._,dayjs:window.dayjs,marked:window.marked,axios:window.axios,jquery:window.jQuery,d3:window.d3,echarts:window.echarts,THREE:window.THREE}).some(Boolean))summary.textContent+='\\nFAIL: host global pollution';
const gpu=[document.querySelector('#case-three canvas')?.getContext('webgl2'),document.querySelector('#case-webgl1 canvas')?.getContext('webgl')].filter(Boolean);
summary.dataset.complete='true';document.querySelector('#dispose').onclick=()=>{for(const app of apps){app.destroy();app.templateLoader.clear()}summary.textContent+=gpu.length===2&&gpu.every(gl=>gl.isContextLost())?'\\nDISPOSED: GPU contexts released':'\\nFAIL: GPU cleanup'};
</script>`
