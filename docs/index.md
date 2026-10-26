# vhtml 文档地图

统一架构：根目录放 `README.md` / `CHANGELOG.md` / `LICENSE` / `package.json`（版本号），
其余文档进 `docs/`，按 `architecture/`（架构设计）、`reference/`（契约规范）、
`guides/`（使用操作）、`development/`（计划与过程文档）分类。

## 入口

| 文档 | 内容 | 何时读 |
| --- | --- | --- |
| [README.md](../README.md) | 定位、安装、CLI、快速开始、核心概念（绑定/组件/路由/请求） | 使用框架前 |
| [CHANGELOG.md](../CHANGELOG.md) | 已完成的版本变更（含发布注意事项） | 发版与升级时 |
| [package.json](../package.json) | 当前版本号（npm 包版本即框架版本） | 发版时 |
| [ui/docs/SKILL.md](../ui/docs/SKILL.md) | 面向应用作者与 AI 的前端指南（模板、响应式、生命周期、路由、i18n、性能） | 写页面/组件或排查渲染问题前 |
| [cli/vhtml/README.md](../cli/vhtml/README.md) | vhtml CLI：开发服务器、检查、i18n 扫描 | 使用 CLI 时 |

## architecture

| 文档 | 内容 | 何时读 |
| --- | --- | --- |
| [architecture/overview.md](architecture/overview.md) | 总体设计：编译、运行时、模块与资源模型 | 改内核前建立整体图景 |
| [architecture/module-runtime.md](architecture/module-runtime.md) | 模块运行时设计（模块上下文、隔离与装载） | 改模块加载/上下文前 |
| [architecture/module-sandbox.md](architecture/module-sandbox.md) | 模块沙箱：渲染策略支持的能力集与明确限制 | 评估动态资源、iframe、存储等能力边界时 |

## development

| 文档 | 内容 | 何时读 |
| --- | --- | --- |
| [development/todo.md](development/todo.md) | 路线图与未完成的计划 | 评估后续工作时；已完成事实写 CHANGELOG |
| [development/performance.md](development/performance.md) | V1–V4 性能优化与验证记录 | 查阅历史性能结论 |
| [development/performance-refactor-plan.md](development/performance-refactor-plan.md) | 通用性能重构方案 | 过程文档，非现行契约 |
| [development/performance-refactor-results.md](development/performance-refactor-results.md) | R0–R3 实施与验证结果 | 过程文档，非现行契约 |

## 约定

- 使用说明以 README 与 `ui/docs/SKILL.md` 为准，设计真相以 `architecture/` 为准；
  过程文档集中在 `development/`，不与现行契约并列。
- 已完成的变更写根目录 CHANGELOG，未来计划只写 `development/todo.md`。
