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

## 运行时变量池

表达式解析优先级固定为：

```text
$data → $mod → $sys → expose → execArgs → window
```

### `$data`

当前组件实例私有状态。来源：`<script setup>` 的裸赋值、props 映射。生命周期跟组件实例一致。

### `$mod`

模块级上下文池。由 `scoped` 唯一标识，同 `scoped` 下所有组件共享同一个 `$mod`，不沿组件树继承。

框架定义的不可变 key（通过 `Object.defineProperty` 锁定 writable: false）：

| key | 说明 |
|-----|------|
| `scoped` | 模块路径前缀，如 `/page`，根模块为 `""` |
| `$bus` | 模块级 EventBus |
| `$i18n` | I18n 实例 |
| `$t(key, params)` | 翻译函数 |
| `fetch(url, options)` | scoped fetch，相对路径自动加 scoped 前缀 |
| `restrictedFetch` | unsafe 模式专用受限 fetch |

后端可通过 `vhtml-*` 响应头注入自定义配置到 `$mod`（如 `vhtml-app` → `$mod.app`）。

### `$sys`

系统变量池，通过 `Object.create(parent.$sys)` 原型继承：

| key | 说明 |
|-----|------|
| `$router` | 最近祖先 `<vrouter>` 的 RouterView 代理 |
| `$emit(event, ...args)` | 向父组件发送自定义事件 |
| `$message` | 全局 toast / dialog API |

### `$router`

不属于 `$mod`，代表"当前组件最近祖先 `<vrouter>` 对应的 RouterView"。同一模块内多个 `<vrouter>` 各自维护自己的 `$router`。

### expose

sandbox 内置 API 分层：

| 层级 | 内容 |
|------|------|
| native | `console`, `Math`, `Date`, `JSON`, `Array`, `Object`, `parseInt`, `parseFloat`, `RegExp`, `TextDecoder` 等 |
| framework | `alert`, `prompt`, `confirm`, `setTimeout`, `setInterval`, `clearTimeout`, `clearInterval`, `requestAnimationFrame` |
| global | `window`, `document`, `history`, `fetch`(原生), `btoa`, `getComputedStyle` |

## 沙盒执行引擎

sandbox.js 基于 `with + Proxy` 实现：

- `createScopeProxy(data, runtime, execArgs, options)` 创建沙盒作用域
- `options.unsafe` 或 `runtime.__unsafe` 控制模式：`false` 时暴露 global 层，`true` 时仅 native + framework 层且无 window 兜底
- 原型链：`expose → execArgs`，execArgs 携带 `$node`/`$watch`/`$scope`/`$event` 等执行上下文
- `Run(code, data, runtime, execArgs, options)` — 同步表达式
- `AsyncRun(code, data, runtime, execArgs, options)` — 异步脚本

## unsafe 沙盒

组件标记 `unsafe` 属性后进入受限模式，**传染所有子孙组件**。

传染路径：`parseRef` 检查 `dom.hasAttribute('unsafe') || parentInstance?.unsafe`，设置 `instance.unsafe = true` 和 `componentRuntime.__unsafe = true`。compiler 中 `Run()` 调用通过 `runtime.__unsafe` 自动感知模式。

受限内容：

- `fetch` → `$mod.restrictedFetch`，拒绝外部 URL 和跨 scoped 请求
- `document` / `window` / `history` 从 expose 移除，无 window fallback
- 外部 `<script src="...">` 不加载（loader.js `loadHeads` 跳过）
- `<script setup>` 中 `import` 移除（imports.js）
- `$mod` 框架 key 通过 `Object.defineProperty(writable: false)` 锁定，`$mod.scoped = 'x'` 静默失败

## 模块上下文

### `env.js`

每个模块可提供 `{scoped}/env.js`，由 `ModuleContextManager` 在首次访问时加载一次。

```js
export default async ($mod, manager) => {
  // 加载模块配置
  const config = await $mod.fetch('/config.json').then(r => r.json())
  $mod.config = config
  // 加载翻译
  $mod.$i18n.load(await $mod.fetch('/langs.json').then(r => r.json()))
}
```

- `env.js` 属于模块入口，不属于组件实例
- 不承担 router 钩子、组件私有状态、router 配置

### `routes.js`

只有在页面里使用 `<vrouter>` 时加载 `{scoped}/routes.js`。

支持三种导出形式：

```js
export default [...]                                       // 数组
export default { routes, beforeEnter, afterEnter }         // 对象  
export default ({ $mod, router }) => ({ routes, ... })     // 工厂
```

路由字段：`path`(必填)、`component`(必填)、`layout`、`meta`、`children`、`cacheKey`、`error_redirect`。

### scoped 语义

`scoped` 是模块资源根路径，也是模块隔离边界。同 `scoped` 共享同一个 `$mod`（`$bus`、`$i18n`、`$t`、`fetch`），不同 `scoped` 之间完全隔离。

## 统一实例模型

### ComponentInstance

```text
host: DOM 元素
kind: 'component' | 'boundary' | 'page' | 'layout' | 'slot-outlet'
parent: 父实例
children: Set<子实例>
scope: ComponentScope (生命周期管理)
runtime: { $sys, $mod }
data: 响应式数据 (Wrap 对象)
vsrc: 组件源 URL
events: 自定义事件回调表
slotContents: 插槽内容
sourceNodes: 原始子节点快照 (v-if 恢复用)
vforData: v-for 当前迭代数据
slotOutletState: 插槽出口状态
unsafe: bool (沙盒模式标记)
```

### DOM 接口

`nodeInst` WeakMap 索引，`setInstance()` 绑定后 DOM 暴露三个 getter：

```js
node.$data  // → instance.data
node.$sys   // → instance.runtime.$sys
node.$mod   // → instance.runtime.$mod
```

`nodeMeta` WeakMap 存储元素级元数据（sourceNodes、vforData、slotOutletState、parsed）。

### ComponentScope

生命周期管理：`cleanups` 清理列表、`timers`/`intervals` Set、`lifecycle` hook 数组（active/deactive/dispose）。

`setTimeout`/`setInterval`/`addEventListener` 自动注册到 scope，dispose 时自动清理。

## 组件编译管线

```
fetchUI(url)
  → DOMParser 解析 HTML
  → processStyles (CSS scoping)
  → processBody (提取 body)
  → processScripts (分类 script: setup / lifecycle)
  → loadHeads (加载 link/script/style)

parseRef(vsrc, dom, data, runtime, target, options)
  → ComponentInstance 创建
  → setInstance 绑定 DOM
  → fetchUI 获取模板
  → createRuntimeContext 创建 runtime
  → setupRef:
      → AsyncRun 执行 <script setup>
      → props/attrs 合并 (:, v:)
      → slot 内容捕获
      → body clone 插入 DOM
  → compileNode 递归编译
  → mountRef 注册生命周期脚本
  → scope.activate()
```

### compileNode 编译顺序

1. `<template>` → v-for 多根 或 解包子节点
2. 自定义元素 (含 `-`) → `parseRef` 子组件
3. `:vsrc` → 动态组件（响应式）
4. `vsrc` → 静态组件
5. `v-html` → 动态 innerHTML
6. `vslot` → 插槽出口
7. `vrouter` → 路由挂载
8. `<select>` → 先子元素再属性
9. 其他 → `compileAttrs` + 子节点递归

### v-for + v-if 同节点

`compileVfor` 先移除 `v-for` 并克隆 sourceNodes（保留 `v-if`），然后 `compileVif` 处理每个克隆。所以 `v-for` 先执行生成逐项克隆，`v-if` 再过滤。

## 响应式系统

`Wrap(data)` 创建递归 Proxy：

- get：记录监听 tag → 依赖收集
- set：值变化 → rAF 批量调度 watcher 回调
- 数组/map 原地更新（copyBind 保留现有绑定）
- `Watch(target, callback)` 订阅依赖变化
- `Cancel(id)` 取消监听

## slot 设计

两层模型：

- 父组件 `createSlotContents` 捕获子节点为 `slotContents`
- 子组件 `<vslot>` 渲染 projected content 或 fallback

projected content 使用调用方 runtime（`$data`/`$sys`/`$mod`），fallback 使用子组件 runtime。

## router 设计

`vrouter` 是特殊组件。`RouteMatcher` 负责路径匹配，`RouterView` 负责页面渲染与缓存，history adapter 负责浏览器或虚拟地址栈。

默认 `<vrouter></vrouter>` 使用 `window.location` 和 `window.history`。`<vrouter history="memory" initial="/list"></vrouter>` 创建独立虚拟地址栈，不改浏览器地址和全局 `document.title`。`<vrouter history="panelA"></vrouter>` 使用通过 `registerRouterHistory` 注册的命名 history。

`routes` 可以是路由模块地址，也可以通过 `:routes` 直接绑定路由表数组或 `{ routes, path_prefix, component_prefix, beforeEnter, afterEnter }` 对象。`path_prefix` 在注册 routes 时加到每个 `route.path` 前面，默认是 vrouter 所在 `$mod.scoped`，显式设为 `''` 表示不加路径前缀；`component_prefix` 在注册 routes 时加到 `route.component` 前面，默认不加。

`vrouter[:params]` 用来注入固定 `$router.params`，页面运行时、路由守卫 `to.params` 和 `component(path, params)` 动态组件路径函数都能读取。固定参数不参与 URL 标准化或路由匹配；匹配得到的动态参数优先级更高，同名时覆盖固定参数。

`vrouter[prefix]` / `vrouter[:prefix]` 只写入 `$router.router_prefix`，用于覆盖导航前缀，不参与 routes 注册。导航标准化优先级是 `$router.router_prefix > 发起方 $mod.router_prefix > 发起方 $mod.scoped`。

静态资源的预处理和运行时动态绑定使用同一套 `$mod.scoped` 前缀规则；`@`、`http://`、`https://` 和 `//` 地址不加 scoped 前缀。

RouterView 内部统一使用 `/` 开头的绝对路径。routes 表按 `path_prefix` 标准化；`$router.push()`、`$router.replace()` 和 `<a href>` 按导航前缀优先级标准化成最终可见路径，再进行匹配、active 标记和 history 写入。`@/path` 跳过路由路径标准化，去掉 `@` 后直接作为绝对路径；`http://`、`https://` 链接保持原样，不被 RouterView 拦截。

虚拟 RouterView 通过 `$sys` 向子孙运行时注入裸变量 `location` 和 `history`。组件中访问 `location`/`history` 时先命中所属 vrouter 的虚拟变量；不在虚拟 vrouter 内时，沙盒继续穿透到 `window.location`/`window.history`。

`<a>` 在编译时绑定最近的 RouterView，全局 click 拦截只处理已经绑定 RouterView 的链接。

每页 `Page` 有 `mount/deactive/active/destroy` 生命周期，layout 通过 vslot outlet 承载 page。

## 源码结构

```
src/
├── index.js       # Vhtml 入口类（MutationObserver、vdelay、挂载/销毁）
├── sandbox.js     # 沙盒执行引擎（with + Proxy）
├── reactive.js    # 响应式系统（Wrap/Watch/rAF 批量更新）
├── compiler.js    # DOM 编译器（指令、插值、组件引用）
├── component.js   # 组件系统（实例、scope、slots、parseRef）
├── env.js         # 模块上下文（ModuleContextManager、scoped）
├── loader.js      # 模板加载器（fetch、parse、缓存）
├── lifecycle.js   # 生命周期脚本执行
├── imports.js     # import 解析（script setup）
├── renderer.js    # 渲染上下文工厂（ctx 胶水对象）
├── router.js      # 客户端路由（RouteMatcher、RouterView、NavigationRuntime）
├── vcss.js        # CSS scoping 解析器
├── vbus.js        # EventBus
├── i18n.js        # 国际化
├── vmessage.js    # toast/dialog
├── utils.js       # DOM 工具（SetAttr、BindInputDomValue 等）
├── url.js         # URL 工具
```

## 设计约束

- 不回退到虚拟 DOM 或整树 diff
- 不把 DOM 当主状态容器
- 不为 router 污染普通组件和 slot 语义
- 模块间 `$mod` 完全隔离
- `$sys` 原型继承，`$mod` 共享引用
