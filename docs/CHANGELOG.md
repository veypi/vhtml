# 更新日志

本项目的所有重要变更都将记录在此文件中。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)，
并遵循 [语义化版本](https://semver.org/lang/zh-CN/spec/v2.0.0.html)。

## [0.7.5] - 2026-04-15

### 变更
- 升级 `vigo` 依赖从 `v0.6.0` 到 `v0.6.5`，修复 `flags` API 兼容性问题以支持远程安装。
- 重构 `v-i18n` CLI：精简为仅保留 `scan` 和 `add` 两个命令。
  - `scan`：自动排序、自动清理未使用/空值 key、报告缺失项、输出可直接复制执行的 `add -json` 命令。
  - `add`：支持通过管道、`-json` 参数或位置参数传入 JSON。
- 在 `v-i18n` 中实现自定义 JSON 序列化，确保输出顺序固定（`defaultLanguage` 排在最前面）。
- 更新 `docs/agents.md`，补充新的 `v-i18n` 使用示例和 `go install` 安装说明。

### 修复
- 修复因 `vigo` 版本解析不兼容导致的 `v-i18n` 远程安装失败问题。

## [0.7.4] - 2026-04-15

### 变更
- 将 `v-i18n` CLI 版本号和 `package.json` 对齐到项目统一版本。

## [0.7.3] - 2026-04-15

### 修复
- 修复 `v-i18n scan` 输出，改为 `v-i18n add -json` 以便直接复制粘贴执行。
- 同步 `ui/langs.json` 为最新扫描结果。

## [0.7.2] - 2026-04-15

### 变更
- 更新 `docs/agents.md` 中 `v-i18n` 的使用方式，改为使用 `-json` 参数。
- 将 `v-i18n` CLI 版本与根目录 `package.json` 保持一致。

## [0.7.1] - 2026-04-15

### 变更
- 移除 `v-i18n` 的独立版本号，统一以根目录 `package.json` 版本为准。
- 删除旧的 `v-i18n/v0.2.0` 标签，创建全局 `v0.7.1` 标签。

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
