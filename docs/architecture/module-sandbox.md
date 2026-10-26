# 模块沙箱

模块首次响应包含 `vhtml-unsafe` 时，框架在执行 `env.js` 前为该模块创建 QuickJS WASM 引擎。标记按响应头是否存在判断，与值无关；必须同时提供非根 `vhtml-scoped`：

```http
vhtml-scoped: /modules/demo
vhtml-unsafe: 1
```

模块元信息保存在框架私有登记表中。第一次是什么就是什么：后续响应不重新解释 unsafe，清模板缓存也不改变该登记结果。后端负责响应头正确性。组件没有 unsafe 属性、传播状态或执行选项。

隔离边界是 **JS 执行环境和框架开放的能力**。保留共享的真实 DOM 与 CSS，不使用 Shadow DOM 或 iframe，不承诺 DOM/CSS 的严格隔离。宿主样式、继承的 CSS 变量、原生 ID/表单关联仍可能产生相互影响，浏览器由这些共享机制触发的被动请求不属于封装网络 API 的隔离保证。

## 执行与数据

变量查找顺序是 `$data → $mod → $sys → 平台对象`。普通模块使用浏览器平台；unsafe 模块使用独立引擎内的对象和框架提供的能力。`window === self === globalThis`，都属于该模块的引擎。构造器、原型链、`eval` 和 `Function` 也只作用于引擎自身。

`env.js`、`routes.js`、setup、生命周期、模板表达式、事件和静态/动态 import 均遵守模块执行归属，包括组件 body 上的绑定属性。env.js 可缺省（404）；其依赖缺失、语法或初始化错误会使加载失败。隔离引擎加载失败时组件失败，不切回原生执行。脚本 import 使用语法树解析，不再正则删除。

普通与隔离模块复用同一份响应式内核、EventBus 和 i18n 实现。隔离状态留在引擎中；渲染器经不透明对象句柄读取和订阅，不复制一套业务状态。列表对象身份、props、静态路径双向绑定和 setup 的延迟 `$watch` 得以保留。模块 EventBus 只在本模块使用；不向 unsafe 暴露 manager.globals 或跨模块广播。

## 网络

以下写法在 unsafe 中可用：

```js
const response = await fetch('/api/items')
items = await response.json()
const xhr = new XMLHttpRequest()
xhr.open('GET', '/api/items')
xhr.send()
const socket = new WebSocket('/api/live')
const events = new EventSource('/api/events')
navigator.sendBeacon('/api/metrics', JSON.stringify({ viewed: true }))
```

`/api/items` 和 `api/items` 均解析到 `/modules/demo/api/items`。import 的相对路径基于源文件；以 `/` 开头时基于模块根。允许模块范围内的绝对地址。WebSocket 使用对应的 ws/wss 协议。

所有网络 API 共用 `ModuleResources`：拒绝 `@`、协议相对地址、模块外地址、路径穿越、歧义编码以及未提供的协议。请求方不能覆盖重定向限制。HTTP 请求设置 `redirect: 'error'`，EventSource 通过受控 fetch 流解析和重连，Beacon 使用受控 keepalive 请求。Beacon 的 `true` 只表示已接受排队；已接受的请求可以在模块销毁后继续，但不保留引擎或回调。

Request、Response、Headers、Blob、URL、URLSearchParams、AbortController、事件和长连接对象在引擎中创建。宿主只保存传输对象和连接 ID；返回数据、事件及错误跨边界时受控复制。`location` 是模块根地址的只读快照，`document.cookie` 为空字符串；不会读取宿主页面地址参数或 Cookie。URL 解析本身不授予访问能力，发起请求时仍由资源服务检查。

## DOM 与资源

框架继续渲染真实 DOM，不实现另一棵虚拟 DOM。`$node`、`$refs` 和 DOM 事件目标是模块范围的节点接口，提供查询、节点创建与插入、文本、输入值、属性、样式、尺寸、焦点和事件监听。`$node.ownerDocument` 是模块的虚拟 document，`ownerDocument.defaultView === window`；没有原生 Document 或 Window 引用。节点查询不能离开授权组件根，虚拟 document 查询只覆盖本模块已挂载的根。

`$scope` 提供清理、生命周期回调以及随组件回收的 timeout/interval。`$router` 提供当前路由信息、push/replace/resolveHref 和参数更新，导航地址仍检查模块范围。额外宿主服务不能直接透传给 unsafe。

routes.js 的 beforeEnter / afterEnter、redirect、cacheKey 和 error_redirect 接收可复制的路由数据快照，不提供内部 matcher 或原生回调。beforeEnter 可异步返回，并通过引擎内的 `next(target)` 请求重定向；error_redirect 的错误参数提供 name/message/stack。

HTML 先通过无浏览器副作用的解析器检查，再交给 DOMParser。框架识别的图片、媒体、字体和显式 CSS URL 经模块资源服务获取、校验后转成模块拥有的 Blob URL。静态模板与动态 DOM 共用元素规则，动态属性、style 和 v-html 也经过渲染策略。模板中的 script/style 和 head stylesheet 是加载器元数据，不能作为动态原生节点插入。保留组件样式作用域；原生 on* 属性、主动嵌入元素和未提供的资源入口明确拒绝。这些检查不扩展为共享 DOM/CSS 的完整浏览器隔离。

属性绑定与 DOM 方法共用一份写入代次及组件归属，移除属性会取消旧写入，组件销毁或节点被重新接管后，迟到的资源不会写回。DOM 句柄只在节点仍属于组件或 JS 仍持有代理时保留；已挂载节点保留库附加的数据，已移除且不再引用的节点释放。保留的游离节点可以再次插入。

`:style` 与普通模块共用快照和差异更新，跟踪对象字段的原地修改与删除，保留不冲突的静态样式；`:value`、`:checked` 等按 DOM 属性语义更新用户编辑后的控件。每个组件只持有一个 VM 执行上下文，v-for 行使用调用时的数据作用域，不在模块内永久登记每一行。

## 第三方 UI 库

模块目录内的 UMD 库可通过 head 中的 script 加载；同一脚本 URL 在一个模块中只执行一次，多个组件共享模块 window 上的库对象。框架不会把该库注入宿主 window。

```html
<!doctype html>
<html>
  <head><script src="/vendor/echarts.min.js"></script></head>
  <body style="display: block; width: 100%; height: 320px"></body>
  <script>
    const chart = echarts.init($node)
    chart.setOption({
      xAxis: { data: ['A', 'B', 'C'] },
      yAxis: {},
      series: [{ type: 'bar', data: [10, 25, 16] }]
    })
    $scope.addCleanup(() => chart.dispose())
  </script>
</html>
```

地址仍按模块前缀解析。例如 `/vendor/echarts.min.js` 对应 `/modules/demo/vendor/echarts.min.js`，不能直接加载公共 CDN 或通过 `@` 绕过模块。库内部的 fetch、Image.src 和 CSS URL 也使用同一资源检查。

DOM 接口提供常用 HTML 元素、Canvas 2D 路径/文本/渐变/图片绘制、getComputedStyle、getBoundingClientRect、requestAnimationFrame、window resize 通知、ResizeObserver 和 MutationObserver。绘图上下文、渐变、观察器记录及事件都返回沙箱对象。库生成的 innerHTML 先用无浏览器副作用的解析器检查，再创建安全节点；脚本、主动嵌入元素和原生事件属性仍被拒绝。document.body 仅能在模块只有一个根时作为插入容器；多根模块应显式指定 `$node` 内的容器。

真实浏览器夹具固定以下版本，它们只作为测试依赖，不打进框架产物。此验证不代表任意 UI 库、渲染器或插件都已兼容。

| 库 | 已验证场景 |
| --- | --- |
| ECharts 6.0.0 | Canvas / SVG 绘图、渐变、更新、尺寸、HTML tooltip、事件、销毁 |
| Chart.js 4.5.1 | Canvas 折线图、更新、响应尺寸、销毁 |
| D3 7.9.0 | SVG data join、坐标轴、渐变、节点选择、点击坐标 |
| Three.js 0.180.0 | ES module 导入、WebGL2 着色器与缓冲区、立方体、像素读回、资源销毁 |
| jQuery 3.7.1 | 初始化、查询、HTML 解析与插入、样式、事件、克隆 |
| Axios 1.12.2 | 模块内 GET、JSON 响应、拒绝 `@` |
| Lodash 4.17.21 / Day.js 1.11.13 / Marked 16.3.0 | 数据处理、日期运算、Markdown 转受控 HTML |

## SVG 与 WebGL

SVG 提供常用图形、文本、路径、渐变、裁剪、遮罩和滤镜，以及受控的 namespace、几何尺寸和坐标变换接口。模块内 SVG ID 使用随机模块前缀，选择器与 `url(#id)` / `use href="#id"` 统一转换，引用不能指向宿主页面或其他模块的节点。SVG image 使用相同的模块资源入口；外部 SVG 文档引用、foreignObject、SMIL 和 SVG script 不开放。

Canvas 提供 `getContext('webgl')` 和 `getContext('webgl2')`。上下文、buffer、shader、program、texture 等都通过模块私有句柄访问，原生 GPU 对象不进入引擎；数组上传和 readPixels / getBufferSubData 读回经过复制。只开放列明的标准方法和扩展，getExtension 对未提供的扩展返回 null。WebGL1 清屏、缓冲区上传和像素读回也有独立浏览器测试。

WebGL 与 Canvas 2D 继续受同一个节点所有权检查；不能读取或使用其他模块的 canvas。组件清理后释放对应 GPU 上下文，模块销毁释放所有剩余上下文。渲染库仍应通过 `$scope.addCleanup` 调用自身 dispose / destroy。

## 当前明确限制

这是提供有限浏览器能力的 JS 运行环境，不是完整 Web API 实现。

- 不提供原生 document/history/storage、Worker/ServiceWorker、iframe/object/embed、MathML、任意原生自定义元素或跨模块组件加载。跨模块 props 只能传可复制的数据，不能隐式授予原生函数或对象。应用需要的全局服务必须通过独立、明确的受控接口增加。
- DOM 提供受控的 HTML、SVG、Canvas 2D 与 WebGL 能力，不提供 Path2D、Canvas 2D 像素导出或完整浏览器 DOM。外部 image/svg+xml 资源仍不接受，SVG 应使用经过校验的内联节点。script/style/link 不能通过动态节点或 innerHTML 插入；组件内部的原生提交和链接点击会被拦截，导航使用框架路由；共享 DOM 的跨根关联不提供严格隔离。
- 同步 XHR、XHR document 响应与上传进度、FormData、流式 TextDecoder、CSS @import/image-set 尚未提供。fetch 支持读取流、text/json/arrayBuffer/blob、clone 和取消；并非完整 WHATWG Streams 实现。
- unsafe 的 import 要写完整文件名；import attributes 不支持。env.js 的 manager 不开放全局 define、模块预加载或别名注册。
- 双向绑定使用 `object.field`、`list[0].name` 等静态路径；复杂动态左值在 unsafe 中拒绝。
- 首期使用同线程引擎，避免同步 DOM 绑定变成异步协议。每次 JS 执行有时间限额，但没有把宿主渲染搬到 Worker；大量合法 DOM 更新仍可能占用主线程。WebGL 配额限制资源申请和单次绘制规模，不能保证 GPU 驱动、复杂 shader 或宿主渲染的硬实时隔离。

默认限额：32 MiB 引擎内存、250 ms 单次执行、1,000 ms 脚本包装函数编译、1,024 个定时器、256 个活动网络连接/请求、4 MiB 单份代码资源、16 MiB 单响应/资源、32 MiB 缓存资源、256 个缓存资源、64 KiB 待发送 Beacon；10,000 个 DOM 句柄、2,048 个事件监听器、128 个观察器、128 个 Canvas 2D 上下文，Canvas 单边至多 4,096 像素、模块共 16 Mi 像素。WebGL 每模块最多 8 个上下文、4,096 个对象句柄、64 MiB 保守资源申请预算、16 MiB 单次数据传输；纹理单边 4,096、深度 256，单次绘制最多 4 Mi 个顶点/索引乘实例数。预算不是浏览器或驱动实际显存的精确计量。正常销毁和执行超限共用模块终止入口，取消请求和定时器、关闭连接与重连、解除原生监听及观察器、撤销 Blob URL 并释放 GPU 上下文和引擎。

HEAD / 204 等无响应体请求在收到响应头时释放名额；读取结束、取消及不再被 JS 引用的响应也会回收。只持有 body/reader 而不持有 Response 时，流仍有效；复制响应的分支取消互不误伤。句柄清理在 VM 任务结束后执行，不等待 FinalizationRegistry 回调。

## 构建和验证

`npm run build` 生成入口和按需加载的沙箱/引擎分片。部署或复制整个 `dist/`，不要只复制 `vhtml.min.js`。普通模块不初始化 WASM；首次 unsafe 模块才加载执行器。

```sh
npm test
npm run build
node scripts/check-sandbox-build.mjs
node scripts/sandbox-server.mjs
# 浏览器打开 http://127.0.0.1:8135（隔离）、/runtime（绑定与路由）、/charts（Canvas 图表）、/libraries（SVG / WebGL 与常见库）
# 可用 VHTML_SANDBOX_PORT=0 自动选择空闲端口，启动日志会显示地址。
```

浏览器夹具覆盖五类网络 API、模块 import、事件绑定、图片/CSS Blob 资源、v-html、构造器隔离、主动 HTML 拒绝及跨范围重定向，并检查服务端请求日志。`/runtime` 验证静态与动态样式共存、嵌套样式修改、脏表单值、反复移除列表、异步守卫重定向及后续导航。单元测试补充路径编码、取消、订阅清理、列表身份、执行限额、模块归属、过期 env 与装配失败回收。

范围：隔离约束针对由框架加载和执行的不可信模块。后端仍负责接口授权、模块路径下的内容与响应头；宿主自己直接加载的原生脚本和原生页面不由这个执行器接管。

验证覆盖静态资源入口拒绝、12,000 次节点创建/移除、300 次空响应、300 次丢弃响应、迟到资源写回、VM 异常终止，以及原有图表库、SVG、WebGL、事件和网络用例。测试夹具中的请求日志只证明已覆盖的入口，不代表共享 DOM/CSS 的所有被动行为被隔离。
