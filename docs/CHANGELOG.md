# 更新日志

本项目的所有重要变更都将记录在此文件中。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)，
并遵循 [语义化版本](https://semver.org/lang/zh-CN/spec/v2.0.0.html)。

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

本项目同时作为 **npm 包**（`@veypi/vhtml`）和 **Go module**（`github.com/veypi/vhtml`）发布。发版核心围绕 `src/` 源码和 `package.json`，`v-i18n` 仅作为辅助 CLI 工具同步更新。

发布新版本时，请按以下步骤操作：

### 1. 更新版本号
- 更新 `package.json` 中的 `version` 字段。
- 同步更新 `cli/v-i18n/main.go` 中的 `version` 变量（保持与 `package.json` 一致）。

### 2. 更新文档
- 如果 `v-i18n` 命令行为或用法有变化，更新 `cli/v-i18n/README.md`。
- 如果 `v-i18n` 使用示例需要更新，同步修改 `docs/agents.md`。
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

# 测试 v-i18n
cd cli/v-i18n
go build -o v-i18n .
go install .
v-i18n -h
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
  go install github.com/veypi/vhtml/cli/v-i18n@vX.Y.Z
v-i18n -h
```

### 10. 切回 `dev` 分支
```bash
git checkout dev
```

### 注意事项
- Go module proxy 会永久缓存版本。如果某个标签有问题，**不要 force-push 同一个标签**。必须递增版本号重新打标签（例如 `v0.7.3` → `v0.7.4`）。
- `v-i18n` CLI 的版本号必须始终与 `package.json` 保持同步。
- 每次发版必须确保 `dist/` 是最新构建的，因为 npm 发布以 `dist/` 为主要内容。
