# vhtml v0.8.0 架构重构方案

## 目标

消除过度嵌套和冗余抽象，文件数从 17 降至 15，总行数从 ~5,300 降至 ~3,800。调用链从 4 层压至 2 层。

## 长期约束（不变）

### 1. 保持真实 DOM 运行时

- 不引入虚拟 DOM
- 不做整树 diff
- 不做 SSR / hydration
- HTML 文件就是页面，也是组件

### 2. 不回退到混合上下文

- `$data` — 实例私有状态
- `$env` — 父子组件上下文链（替代旧的 `$sys/$ctx` 混用）
- `$scoped` — 模块级上下文池
- `$router` — 最近祖先 router view

禁止把 `$axios/$t/$i18n`、router 状态、组件私有状态混回一个大 `env` 对象。

### 3. scoped 模块隔离边界

- 同 `scoped` 共享同一个 `$scoped`、`$axios`、`$i18n/$t`
- 不同 `scoped` 不串模块状态
- `env.js` 只负责模块级 `$scoped`
- `routes.js` 只负责 router view 级路由与钩子

### 4. 统一实例模型

普通组件、结构 boundary、router-view、page、layout 复用同一套 ComponentInstance 结构。不允许引入第二套 parent/children/runtime record。

### 5. DOM 只保留索引与宿主职责

`store.js`（原 `runtime/dom.js`）只承担：
- `dom -> instance` 索引
- 轻量桥接（`$data/$sys/$ctx/$mod/$router` 公开 API）
- 回收辅助

不把 DOM 当主状态容器，不大量直挂字段。

### 6. vrouter 是特殊组件

- 没有 `<vrouter>` 时 vhtml core 可独立工作
- Page/Layout 只属于 router 子系统
- 普通组件和 slot 不因 router 丢失独立语义

### 7. 不保留静默 fallback

- 加载失败直接报错
- 导航钩子出错直接暴露
- 不通过默认路由、占位页面、兼容桥静默吞错

---

## v0.8.0 重构任务

### 任务 1：拆分 vproxy.js → reactive.js + sandbox.js

两套完全不同的 Proxy 系统混在一个文件，职责不清。

**reactive.js**（响应式系统）：
- `Wrap(data)` — 响应式代理
- `Watch(target, fn)` — 依赖追踪
- `Cancel(id)` — 取消监听
- `ForceUpdate()` — 强制刷新
- `SetDataRoot(data, root)` — 设置数据根
- 内部：`callbackList`、`scheduleFrame`、`scheduleUpdate`、`flushUpdates`

**sandbox.js**（沙盒执行引擎）：
- `createScopeProxy(data, runtime, execArgs)` — 沙盒作用域代理（原 `newProxy`）
- `Run(code, data, runtime)` — 同步执行
- `AsyncRun(code, data, runtime)` — 异步执行
- 内部：`compileSandboxCode`、`executeSandboxCode`、`expose`

### 任务 2：dom.js → store.js，消除双存储

将 15 对 getter/setter（~200 行样板代码）替换为统一的 NodeStore 类。

**现状**：每个 setter 同时写 `instance.xxx` 和 `WeakMap`，getter 做 instance/WeakMap 双回落。

**目标**：单一 WeakMap 存储，ComponentInstance 不再冗余持有 metadata 副本。

```js
// store.js 统一接口
class NodeStore {
  #map = new WeakMap()
  
  get(node, key)            // 读
  set(node, key, value)     // 写
  ensure(node)              // 惰性创建
  resolve(node)             // 返回 { instance, scope, runtime }
  remove(node)              // 清理
  bindPublicAPI(node)       // 挂载 $data/$sys/$ctx/$mod/$router
}
```

`$data`/`$sys` 等 DOM 公开 API 保留，getter 内部委托给 store。

### 任务 3：去 vhtml 类转发方法，renderer.js 精简为纯函数

**现状**：11 个 vhtml 类方法只是 `return xxxRuntime(this, ...)`，runtime 函数第一行又调用 `resolveRuntime(this, ...)`。

**目标**：删除 vhtml 类，`parseDom` 变为纯函数 `compileNode(node, store)`。各 compiler 函数直接从 store 获取上下文，不需要 `renderer` 参数传递。

renderer.js 只保留：
- `bootstrapVhtml(target)` — 入口
- `ensureRendererRuntime()` — 全局样式、MutationObserver、vdelay 机制
- `compileNode(node, store)` — 根调度函数

### 任务 4：合并 attributes.js + structure.js → compiler.js

两个文件同属 DOM 编译职责，且各自重复定义了 `resolveRuntime`。

合并后导出：
- `compileElement(node, store)`
- `compileTextNode(node, store)`
- `compileAttrs(node, store)`
- `compileVfor(node, store)`
- `compileVif(nodes, store)`
- `handleEvent / handleStyle / handleBind` 等内部函数

`resolveRuntime` 统一为 `store.resolve(node)`，不再复制 4 份。

### 任务 5：合并 component.js + slots.js + scope.js + instance.js → component.js

四个文件围绕组件生命周期，互相紧密耦合。
- `instance.js` (61行) — ComponentInstance 类
- `scope.js` (119行) — ComponentScope 生命周期管理
- `slots.js` (174行) — 插槽解析
- `component.js` (219行) — 组件解析/挂载

合并后约 400 行，减少跨文件 import 链。

### 任务 6：合并 env.js + context.js → env.js

- 删除 `createRuntimeEnv`（等于 `createRuntimeContext` 的零价值包装）
- `createModuleContext` / `createSystemContext` / `createRuntimeContext` 并入 `env.js`
- `context.js` 删除

### 任务 7：合并 loader.js + vget.js → loader.js

- `vget.js` 全部 36 行都是 `return templateLoader.xxx()`，删除
- 调用者直接 `import { templateLoader } from './loader.js'`

### 任务 8：合并 vrouter.js + routes.js + navigation.js → router.js

- `navigation.js` (74行) 和 `routes.js` (144行) 都是 router 子系统内部模块，无需独立文件
- 消除 `#createSnapshot` 与 `#setRouterPath` 中的冗余深拷贝
- 抽离 `runRuntimeTreeLifecycle` 辅助函数
- 继续收 Page 与 RouterView 的辅助方法

### 任务 9：i18n.js 去 shared 全局存储

`shared` 对象作为全局消息仓库改为实例属性，每个 I18n 实例持有自己的消息表，逻辑更直观。

---

## 文件结构对比

```
v0.7.x (17 文件)                    v0.8.0 (15 文件)
─────────────────────────────       ─────────────────────────
src/                                src/
├── index.js                        ├── index.js
├── vproxy.js      (~515行)         ├── reactive.js    (~250行)
│                                   ├── sandbox.js     (~250行)
├── runtime/                        ├── store.js       (~120行)
│   ├── renderer.js  (~473行)       ├── renderer.js    (~250行)
│   ├── compiler.js  (新)           ├── compiler.js    (~500行)
│   ├── attributes.js(~377行)       │
│   ├── structure.js (~340行)       │
│   ├── component.js (~219行)       ├── component.js   (~400行)
│   ├── slots.js     (~174行)       │
│   ├── scope.js     (~119行)       │
│   ├── instance.js  (~61行)        │
│   ├── dom.js       (~373行)       │
│   ├── env.js       (~197行)       ├── env.js         (~150行)
│   ├── context.js   (~76行)        │
│   ├── loader.js    (~323行)       ├── loader.js      (~280行)
│   ├── routes.js    (~144行)       ├── router.js      (~500行)
│   ├── navigation.js(~74行)        │
│   ├── lifecycle.js (~72行)        ├── lifecycle.js   (~72行)
│   ├── imports.js   (~115行)       ├── imports.js     (~115行)
│   └── url.js       (~31行)        ├── url.js         (~31行)
├── vrouter.js      (~828行)        │
├── vbus.js         (~138行)        ├── vbus.js        (~80行)
├── vcss.js         (~565行)        ├── vcss.js        (~400行)
├── i18n.js         (~162行)        ├── i18n.js        (~120行)
├── vmessage.js     (~538行)        ├── vmessage.js    (~400行)
├── vget.js         (~36行)  ✘      ├── utils.js       (~200行)
└── utils.js        (~305行)        │
─────────────────────────────       ─────────────────────────
 总计 ~5,300 行                        总计 ~3,800 行
```

---

## 不变的部分

以下模块设计合理，v0.8.0 仅做轻量调整：

| 模块 | 调整 |
|---|---|
| 响应式核心 (Wrap/Watch/rAF) | 仅拆分文件，逻辑不变 |
| v-for/v-if/{{ }} 编译逻辑 | 仅移动位置到 compiler.js |
| CSS 作用域解析器 (vcss.js) | 基本不动 |
| 消息/通知 UI (vmessage.js) | 基本不动 |
| RouterView 缓存/布局机制 | 精简冗余，核心逻辑不变 |
| 生命周期脚本执行 (lifecycle.js) | 基本不动 |
| 动态 import 处理 (imports.js) | 基本不动 |
| 模板语法 (`:` `@` `v:` `ref`) | 完全不变 |

---

## 回归清单

每完成一个任务后至少验证：

- 普通组件嵌套
- 跨 scoped 模块页面切换
- v-if 销毁重建
- slot 插槽
- layout 布局
- cache page 缓存页
- 多 vrouter
- `$axios/$t/$i18n` 模块隔离
- `$data`/`$sys`/`$ctx`/`$mod`/`$router` DOM API 正常工作
