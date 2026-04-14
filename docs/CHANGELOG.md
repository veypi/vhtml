# 更新日志

本项目的所有重要变更都将记录在此文件中。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)，
并遵循 [语义化版本](https://semver.org/lang/zh-CN/spec/v2.0.0.html)。

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
- 重构运行时模块上下文和路由初始化逻辑（`refactor(runtime): Restructure module context and routing initialization`）。
- 规范化路由模块的默认导出处理（`fix(router): Normalize routes module with default export handling`）。

## [0.7.1] - 2026-04-15

### 新增
- 路由系统新增尾部斜杠重定向，并防止重复导航（`feat(router): Add trailing slash redirect and prevent duplicate navigation`）。

### 变更
- 重构运行时变量池架构，采用四层模型（`refactor(runtime): Rebuild variable pool architecture with four-layer model`）。
- 重构 `v-for` 渲染逻辑，引入基于记录的缓存机制（`refactor(runtime): Restructure v-for rendering with record-based cache`）。
- 更新运行时变量池模型的相关文档。

### 修复
- 修复列表在空状态切换后的渲染恢复问题（`fix(runtime): Restore list rendering after empty state switch`）。
- 改进 `v-for` 正则表达式以兼容更多语法模式（`fix(runtime): Improve v-for regex to handle various syntax patterns`）。

---

## 发布流程

发布新版本时，请按以下步骤操作：

### 1. 更新版本号
- 更新 `package.json` 中的 `version` 字段。
- 同步更新 `cli/v-i18n/main.go` 中的 `version` 变量。

### 2. 更新文档
- 如果命令行为或用法有变化，更新 `cli/v-i18n/README.md`。
- 如果 `v-i18n` 使用示例需要更新，同步修改 `docs/agents.md`。
- 在 `docs/CHANGELOG.md` 顶部新增一个版本章节，描述本次发布内容。

### 3. 本地构建并测试
```bash
cd cli/v-i18n
go build -o v-i18n .
go install .
v-i18n -h
```

### 4. 在 `dev` 分支提交变更
```bash
git checkout dev
git add package.json cli/v-i18n/main.go docs/CHANGELOG.md [其他变更文件]
git commit -m "chore(release): bump version to vX.Y.Z"
```

### 5. 将 `dev` 合并到 `main`
```bash
git checkout main
git merge dev
git push origin main dev
```

### 6. 创建并推送标签
```bash
git tag vX.Y.Z
git push origin vX.Y.Z
```

### 7. 验证远程安装
```bash
go clean -modcache
GOPROXY=https://goproxy.cn,direct GOSUMDB=off \
  go install github.com/veypi/vhtml/cli/v-i18n@vX.Y.Z
v-i18n -h
```

### 8. 切回 `dev` 分支
```bash
git checkout dev
```

### 注意事项
- Go module proxy 会永久缓存版本。如果某个标签有问题，**不要 force-push 同一个标签**。必须递增版本号重新打标签（例如 `v0.7.3` → `v0.7.4`）。
- `v-i18n` CLI 的版本号必须始终与 `package.json` 保持同步。
