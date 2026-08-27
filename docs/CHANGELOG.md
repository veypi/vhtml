# 更新日志

本项目的所有重要变更都将记录在此文件中。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)，
并遵循 [语义化版本](https://semver.org/lang/zh-CN/spec/v2.0.0.html)。

## [0.9.2] - 2026-08-27

### 新增
- **`vhtml` 命令行工具（cli/vhtml）**：单一二进制，零 Go 代码即可开发 vhtml 应用。默认命令 `vhtml`（等同 `vhtml serve`）为当前 `./ui` 目录启动 dev server：静态服务直读磁盘、SPA 回退 `root.html`（每次请求重新渲染，`{{.scoped}}` 注入）、`/vhtml/` 前缀提供框架运行时（`--src` 切换 src 模块直读用于框架调试）、文件变更 live reload（SSE + 自动注入脚本）、`vhtml.config.json` 配置 API 代理表（类 vue devServer.proxy，支持路径正则重写与 WebSocket）。原独立 `v-i18n` 工具合并为子命令 `vhtml i18n scan/add`（参数不变，提示文案同步更新）。新增 `vhtml init` 脚手架命令生成最小项目骨架。配置加载遵循 vigo/flags 原生协议：flag > 环境变量 > `vhtml.config.json` > default 标签。

### 修复
- **结构指令模板源全局共享（内存泄漏级修复）**：`v-for` 的 `sourceNodes` 与 `v-if` 链的 `sourceBranches` 从「每个实例化点各驻留一份模板克隆」改为按内容（outerHTML）全局共享一份只读模板（LRU 上限 512 项）。修复前，长列表场景中驻留规模 = item 数 × 分支数 × 模板大小（如 40 条消息的聊天页，仅游离模板源即驻留约 1.9 万 DOM 节点，超过活 DOM 本身两倍）；修复后每种模板内容全局仅一份。源节点自提取起只用于 `cloneNode` 读取，共享安全。
- **编译器 meta 不再驻留子树深克隆**：删除 `compileNode` 写入 `meta.sourceNodes/sourceAttrs` 的死代码（历史 v-if 恢复残留，全库无读取方），消除 O(节点数×深度) 的二次方驻留；组件实例的 `sourceNodes` 槽模板快照改为局部变量直传，`ComponentInstance.sourceNodes` 字段移除。
- **插槽模板全局共享**：`createSlotContents` 的投影模板与 `createOutletState` 的 fallback 模板同样接入内容寻址共享缓存（源只读），消除每个组件实例一份插槽克隆的驻留。
- **模板描述符释放解析残留**：`processScripts` 提取脚本为纯数据记录（`{code, setup, active, deactive, dispose}`）不再驻留 `<script>` 元素；`parse()` 完成后置空 `descriptor.tmp` 与 `descriptor.heads`——此前每个模板常驻一个完整 DOMParser 文档骨架（节点数统计中 47+ 个文档的来源）。
- **setupRef 闭包驻留修复**：模板属性处理提取为模块级 `applyTemplateAttrs`，避免 `bodyClone`/`attrs` 被 setupRef 作用域内长寿命的 watch 闭包共享 context 提升而终生驻留（V8 闭包共享上下文语义）。

### 变更
- **RouterView 默认缓存 key**：默认 `cacheKey` 由 `fullPath`（含 query）改为纯 `path`，query 变化只更新路由状态（`updateRouter`）而不再重挂页面 DOM；`cacheKey: false` / string / function 语义不变。

## [0.9.0] - 2026-06-15

### 新增
- **vbus 跨模块事件广播**：新增 `$mod.$bus` 事件总线，支持模块间松散耦合通信，`$bus.emit()` / `$bus.on()` / `$bus.off()` API。
- **虚拟路由**：RouterView 重构为基于 history 栈的路由管理，统一路径解析逻辑，支持浏览器前进/后退与编程式导航的无缝衔接。
- **RouterView 调试日志**：通过 `localStorage.debug` 控制路由调试日志输出，包含路由前缀、routes 加载、跳转匹配、history 回放和页面组件加载路径。
- **$emit 内置事件名警告**：当组件 `$emit` 使用内置 DOM 事件名（如 `click`、`submit` 等）时输出控制台警告，防止与原生事件冲突。

### 变更
- **ES-only 构建输出**：构建产物切换为 ES module only，`package.json` entry 指向 `dist/vhtml.min.js`，移除 CommonJS 兼容。
- **VHTML 初始化 API 重写**：`Vhtml` 类重构初始化流程和响应式集成，`mount()` / `destroy()` 生命周期更清晰。
- **编译器资源 URL 解析重写**：静态资源 URL 统一按组件相对路径解析，`src`、`srcset`、`href` 等属性处理一致。
- **v-for key 解析改进**：优化列表渲染的 key 解析和 DOM 协调逻辑，减少不必要的 DOM 操作。
- **核心模块拆分**：compiler 和 component 从 core 中拆分为独立模块，职责更清晰。

### 修复
- **sandbox window 属性安全访问**：sandbox 模式下安全访问 `window` 属性并正确绑定方法，防止非法访问。
- **RouterView 缓存 key**：缓存 key 排除 hash fragment，避免 hash 变化导致不必要的视图重建。
- **页面 content instance**：修复页面渲染中 content instance 未正确附加到 layout 的问题。

## [0.8.3] - 2026-06-06

### 新增
- **unsafe 沙盒模式**：组件标记 `unsafe` 属性进入受限沙盒，传染所有子孙组件。restricted 下 `fetch` 仅限 scoped 内请求，禁止 `document`/`window`/`history`，不加载外部脚本，禁止 `import`。
- **`$mod.restrictedFetch`**：模块初始化时定义受限 fetch，unsafe 模式下自动使用。
- **组件别名（alias）机制**：`addAlias(prefix, baseUrl)` 将 HTML 标签前缀映射到 URL 路径，支持全局和 scoped 别名，`resolveComponentUrl` 自动解析。
- **`_scriptError` 错误标记**：`ComponentInstance` 新增 `_scriptError` 字段，生命周期脚本执行失败时记录错误信息，调用方可检查脚本是否成功。

### 变更
- **变量池优先级重构**：`$data → $mod → $sys → expose → execArgs → window`。
- **sandbox 双模式重构**：三级 expose（native/framework/global），unsafe bool 控制，统一编译缓存，去除模式字符串。
- **`$mod` 精简**：删除 `$axios`、`baseURL`、`origin`，保留 `scoped`、`$bus`、`$i18n`、`$t`、`fetch`、`restrictedFetch`。
- **删除 `$ctx`**：移除 `createCtxContext`、DOM `$ctx` getter、sandbox 中 `$ctx` 链。`createRuntimeContext` 仅返回 `{ $sys, $mod }`。
- **Object.defineProperty 写保护**：`$mod` 框架 key 通过 `writable: false` 锁定，替代 Proxy 封装层。
- **删除 `!` 前缀**：属性编译中移除已废弃的 `!` 前缀判断。
- **`router_prefix` 空字符串语义统一**：RouterView 路由前缀统一使用 `router_prefix`，静态资源不读取路由前缀。
- **静态资源 scoped 解析统一**：资源 URL 预处理和动态绑定统一按 `$mod.scoped` 加前缀，保留 `@`、`http(s)` 和 `//` 逃逸规则。
- **RouterView 绝对路径坐标系**：routes 表、`$router` 和 `<a>` 统一标准化为可见绝对路径后再匹配；`@/path` 跳过路由路径标准化，`http(s)` 链接保持原样。
- **RouterView 调试日志**：通过浏览器端 `localStorage.debug` 输出路由前缀、routes 加载、跳转匹配、history 回放和页面组件加载路径。
- **RouterView routes schema 前缀**：routes 模块支持 `path_prefix` / `component_prefix`；`path_prefix` 默认 vrouter 所在 `$mod.scoped`，`vrouter[prefix]` / `:prefix` 只写入 `$router.router_prefix` 并覆盖导航前缀。
- **`vrouter[:params]` 固定参数**：RouterView 支持注入固定 `$router.params`，页面、路由守卫 `to.params` 和 `component(path, params)` 动态组件路径函数同步可见，动态路由参数同名时覆盖固定参数。
- **RouterView 纯 path 导航**：移除 `{ name }` 导航和 routes 的 `name` / `description` 字段处理，路由匹配统一基于 path。
- **404 占位组件视觉增强**：从 1em 红色圆点改为可见错误块，日志级别从 warn 提升到 error。
- **`addAlias` 参数校验**：`baseUrl` 必须以 `/` 或 `https://` 开头，防止路径拼接错误。

### 修复
- **页面实例树泄漏**：`Page.deactive` 不再仅运行生命周期，同时将页面内容实例从父实例树断开（保留子树），防止 `runRuntimeTreeLifecycle` 遍历到旧页面实例导致多次激活。
- **`ModuleContextManager.clear()` alias 残留**：`clear()` 现在同时清空 `_aliasMap` 和 `_globalAliases`，防止重载模块时旧 alias 冲突。
- **`loadEnvConfig` base URL 防御**：增加 `mod.scoped &&` 空值保护，防止构建非法 URL。
- **`_scriptError` 追踪**：生命周期脚本失败时在实例上设置错误标记，替代静默吞异常。

### 移除
- `getModuleContext`、`getBaseURL`、`scopedBaseURL` — 未使用的导出函数。
- `ForceUpdate`、`clearNodeState`、`inferScopedFromUrl`、`scopedMarkerSegments` — 死代码。
- `hasProtocol`、`isHttpProtocol`、`isProxy` — 降为非导出内部函数。
- `patchModule` 方法 — 一行转发，调用方直接使用 `mergeModulePatch`。
- `moduleReservedKeys` — `lockProperty` 已覆盖保护需求。

## [0.8.2] - 2026-06-02

### 新增
- **i18n scan --autoremove**：`v-i18n scan` 新增 `--autoremove` 标志，默认关闭；开启后自动清理无用、空值和缺失的翻译键，未开启时显示警告及截断的键名列表。

### 变更
- **拆分资源 URL 与路由 href**：静态资源按 `$mod.scoped` 解析，`<a>` 跳转按所属 RouterView 的 `router_prefix` 解析。
- **srcset 属性支持**：新增 `resolveSrcset()` 处理 `<img srcset>` 属性的 URL 解析。
- **router prefix 集中化**：RouterView 统一处理路由前缀，组件通过 `$sys` 继承所属 `$router`。

### 修复
- **router push/replace 同步匹配**：`push()` 和 `replace()` 方法在导航前同步匹配路由，确保路径在导航前已正确解析。
- **RouterView 重复挂载**：`getOrCreateView` 仅挂载新创建的视图，不再每次访问都重新挂载。
- **router modulePath 回退**：当 `router_prefix` 不存在时回退到 `scoped` 路径。
- **i18n 响应式代理**：i18n 消息使用 reactive proxy 包装，支持变更检测。
- **异步操作空值安全**：`parseRef()` 和 `setupRef()` 在异步操作后增加空值检查，防止已销毁组件崩溃。
- **CLI app 初始化简化**：移除 `vigo.New()` 中未使用的 init 函数参数。

## [0.8.1] - 2026-05-21

### 新增
- **`<template>` 元素支持**：`<template>` 支持 `v-if`/`v-else-if`/`v-else` 和 `v-for` 指令，实现多根节点的条件渲染和列表渲染，DOM 中不留任何包装元素痕迹。
- **v-for 内 v-if 链支持**：`<template v-for>` 内的兄弟 `v-if`/`v-else` 节点正确编组为条件链。

### 变更
- **v-if/v-for 编译器重构**：条件链和列表渲染改用 `<!--~vif-->`/`<!--~vfor-->`/`<!--~vitem-->` 注释标记锚点替代 `<div>` 占位符，重排序和清理逻辑基于标记范围操作。
- **slot 空白节点过滤**：组件插槽解析时跳过纯空白文本节点，`<x></x>` 和 `<x>\n</x>` 行为一致。

### 修复
- **template 内容 vrefof 缺失**：`syncRefOwnerId` 遍历 DOM 时深入 `<template>.content` 片段，确保 scoped 样式和 slot 解析正确作用于 template 内部元素。
- **v-else/v-else-if 属性残留**：条件链编译时清除所有指令属性。

## [0.8.0] - 2026-05-21

### 新增
- **Vhtml 类框架入口**：`index.js` 新增 `Vhtml` 类管理框架生命周期，暴露 `mount()`、`destroy()`、`parseDom()`、`parseRef()` 公开方法，`window.$vhtml` 为全局单例实例。
- **路由 error_redirect**：路由配置新增 `error_redirect`，页面加载失败时自动跳转备用路由。
- **路由 component 函数参数**：`component` 函数第二个参数传入 `matchedRoute.params`。
- **scoped 模块 fetch 方法**：`$mod.fetch()` 自动处理 scoped URL 解析。
- **IMG scoped URL**：`<img>` 标签的 `src` 属性自动解析 scoped 路径。
- **链接 target="_blank"**：导航处理器支持 `target="_blank"`，自动 `window.open`。

### 变更
- **核心模块扁平化**：移除旧 `runtime/` 目录，核心模块（compiler、component、reactive、sandbox、router、loader）扁平化到 `src/`。
- **渲染器重构**：`renderer.js` 从全局副作用的 bootstrap 重构为纯 `createRenderContext` 工厂，MO/vdelay/样式交由 Vhtml 实例管理。
- **合并 component 模块**：组件系统（component.js + slots.js + scope.js + instance.js + store.js）合并为单一文件。
- **合并 compiler 模块**：编译器（attributes.js + structure.js）合并为单一文件。
- **统一 data-keep**：`data-vrouter-cache` 和 `data-vrouter-layout` 合并为 `data-keep` 属性。
- **i18n 消息隔离**：使用 bucket key 防止不同模块间消息键名冲突。
- **v-i18n 输出路径**：非默认入口时自动调整输出路径，修复扫描统计计数。

### 优化
- **沙盒代理原型链**：属性查找从 11 步链式 `if/in` 改为原型链查找，利用 V8 内联缓存加速表达式执行。

### 修复
- **MO 挂起机制**：组件解析时挂起 MutationObserver，防止重入突变导致渲染异常。
- **X-No-Fallback 请求头**：fetch 请求新增 `X-No-Fallback` 头，阻止服务端降级转发。
- **布局样式**：`vrouter` 新增 `height: 100%`、`overflow: auto`，修复布局滚动问题。
- **多行表达式**：`vproxy` 支持多行表达式编译，带 `return` 语句兜底。
- **移除 eval**：沙盒暴露全局中移除 `eval`，提升安全性。

### 移除
- 移除 `window.__VhtmlCtx__` 全局泄漏。
- 移除 `renderer.js` 中的 `bootstrapVhtml` 和 `createVhtmlApp`。
- 移除 `docs/usage.md` 过期文档。

## [0.7.4] - 2026-04-15

### 变更
- 重构 `v-i18n` CLI：精简为仅保留 `scan` 和 `add` 两个命令，支持固定顺序的 JSON 输出。
- 升级 `vigo` 依赖从 `v0.6.0` 到 `v0.6.5`，修复 `flags` API 兼容性问题。

### 修复
- 修复 `v-i18n scan` 输出指令，改为可直接复制执行的 `v-i18n add -json` 格式。

## [0.7.3] - 2026-04-15

### 变更
- 将 `v-i18n` CLI 版本号与根目录 `package.json` 统一，移除独立版本管理。
- 更新 `docs/agents.md` 中 `v-i18n` 的使用示例和安装说明。

## [0.7.2] - 2026-04-15

### 变更
- 重构运行时模块上下文和路由初始化逻辑。
- 规范化路由模块的默认导出处理。

## [0.7.1] - 2026-04-15

### 新增
- 路由系统新增尾部斜杠重定向，并防止重复导航。

### 变更
- 重构运行时变量池架构，采用四层模型。
- 重构 `v-for` 渲染逻辑，引入基于记录的缓存机制。
- 更新运行时变量池模型的相关文档。

### 修复
- 修复列表在空状态切换后的渲染恢复问题。
- 改进 `v-for` 正则表达式以兼容更多语法模式。

## [0.7.0] - 2026-03-14

### 变更
- 重构核心运行时架构（`refactor(core): Rebuild runtime architecture`）。

## [0.6.1] - 2026-03-11

### 新增
- 路由系统新增 `cacheKey` 支持，实现页面缓存和实例共享。
- 路由系统新增重定向支持，并分离字符串匹配与正则匹配逻辑。

### 变更
- 重写 `vget.js`，采用基于类的架构，并优化 `vproxy` 性能。
- 优化 `vproxy` 更新调度策略，增加代码缓存机制。
- 为 `vmessage` 的 CSS 类名添加 `vmsg-` 前缀，避免样式冲突。
- 更新项目依赖，并在 `vproxy` 中新增 `$watch` 辅助方法。

### 修复
- 修复 `cacheKey` 未被正确保存的问题。
- 路由系统新增可选参数支持。
- 修复 vhtml 文档中双向绑定 prop 的语法示例。

---

## 发布流程

本项目同时作为 **npm 包**（`@veypi/vhtml`）和 **Go module**（`github.com/veypi/vhtml`）发布。发版核心围绕 `src/` 源码和 `package.json`，`vhtml` CLI（`cli/vhtml`）作为辅助工具同步更新。

发布新版本时，请按以下步骤操作：

### 1. 更新版本号
- 更新 `package.json` 中的 `version` 字段。
- 同步更新 `cli/vhtml/main.go` 中的 `version` 变量（保持与 `package.json` 一致）。

### 2. 更新文档
- 如果 CLI 命令行为或用法有变化，更新 `cli/vhtml/README.md`。
- 如果 CLI 使用示例需要更新，同步修改 `SKILL.md`（仓库根，即原 docs/agents.md 迁移后的核心技能文件）。
- 在 `docs/CHANGELOG.md` 顶部新增一个版本章节，描述本次 `src/` 核心变更和发布内容。

### 3. 构建并更新 dist
```bash
npm run build
```
- 确保 `dist/` 目录下的产物已更新。
- 将 `dist/` 变更一并提交。

### 4. 本地测试
```bash
# 测试 vhtml 构建产物
npm run build

# 测试 vhtml CLI
go build -o vhtml ./cli/vhtml
go install github.com/veypi/vhtml/cli/vhtml
vhtml -h
```

### 5. 在 `dev` 分支提交变更
```bash
git checkout dev
git add package.json dist/ docs/CHANGELOG.md [其他变更文件]
git commit -m "chore(release): bump version to vX.Y.Z"
```

### 6. 将 `dev` 合并到 `main`
```bash
git checkout main
git merge dev
git push origin main dev
```

### 7. 创建并推送标签
```bash
git tag vX.Y.Z
git push origin vX.Y.Z
```

### 8. 发布到 npm
```bash
npm publish --access public
```

### 9. 验证远程安装（Go）
```bash
go clean -modcache
GOPROXY=https://goproxy.cn,direct GOSUMDB=off \
  go install github.com/veypi/vhtml/cli/vhtml@vX.Y.Z
vhtml -h
```

### 10. 切回 `dev` 分支
```bash
git checkout dev
```

### 注意事项
- Go module proxy 会永久缓存版本。如果某个标签有问题，**不要 force-push 同一个标签**。必须递增版本号重新打标签（例如 `v0.7.3` → `v0.7.4`）。
- `vhtml` CLI 的版本号必须始终与 `package.json` 保持同步。
- `cli/vhtml` 依赖 vigo 的新 API（contrib/proxy、flags JSON 配置）时，发版前必须确保 vigo 已打上包含对应改动的标签，并将 `go.mod` 的 vigo 版本提升到该标签，否则脱离 go.work 构建（go install）会失败。
- 每次发版必须确保 `dist/` 是最新构建的，因为 npm 发布以 `dist/` 为主要内容。
