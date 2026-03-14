# vhtml 后续规划与开发约束

这份文档只保留未来规划和长期约束，不记录已经完成的重构工作。

## 长期约束

### 1. 保持真实 DOM 运行时

后续开发必须继续遵守：

- 不引入虚拟 DOM
- 不做整树 diff
- 不做 SSR
- 不做 hydration
- HTML 文件就是页面，也是组件

### 2. 不回退到混合上下文

后续运行时必须继续坚持：

- `$data` 只表示实例私有状态
- `$env` 只表示父子组件上下文链
- `$scoped` 只表示模块级上下文池
- `$router` 只表示最近祖先 router view

禁止再把：

- `$axios/$t/$i18n`
- router 状态
- 组件私有状态

重新混回一个大 `env` 对象。

### 3. `scoped` 必须继续作为模块隔离边界

后续任何设计都不能破坏：

- 同一个 `scoped` 共享同一个 `$scoped`
- 同一个 `scoped` 共享模块 `$axios`
- 同一个 `scoped` 共享模块 `$i18n/$t`
- 不同 `scoped` 不串模块状态

同时必须继续保持：

- `env.js` 只负责模块级 `$scoped`
- `routes.js` 只负责 router view 级路由与钩子
- 不再把 router 配置放回 `env.js`
- `routes.js` 后续应支持工厂函数形式，并能读取 `$scoped`

### 4. 统一实例模型不能退化

后续运行时必须继续围绕统一实例模型演进：

- 普通组件
- 结构 boundary
- router-view
- page
- layout

都应继续复用同一套实例结构。

不允许重新引入第二套 parent/children/runtime record。

### 5. DOM 只保留索引与宿主职责

后续不能再把 DOM 当主状态容器。

`runtime/dom.js` 只能承担：

- `dom -> instance` 索引
- 轻量桥接
- 回收辅助

不能重新回到：

- 大量 `$env/$scope/$router/$ref` 直挂 DOM
- 多处直接以 DOM 字段作为核心状态主路径

### 6. `vrouter` 是特殊组件，不是框架基础前提

后续设计必须继续保证：

- 没有 `<vrouter>` 时，`vhtml core` 可独立工作
- `Page/Layout` 只属于 router 子系统
- 普通组件和 slot 不因为 router 丢失独立语义

### 7. 不保留静默 fallback

后续内核开发继续遵守：

- 加载失败直接报错
- 导航钩子出错直接暴露
- 不再通过默认路由、占位页面、兼容桥静默吞错

## 后续规划

### 第一阶段：继续压缩 `vrouter.js`

目标：

- 继续拆分 `vrouter.js` 的辅助逻辑
- 让文件只保留 route/view orchestration
- 继续收 `Page` 与 `RouterView` 的辅助方法

优先方向：

- 抽离 `runRuntimeTreeLifecycle`
- 继续减少 `Page` 控制器上的临时逻辑
- 继续减少 `RouterView` 的私有字段和辅助方法

### 第二阶段：拆执行器

目标：

- 把执行器彻底拆成独立职责

建议形态：

- `evalExpression`
- `runSetup`
- `runScript`
- `runLifecycleScript`

要求：

- 不再依赖“猜测是不是表达式”的通用逻辑
- 文本、属性、结构条件、setup、lifecycle 执行链完全分开

### 第三阶段：继续收口 slot 与结构边界

目标：

- 继续减少 slot/runtime 对 DOM 辅助状态的依赖
- 让 `v-if/v-for/slot` 组合路径更稳定

重点：

- 明确 slot payload 的更新边界
- 继续减少结构指令里的局部特判
- 为后续多层嵌套 slot 做准备

### 第四阶段：多 `vrouter` 的专项验证

目标：

- 验证多个 `<vrouter>` 在同一路径下的行为稳定性
- 明确主 title 更新策略
- 明确不同 router view 的局部 current/query/params 语义

需要重点覆盖：

- 同页多个 `<vrouter>`
- 不同 `routes` 参数
- 同地址下不同视口匹配不同路由
- 局部 `$router` 注入是否稳定

### 第五阶段：文档与示例同步

目标：

- 让示例页面、routes 示例、模块示例全部体现新设计
- 去掉任何旧式兼容写法示例

重点：

- `env.js` 模块入口规范
- `routes` 模块导出格式
- `routes.js` 工厂函数上下文规范
- `$data/$env/$scoped/$router` 语义
- cache page 与 `active/deactive`
- layout + page outlet 行为

## 开发约束

### 1. 改动内核时必须同步文档

每轮涉及 runtime 内核的重构后，必须同步：

- [`docs/desgin.md`](/Users/veypi/vyes/vhtml/docs/desgin.md)
- [`docs/todo.md`](/Users/veypi/vyes/vhtml/docs/todo.md)

### 2. 继续优先显式设计，不做兼容补丁

后续开发默认原则：

- 优先重构结构
- 不优先打补丁
- 不为了旧路径保留冗余桥接

### 3. 每轮内核改动至少回归这些链路

- 普通组件嵌套
- 跨 `scoped` 模块页面切换
- `v-if` 销毁重建
- slot
- layout
- cache page
- 多 `vrouter`
- `$axios/$t/$i18n` 模块隔离
