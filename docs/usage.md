# vhtml 使用文档

## 这是什么

`vhtml` 是一个纯浏览器端、基于 HTML 文件约定的轻量前端运行时。

它不是：

- Vue/React 那类虚拟 DOM 框架
- SSR 框架
- hydration 框架

它更像：

- 一个“HTML 即组件”的浏览器运行时
- 一个按约定自动加载 `.html` 组件的前端系统
- 一个可选带 `vrouter` 的轻量 SPA 容器

最重要的设计意图只有两点：

1. 让页面和组件都直接写成 HTML 文件
2. 让真实 DOM 成为唯一渲染目标，不引入额外抽象层

## 一句话理解

你写：

```html
<user-profile></user-profile>
```

运行时会自动去加载：

```text
/user/profile.html
```

然后解析这个文件里的：

- `style`
- `body`
- `script setup`
- `script`

再把它挂到当前 DOM 上。

## 适合什么场景

`vhtml` 适合：

- 管理后台
- 工具型前端
- 模块化 Web 页面
- 希望保持 HTML 直观结构的项目
- 不想引入大型框架但又需要组件化、路由、响应式能力的场景

## 核心心智模型

### 1. HTML 文件就是组件，也是页面

一个 `.html` 文件既可以作为：

- 页面
- 布局
- 普通组件
- 表单组件

没有额外的单文件组件语法，HTML 本身就是组件格式。

### 2. 默认只有组件运行时

如果页面里没有 `<vrouter>`，那 `vhtml` 只是一个普通组件渲染运行时。

例如：

```html
<body>
  <app-header></app-header>
  <user-list></user-list>
</body>
```

这时不会启用 page/layout/routes 语义。

### 3. `vrouter` 是特殊组件

只有页面里存在 `<vrouter>` 时，才启用：

- 路由匹配
- page
- layout
- page cache
- `active/deactive`

例如：

```html
<body>
  <vrouter routes="routes.js"></vrouter>
</body>
```

### 4. 真实 DOM 是唯一渲染目标

`vhtml` 不做虚拟 DOM diff。

当前更新方式是：

- 文本插值单点更新
- 属性单点更新
- `v-if/v-for` 直接操作真实 DOM
- slot 直接渲染真实内容

## 基础目录约定

以 `ui/` 为例：

```text
ui/
  root.html
  env.js
  routes.js
  layout/
    default.html
  page/
    index.html
    examples.html
  local/
    preview.html
```

常见职责：

- `root.html`：页面入口
- `env.js`：模块环境入口
- `routes.js`：router 配置入口
- `layout/*.html`：布局
- `page/*.html`：页面
- `local/*.html`：普通本地组件

## 最小入口

一个带路由的最小入口可以是：

```html
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>vhtml</title>
  <link rel="stylesheet" href="/assets/global.css">
  <script type="module" src="/vhtml.min.js"></script>
</head>
<body>
  <vrouter routes="routes.js" style="height: 100%; width: 100%;"></vrouter>
</body>
</html>
```

## 组件文件结构

推荐结构：

```html
<!DOCTYPE html>
<html>
<head>
  <meta name="description" content="组件说明" details="更详细的说明">
  <title>标题或 {{$t('key')}}</title>
</head>

<style>
  body {
    display: block;
  }
</style>

<body>
  <div>{{ text }}</div>
</body>

<script setup>
  text = 'hello'
</script>

<script>
  // mounted 后执行
</script>
</html>
```

## 组件引用规则

### 标签映射

标签名按 `-` 映射路径：

```html
<local-preview></local-preview>
```

对应：

```text
/local/preview.html
```

### `vsrc`

也可以显式指定路径：

```html
<div vsrc="/local/preview.html"></div>
```

### 动态 `:vsrc`

```html
<div :vsrc="currentComponent"></div>
```

## 响应式数据与脚本

## `<script setup>`

`setup` 用来声明组件实例私有状态，也就是 `$data`。

例如：

```html
<script setup>
  count = 0
  inc = () => {
    count++
  }
</script>
```

特点：

- 每个组件实例执行一次
- 这里定义的变量会进入当前组件 `$data`
- 这里最适合放状态和方法

## 普通 `<script>`

普通 `script` 在组件完成初次挂载后执行。

适合：

- 访问 `$node`
- 注册 `$watch`
- 做 mounted 后逻辑

例如：

```html
<script>
  $watch(() => count, () => {
    console.log('count changed', count)
  })
</script>
```

## 生命周期脚本

支持：

- `<script active>`
- `<script deactive>`
- `<script dispose>`

语义：

- `active`：进入激活态时执行
- `deactive`：实例保留但离开激活态时执行
- `dispose`：实例真正销毁时执行

适用场景：

- cache page
- tab 切换
- layout 内页面复用
- 需要清理副作用的组件

## 模板语法

### 文本插值

```html
<div>{{ title }}</div>
```

### 动态属性

```html
<img :src="avatar">
<div :class="{ active: isActive }"></div>
<div :style="{ color: textColor }"></div>
```

### 事件

```html
<button @click="save">保存</button>
<button @click.stop="remove">删除</button>
<input @keydown.enter="submit">
```

### 双向绑定

```html
<input v:value="keyword">
```

### 条件渲染

```html
<div v-if="status === 'loading'">加载中</div>
<div v-else-if="status === 'empty'">暂无数据</div>
<div v-else>完成</div>
```

### 列表渲染

```html
<div v-for="item in list">
  <span>{{ item.name }}</span>
</div>
```

也支持：

```html
<div v-for="(item, idx) in list">
  {{ idx }} - {{ item.name }}
</div>
```

## slot

父组件：

```html
<my-card>
  <div vslot="header">标题</div>
  <div>默认内容</div>
  <div vslot="footer">底部</div>
</my-card>
```

子组件：

```html
<body>
  <vslot name="header"></vslot>
  <vslot></vslot>
  <vslot name="footer"></vslot>
</body>
```

当前语义：

- 支持默认 slot
- 支持命名 slot
- 支持 fallback content
- 支持 `vbind`

## `ref`

### DOM ref

```html
<div ref="panel"></div>
```

当前组件里可以直接拿到：

```html
<script setup>
  panel = null
</script>
```

然后：

```js
panel.classList.add('ready')
```

### 子组件 ref

如果 `ref` 绑定的是子组件宿主节点，当前正式公开这几个入口：

- `childRef.$data`
- `childRef.$env`
- `childRef.$scoped`
- `childRef.$router`

例如：

```html
<user-form ref="formRef"></user-form>
```

```html
<script setup>
  formRef = null

  submitForm = async () => {
    await formRef.$data.submit()
  }
</script>
```

这意味着当前推荐方式是：

- 父组件拿到子组件宿主
- 直接访问子组件 `$data`

不需要额外 `expose`

## 当前上下文说明

### `$data`

当前组件实例私有状态。

放：

- 当前组件数据
- 当前组件方法
- props 映射值

### `$env`

父子组件上下文链。

放：

- 页面上下文
- 布局上下文
- 局部业务标识
- 组件树共享上下文

例如：

```html
<script setup>
  $env.userId = 'u_001'
</script>
```

子组件里可以继续访问：

```html
{{ $env.userId }}
```

### `$scoped`

模块级上下文池。

放：

- `$axios`
- `$i18n`
- `$t`
- `$bus`
- `$message`
- 模块配置

### `$router`

当前组件最近祖先 `<vrouter>` 对应的 router view。

不是全局单例语义。

## 模块环境：`env.js`

每个模块都可以提供：

```text
/$scoped/env.js
```

例如：

```text
/aic/env.js
```

推荐导出：

```js
export default async (env, manager) => {
  env.auth = createAuthService()
  env.featureFlags = { debug: true }
}
```

这里的 `env` 就是当前模块的 `$scoped`。

`env.js` 应该做的事：

- 初始化模块级 `$axios`
- 初始化模块级 `$i18n`
- 初始化模块级业务能力
- 写入模块配置到 `$scoped`

`env.js` 不应该做的事：

- 配置 router 钩子
- 操作局部 `$router`
- 承担组件私有状态

## 路由：`routes.js`

只有页面使用 `<vrouter>` 时，才会加载：

```text
/$scoped/routes.js
```

### 最简单写法

```js
export default [
  { path: '/', component: '/page/index.html', name: 'home', layout: 'default' },
  { path: '/about', component: '/page/about.html', name: 'about', layout: 'default' },
  { path: '*', component: '/page/404.html', name: '404', layout: 'default' },
]
```

### 带钩子写法

```js
export default {
  routes: [
    { path: '/', component: '/page/index.html', name: 'home' },
  ],
  beforeEnter: async (to, from, next) => {},
  afterEnter: (to, from) => {},
}
```

### 推荐：工厂函数

如果路由钩子需要模块能力，推荐直接读取 `$scoped`：

```js
export default ({ $scoped, router }) => ({
  routes: [
    { path: '/', component: '/page/index.html', name: 'home' },
    { path: '/login', component: '/page/login.html', name: 'login' },
  ],
  beforeEnter: async (to, from, next) => {
    if (!$scoped.auth.isLogin() && to.path !== '/login') {
      next('/login')
      return false
    }
  },
})
```

推荐原则：

- 模块能力放 `env.js -> $scoped`
- 路由配置放 `routes.js`
- `beforeEnter/afterEnter` 在 `routes.js` 里消费 `$scoped`

不要反过来让 `env.js` 依赖 router。

## 多个 `vrouter`

同一个页面可以存在多个 `<vrouter>`：

```html
<div class="page">
  <vrouter routes="main_routes.js"></vrouter>
  <vrouter routes="sidebar_routes.js"></vrouter>
</div>
```

它们：

- 共享浏览器地址
- 各自维护自己的 routes
- 各自维护自己的 current/query/params/cache

这也是为什么 `$router` 必须是“最近祖先 router view”，而不是全局状态。

## cache page

路由支持缓存页。

例如：

```js
{ path: '/user/:id', component: '/page/user.html', cacheKey: 'user' }
```

语义：

- 相同 `cacheKey` 复用同一个页面实例
- 路由切换时触发 `deactive / active`
- 不会重新销毁重建

如果你明确不想缓存：

```js
{ path: '/edit/:id', component: '/page/edit.html', cacheKey: false }
```

## 什么时候会触发 `dispose`

### 会触发

- `v-if` 分支被切掉
- 组件宿主真正离开 DOM，且下一帧未挂回
- 非缓存页面被真实替换

### 不会触发

- cache page 切换
- DOM 临时搬移
- layout 内短暂摘下再插回

## 推荐写法

### 推荐 1：组件通信优先用 props + emit

父组件：

```html
<user-editor :user="user" @saved="reload"></user-editor>
```

子组件：

```html
<script setup>
  user = null
  save = async () => {
    $emit('saved')
  }
</script>
```

### 推荐 2：父调子时直接用 `ref.$data`

```html
<user-editor ref="editor"></user-editor>
```

```html
<script setup>
  editor = null

  saveAll = async () => {
    await editor.$data.save()
  }
</script>
```

### 推荐 3：模块能力放 `$scoped`

```js
export default async (env) => {
  env.auth = createAuth()
}
```

### 推荐 4：路由钩子从 `routes.js` 使用 `$scoped`

```js
export default ({ $scoped }) => ({
  routes: [...],
  beforeEnter: async () => {
    return $scoped.auth.check()
  },
})
```

## 不推荐写法

### 不推荐 1：把模块能力放到 `$env`

不要这样：

```js
$env.$axios = ...
$env.$t = ...
```

应该放进 `$scoped`。

### 不推荐 2：让 `env.js` 配置 router

不要这样：

```js
export default async (env) => {
  env.$router.beforeEnter = ...
}
```

router 钩子属于 `routes.js`。

### 不推荐 3：把 `v-if` 当缓存隐藏

`v-if` 当前语义更接近真实卸载。

如果你希望保留实例，不要指望 `v-if` 帮你缓存。

## 调试时怎么理解问题

遇到问题时，先分 4 类看：

1. 这是组件私有状态问题？
   看 `$data`

2. 这是父子上下文问题？
   看 `$env`

3. 这是模块能力问题？
   看 `$scoped`

4. 这是局部路由问题？
   看最近祖先 `$router`

这个划分基本就是 `vhtml` 当前设计的核心。

## 总结

如果只记 6 句话：

1. HTML 文件就是组件，也是页面。
2. 默认只有组件运行时，`vrouter` 只是特殊组件。
3. 真实 DOM 是唯一渲染目标，没有 VDOM。
4. `$data` 是实例状态，`$env` 是父子上下文，`$scoped` 是模块环境。
5. `env.js` 负责模块能力，`routes.js` 负责路由配置。
6. 父调子时直接用 `refNode.$data.xxx`。
