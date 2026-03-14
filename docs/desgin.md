# vhtml 设计文档

## 框架定位

`vhtml` 是一个纯浏览器端、基于 HTML 文件约定的轻量运行时。

核心前提：

- 不做 SSR
- 不做 hydration
- 不引入虚拟 DOM
- 真实 DOM 是唯一渲染目标
- 一个 `.html` 文件既可以是页面，也可以是组件
- 默认只有 HTML 组件渲染能力
- `vrouter` 是可选特殊组件，不是基础前提

例如：

```html
<a-b-c-d></a-b-c-d>
```

会被解析为：

```text
/a/b/c/d.html
```

运行时加载该 HTML，处理 `head/style/body/script setup/script`，并把结果挂到当前宿主节点。

## 当前运行时分层

### 1. vhtml core

基础运行时不依赖 router，负责：

- 组件路径解析与 HTML 加载
- 组件实例创建与销毁
- `script setup`、普通 `script`、生命周期脚本执行
- 指令解析：`v-if`、`v-for`、`vslot`、`:attr`、`@event`、`v:prop`
- slot 渲染
- 真实 DOM 更新

### 2. 上下文系统

当前运行时围绕 3 层上下文工作：

- `$data`
- `$env`
- `$scoped`

这是组件运行、模块隔离、router 局部化的核心边界。

### 3. NavigationRuntime

全局地址事件源，负责：

- 监听浏览器地址变化
- 拦截站内链接点击
- `push / replace / go / back / forward`
- 广播导航事件

它不负责页面渲染。

### 4. RouterView

每个 `<vrouter>` 对应一个局部 `RouterView`。

负责：

- 加载自己的 routes 模块
- 解析当前地址
- 渲染自己的 page/layout
- 管理自己的 page cache
- 维护自己的当前路由状态

同一页面可以存在多个 `<vrouter>`，它们共享浏览器地址，但各自维护自己的匹配结果和缓存。

## 上下文模型

### `$data`

当前组件实例私有状态。

来源：

- `<script setup>` 中定义的变量
- 组件方法
- props 映射结果

特点：

- 只属于当前实例
- 不向子组件自动继承
- 生命周期跟组件实例一致

### `$env`

父子组件上下文链。

来源：

- 父组件显式传递
- 运行时创建子组件时基于父组件派生
- 组件运行时显式写入

特点：

- 表示组件树上下文
- 适合页面、布局、局部业务上下文
- 不承担模块能力

### `$scoped`

模块级上下文池。

来源：

- 由 `scoped` 唯一标识
- 同一个 `scoped` 共享同一个 `$scoped`
- 不沿组件树继承

特点：

- 是模块级单例
- 只按模块隔离
- 保存模块能力与模块资源

当前模块能力都从 `$scoped` 暴露：

- `$axios`
- `$i18n`
- `$t`
- `$bus`
- `$message`

## 模块入口文件规范

### `env.js`

每个模块可以提供：

```text
/$scoped/env.js
```

例如：

```text
/aic/env.js
```

当前加载位置与实现见：

[`src/runtime/env.js`](/Users/veypi/vyes/vhtml/src/runtime/env.js)

当前语义：

- `env.js` 属于模块入口，不属于组件实例
- 运行时在创建 `$scoped` 时加载一次
- 默认导出应为一个函数
- 函数签名为：

```js
export default async (env, manager) => {}
```

其中：

- `env` 是当前模块的 `$scoped`
- `manager` 是模块环境管理器

当前 `env.js` 允许做的事：

- 初始化模块级 `$axios`
- 初始化模块级 `$i18n`
- 注册模块级 `$bus` / `$message` 包装
- 写入模块配置到 `$scoped`
- 基于模块需求补充额外模块能力

当前 `env.js` 不应该再承担的职责：

- 配置 router 钩子
- 操作局部 `$router`
- 注入组件实例私有状态
- 依赖父组件 `$env`

也就是说：

- router 配置属于 `routes.js`
- 组件树上下文属于 `$env`
- 模块能力属于 `env.js -> $scoped`

### `routes.js`

只有在页面里使用 `<vrouter>` 时，运行时才会加载：

```text
/$scoped/routes.js
```

当前 `routes.js` 设计上应该支持 4 种形式：

```js
export default [...]
```

```js
export const routes = [...]
export const beforeEnter = async () => {}
export const afterEnter = () => {}
```

```js
export default {
  routes: [...],
  beforeEnter,
  afterEnter,
}
```

```js
export default ({ $scoped, router }) => ({
  routes: [...],
  beforeEnter,
  afterEnter,
})
```

其中：

- `routes` 定义当前 router view 的路由表
- `beforeEnter / afterEnter` 是当前 router view 的局部钩子
- 这些钩子不应再通过 `env.js` 注入

推荐语义：

- `env.js` 只负责初始化模块级 `$scoped`
- `routes.js` 负责消费 `$scoped` 并产出 router view 配置

也就是说，模块里需要给 `beforeEnter / afterEnter` 使用的能力，应先放进 `$scoped`，再由 `routes.js` 使用，而不是让 `env.js` 反向依赖 router。

推荐上下文形态：

```js
export default ({ $scoped, router }) => ({
  routes: [...],
  beforeEnter: async (to, from, next) => {
    if (!$scoped.auth.isLogin()) {
      next('/login')
      return false
    }
  },
})
```

这里：

- `$scoped` 用于读取模块级能力
- `router` 表示当前 `RouterView`

当前设计约束：

- `routes.js` 可以依赖 `$scoped`
- `env.js` 不应接收 router 参数
- router view 级逻辑留在 `routes.js`
- 模块级能力留在 `env.js`

### `$router`

`$router` 不属于 `$scoped`。

它代表“当前组件最近祖先 `<vrouter>` 对应的 `RouterView`”。

当前语义：

- 同一模块内多个 `<vrouter>` 可以各自提供不同的 `$router`
- 组件脚本、生命周期脚本、链接激活态都优先使用最近祖先 router view
- `$router.push()` 最终仍回到全局 `NavigationRuntime`，再广播给各个 router view

## `scoped` 的语义

`scoped` 是模块资源根路径，也是模块前后端资源隔离边界。

例如模块挂在：

```text
/aic
```

则该模块下资源约定为：

- HTML：`/aic/page/**/*.html`、`/aic/layout/**/*.html`、`/aic/local/**/*.html`
- env：`/aic/env.js`
- routes：`/aic/routes.js`
- i18n：`/aic/langs.json`
- API：`/aic/api/**`

同一个 `scoped` 当前共享：

- 同一个 `$scoped`
- 同一个模块 `$axios`
- 同一个模块 `$i18n`
- 同一个模块 `$t`

不同 `scoped` 之间必须隔离：

- 模块环境
- `$axios.baseURL`
- i18n 资源
- 模块配置

## 统一实例模型

当前运行时已经收敛到统一实例模型。

统一实例定义见：

[`src/runtime/instance.js`](/Users/veypi/vyes/vhtml/src/runtime/instance.js)

当前实例字段包括：

- `host`
- `kind`
- `parent`
- `children`
- `vsrc`
- `data`
- `env`
- `scoped`
- `router`
- `route`
- `cacheKey`
- `scope`
- `slots`
- `slotOutletState`
- `sourceNodes`
- `vforData`
- `events`
- `parsed`
- `meta`

### 当前实例类型

当前运行时已经把这些对象都纳入统一实例结构：

- 普通组件实例：`kind = 'component'`
- 结构边界实例：`kind = 'boundary'`
- router view 实例：`kind = 'router-view'`
- page 实例：`kind = 'page'`
- layout 实例：`kind = 'layout'`

实例不是虚拟 DOM 节点，只是轻量运行时句柄。

它负责承载状态、作用域、父子关系和运行时资源，不做 diff。

## DOM 状态层

当前 DOM 侧只保留 `WeakMap` 索引层。

见：

[`src/runtime/dom.js`](/Users/veypi/vyes/vhtml/src/runtime/dom.js)

职责：

- `dom -> instance` 索引
- 运行时状态桥接
- 释放实例子树

当前主路径已经不再把 `$env/$scope/$router/$ref` 这类字段直接挂回 DOM 作为核心设计。

## 生命周期

### `setup`

对应 `<script setup>`。

- 实例创建时执行一次
- 初始化 `$data`
- 不要求 DOM 已挂载

### `mount`

对应普通 `<script>`。

- 初次挂载后执行一次
- 适合访问 `$node`

### `active`

对应 `<script active>`。

- 每次进入激活态执行

### `deactive`

对应 `<script deactive>`。

- 实例保留但离开活跃态时执行

### `dispose`

对应 `<script dispose>`。

- 实例真正销毁时执行一次

### 当前触发语义

- `v-if / v-else / v-else-if` 切掉的分支视为卸载，通常会触发 `dispose`
- page cache 切换只触发 `deactive / active`
- DOM 临时搬移不等价于销毁
- 只有节点离开 DOM 且下一帧仍未挂回，才真正销毁

## 指令与结构能力

当前基础能力包括：

- 文本插值 `{{ }}`
- `:attr`
- `:class`
- `:style`
- `@event`
- `v:prop`
- `v-if / v-else-if / v-else`
- `v-for`
- `vslot`
- `v-html`
- `:vsrc / vsrc`

### 结构边界

当前 `v-if` 和 `v-for` 根节点已经显式创建 boundary instance。

这意味着：

- 结构子树有明确的 `scope`
- 结构子树里的 watcher 不再只是依赖父 DOM 链
- 嵌套组件、slot、router 上下文能沿实例边界继续传递

## slot 设计

当前 slot 已经从旧的 `refSlots/originContent/slotHash` 模式重构为明确的两层：

- 父组件提供 `slotContents`
- 子组件 `<vslot>` 作为 outlet 渲染 projected content 或 fallback content

当前特性：

- 支持默认 slot 与命名 slot
- 支持 `vbind`
- fallback content 独立保存
- router outlet 与普通 slot 已经分离

## router 设计

`vrouter` 是特殊组件，不是全局应用对象。

当前入口：

```html
<vrouter></vrouter>
<vrouter routes="/admin_routes.js"></vrouter>
<vrouter routes="./sidebar_routes.js"></vrouter>
```

当前规则：

- 未设置 `routes` 时，默认加载 `$scoped/routes.js`
- 每个 `<vrouter>` 都有自己的 `RouterView`
- `RouterView` 维护自己的 routes、current、history、page cache
- `NavigationRuntime` 只负责地址广播

### 当前 page/layout 结构

当前 page 和 layout 都已经进入统一实例模型：

- `Page.instance`
- `Page.layoutInstance`

`Page` 自己更像围绕实例工作的控制器，而不是状态容器。

当前 page 实例 meta 已承载：

- `htmlPath`
- `title`
- `titleWatchers`
- `didInitialActivation`
- `layoutOutlet`

## 当前源码结构

运行时已拆分为这些主要模块：

- [`src/runtime/context.js`](/Users/veypi/vyes/vhtml/src/runtime/context.js)
- [`src/runtime/env.js`](/Users/veypi/vyes/vhtml/src/runtime/env.js)
- [`src/runtime/loader.js`](/Users/veypi/vyes/vhtml/src/runtime/loader.js)
- [`src/runtime/dom.js`](/Users/veypi/vyes/vhtml/src/runtime/dom.js)
- [`src/runtime/instance.js`](/Users/veypi/vyes/vhtml/src/runtime/instance.js)
- [`src/runtime/scope.js`](/Users/veypi/vyes/vhtml/src/runtime/scope.js)
- [`src/runtime/lifecycle.js`](/Users/veypi/vyes/vhtml/src/runtime/lifecycle.js)
- [`src/runtime/attributes.js`](/Users/veypi/vyes/vhtml/src/runtime/attributes.js)
- [`src/runtime/structure.js`](/Users/veypi/vyes/vhtml/src/runtime/structure.js)
- [`src/runtime/slots.js`](/Users/veypi/vyes/vhtml/src/runtime/slots.js)
- [`src/runtime/component.js`](/Users/veypi/vyes/vhtml/src/runtime/component.js)
- [`src/runtime/navigation.js`](/Users/veypi/vyes/vhtml/src/runtime/navigation.js)
- [`src/runtime/routes.js`](/Users/veypi/vyes/vhtml/src/runtime/routes.js)
- [`src/runtime/renderer.js`](/Users/veypi/vyes/vhtml/src/runtime/renderer.js)
- [`src/vrouter.js`](/Users/veypi/vyes/vhtml/src/vrouter.js)

## 当前设计约束

- 不回退到单体 `index.js` 运行时
- 不回退到混合 `env`
- 不回退到 DOM 侧挂字段作为主状态模型
- 不为 router 污染普通组件和 slot 语义
- 不为了兼容旧行为继续保留静默 fallback
