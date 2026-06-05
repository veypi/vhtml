# vhtml 开发计划

## v0.9.0 计划

> 待定。

---

## 长期计划

- 暗色模式支持（global.css CSS 变量体系已具备结构，待追加 `prefers-color-scheme` 适配）
- 单元测试覆盖
- TypeScript 类型声明

---

## 版本发布步骤

1. **改版本号** — 更新以下 4 处：
   - `package.json` → `version`
   - `ui/page/about.html` → 页面显示的版本号
   - `cli/v-i18n/main.go` → CLI version 常量
   - `docs/CHANGELOG.md` → 将 `[Unreleased]` 改为版本号 + 日期

2. **更新 TODO.md** — 删除已实现内容，置空下一个版本计划

3. **构建** — `npm run build`

4. **提交** — `git add` + `git commit`（conventional commit 格式）

5. **打标签** — `git tag -a vX.Y.Z -m "vX.Y.Z: <简述>"`

6. **合并到 main** — `git checkout main && git merge dev`

7. **推送** — `git push origin main --tags`

8. **发布** — `npm publish`

9. **切回 dev** — `git checkout dev`

---

## 长期约束

### 1. 保持真实 DOM 运行时

- 不引入虚拟 DOM
- 不做整树 diff
- 不做 SSR / hydration
- HTML 文件就是页面，也是组件

### 2. 统一实例模型

普通组件、结构 boundary、router-view、page、layout 复用同一套 ComponentInstance 结构。

### 3. scoped 模块隔离边界

- 同 scoped 共享 `$scoped`、`$i18n/$t`
- 不同 scoped 不串模块状态
- `env.js` 负责模块级配置
- `routes.js` 负责路由与守卫

### 4. DOM 只保留索引职责

- `dom → instance` 索引（WeakMap）
- `$data/$sys/$mod` 公开 getter

### 5. vrouter 是特殊组件

- 没有 `<vrouter>` 时 vhtml core 可独立工作
- Page/Layout 只属于 router 子系统

---
