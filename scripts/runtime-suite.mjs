// Browser coverage for native style/attribute behavior that happy-dom cannot model.
export const runtimeFiles = {
  '/modules/demo/runtime.html': `<body>
    <p class="styled" style="padding:3px" :style="styles">styles</p>
    <input class="value" :value="label"><input class="check" type="checkbox" :checked="checked">
    <button class="change" @click="change">Change bindings</button>
    <button class="clear" @click="rows=[]">Clear rows</button>
    <span class="row" v-for="row in rows">{{row.name}}</span>
    <vrouter history="memory" initial="/modules/demo/item/1"></vrouter>
    <script setup>
      styles={color:'red',marginTop:'2px'};label='first';checked=true;rows=[];
      change=()=>{styles.color='blue';delete styles.marginTop;label='second';checked=false;
        rows=Array.from({length:20},(_,i)=>({name:String(i)}))};
    </script></body>`,
  '/modules/demo/routes.js': `export default {
    routes:[{path:'/item/:id',component:'/runtime-item'},
      {path:'/login',component:'/runtime-login'}],
    beforeEnter:async(to,from,next)=>{
      await Promise.resolve();
      if(to.params.id==='2'){next('/login');return false}
    },
    afterEnter:to=>{globalThis.lastRoute=to.path}
  }`,
  '/modules/demo/runtime-item.html': `<body>
    <p class="item">item {{$router.params.id}}</p>
    <button class="next" @click="$router.push('/item/2')">Guard redirect</button>
  </body>`,
  '/modules/demo/runtime-login.html': `<body>
    <p class="login">login</p>
    <button class="back" @click="$router.push('/item/3')">Back to item</button>
  </body>`,
}

export const runtimePage = `<!doctype html><title>Runtime regressions</title>
<h1>Module runtime regressions</h1><pre id="results">RUNNING</pre><div id="host"></div>
<script type="module">
import VHTML from '/dist/vhtml.min.js';
const host=document.querySelector('#host'),results=document.querySelector('#results');
const app=new VHTML({target:host});
const check=(value,message)=>{if(!value)throw new Error(message)};
const wait=async predicate=>{for(let i=0;i<100;i++){if(predicate())return;await new Promise(r=>setTimeout(r,30))}throw new Error('Timed out')};
try {
  await app.ready;await app.parseRef('/modules/demo/runtime',host);
  await wait(()=>host.querySelector('.item'));
  const styled=host.querySelector('.styled'),input=host.querySelector('.value'),checkbox=host.querySelector('.check');
  check(styled.style.color==='red'&&styled.style.padding==='3px','Initial static/dynamic style');
  input.value='user edit';checkbox.checked=false;
  host.querySelector('.change').click();
  await wait(()=>input.value==='second');
  check(styled.style.color==='blue'&&styled.style.padding==='3px'&&styled.style.marginTop==='','Nested style update');
  check(!checkbox.checked,'Dirty checkbox');
  for(let i=0;i<5;i++){
    host.querySelector('.change').click();await wait(()=>host.querySelectorAll('.row').length===20);
    host.querySelector('.clear').click();await wait(()=>host.querySelectorAll('.row').length===0);
  }
  host.querySelector('.next').click();await wait(()=>host.querySelector('.login'));
  host.querySelector('.back').click();await wait(()=>host.querySelector('.item')?.textContent==='item 3');
  app.destroy();app.templateLoader.clear();
  check(window.__vhtml_dev.errors.length===0,'Runtime error registry is not empty');
  results.textContent='PASS: nested and static styles; dirty form values; repeated row removal; async isolated guard and redirect; navigation after redirect; disposal.';
} catch(error){results.textContent='FAIL: '+error.stack;console.error(error);app.destroy();app.templateLoader.clear()}
</script>`
