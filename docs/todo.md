# vhtml 路线图（todo）

来源：2026-08-27 机制评估（Web Components 对比 + 全源码审计）+ 2026-08-28 复核修正 + 2026-08-28 补充设计方向（$mod 职责归位）。
已发布 v0.10.0。原则：无用户期允许破坏性改动；错误该暴露就暴露；不做历史兼容。

每个版本通用验收：`node --test` 全过、`vite build` 重建 dist、aic 4000 debug 环境回归高频页面（chat / agents / explorer / os）；性能/内存不倒退——活 DOM 节点与游离驻留水位对比基线（`__vhtml_dev` 缓存水位或 heap snapshot 方法论）；语法或契约变化时同步 SKILL.md 与 skill 镜像（~/.cache/aic/u/admin/skills/vhtml/SKILL.md）。

---

## v0.10.0 — 已发布（2026-08-28，git tag v0.10.0）

四个子版本一轮交付（用户面向的发布说明见 docs/CHANGELOG.md）：

- **响应式系统全新重写（reactive.js）**：Effect handle 取代全局数字索引（Set 依赖表、O(1) 幂等 Cancel、伪回调洞结构性消除）；两阶段 flush + 变更门控（Object.is 缺省 / `equality: null` 恒跑 / 自定义比较器；v-for reconcile 恒跑豁免）；`batch` 原语（数组七变异方法 get 陷阱自动包装、sort 比较器窗口内写他物延迟通知）；set 陷阱纯替换——copyBind 迁出为显式 `mergeIntoProxy` 由 reconcile 位置键复用分支调用，写路径恢复字段级精确通知；级联防护（单帧 10 轮上限、调度层 throw 带 effect 链诊断、flushScheduled 先复位可恢复）；删除 `deepAccess`/`deep` 选项（`:x` 引用语义）；root 链穿透读补注册本地 key 通道（修旧追踪洞）；sandbox 编译缓存 LRU 512；runtime 鸭子判定改 RUNTIME symbol；`__vhtml_dev` 观测层（stats/cascadeErrors/errors）。
- **生命周期确定性**：`disposeNode` 公开契约（谁移除 DOM 谁 dispose、幂等）；observer 降级为兜底 + dev 警告门控（只警告 vhtml 模板衍生 DOM）；`keepOnDetach` 实例字段（data-keep 属性通道整体废除）；generation token 统一异步挂载竞态（嵌套异步段复用父票据契约，子段另行 issue 会作废父段）。
- **路由语义重设计（router.js 拆分为 router/ 六模块 + 18 行门面）**：导航状态机事务化（staging→commit、令牌作废在途导航、同目标/已激活 no-op 收拢为单一决策点）；staging 期写入目标参数快照、作废/阻断/redirect 回滚到 `#lastCommitted`（新页面首次构建即可读目标参数，修直开 `/a/:id` 卡死与 Chat 按钮无反应）；layout 所有权上移 RouterView（活性校验、引用计数回收、resetRoutes 显式销毁）；页缓存 LRU per-RouterView=8（OS 多窗口互不驱逐）；fire-and-forget 导航 rejection 收口（`#swallowNav` 进错误登记表，锚点点击/redirect/守卫/dropPage/nav 监听全覆盖）。
- **沙箱与错误契约**：unsafe 定性「防误触层非安全边界」（safeFunction/safeView 堵 `.constructor` 逃逸链，lockProperty 只读不可配置属性代理不变式兼容）；`$emit` 内置事件名 throw；errors.js 全局错误登记表（编译/表达式/挂载/navigation 四类，`__vhtml_dev.errors`）；编译失败 throw（旧返回 null 静默失效废除）；挂载失败渲染可见错误占位；`$watch` 50ms 魔法延迟删除——scope 延迟队列（setup 期入队、props 绑定后排空，生命周期脚本同机制）；compileCode 注释剥离改字符串感知扫描器；未命中标识符按 key 去重警告；`setCompileContext` 编译上下文（表达式错误带组件定位）。

破坏性契约变更（SKILL.md + 镜像已同步）：「禁 splice、slice 拷贝再赋回」废除（变异方法安全且保留行身份）；数组元素整体赋值 = 新身份（不再原位 merge）；`deep` 选项删除；data-keep 废除；导航事务 + 幂等不变式（同目标导航直接吸收、空目标非法、无 href 锚点不注册）；错误暴露规则（静默空白/静默 null 一律可见化）。

期间修复的阻断/高危 bug（测试已锁定）：嵌套异步段票据作废父段（全部 setup 组件编译中止）；disposeRuntimeSubtree 实例分支提前 return 破坏幂等；staging 后同目标导航作废在途构建（无限构建循环）；空目标解析成当前路径污染无 href 锚点；429 前评审修复（navigation rejection 泄漏/resetRoutes 外壳泄漏/失败 scope 未销毁/cascadeErrors 无界）。

---

## v0.10.4 — 工具链（cli/vhtml）

主题：AI 写 UI 工作流的静态保障。

- [ ] **`vhtml check` 静态检查命令**：模板表达式语法检查（抓 `v-fo` 类指令拼写、`vslot` 名称配对、表达式语法错误）；与 i18n scan 联动。零运行时成本，可作为 agent 工具直接调用。**载体设计（开工前定案）**：CLI 是 Go 二进制而表达式解析需要 JS（acorn），Go 侧无可用 JS 解析器（goja 太重不值得）。建议路径：checker 主体写成 JS，Go 命令探测 node 执行；或独立成 npm 包（aic agent 工具链直接调）。选前者需定义无 node 环境的降级行为（明确报错而非静默通过）。
- [ ] **WC 互操作口子（单向消费）**：compiler 组件分支前置判断 `customElements.get(tagName)`——已注册为原生 Web Component 的 tag 跳过 vhtml 编译，`:x` 绑定对 WC 走 property 赋值。解决三方 WC 被误当 vhtml 组件 fetch 出 `[Load Error]` 的冲突。三方 WC 名与 vhtml 组件名撞名时不得纯静默偏向 WC——dev 模式打警告（tag resolved to native custom element, vhtml component shadowed）。
- [ ] **组件级 HMR 评估**：CLI live reload 从整页刷新升级为保留状态的热替换；评估成本，不做则记录结论。

---

## v0.10.5 — 模块层职责归位：$mod.defineStore + 路由前缀清理（破坏性）— 设计定稿 2026-08-28，待开工

主题：$mod 从杂物袋升级为有结构的服务层 + 路由配置归位。两份设计分析（2026-08-28）结论已拍板。

### A. $mod.defineStore（状态管理）

现状：aic env.js 33 处 `mod.` 平铺写入（$nc/$auth/$cloud_fs/$err...），服务/配置/状态混铺无约定；跨组件共享状态只有两条路——$mod 顶层（撞名风险、无归属）或 $bus 事件（丢响应式追踪）。
关键洞察：vhtml 响应式是读追踪（代理读取即注册依赖），任何 Wrap 过的对象在模板里天然自动更新——**不需要引入新响应式引擎，缺的只是结构、约定、生命周期**。Pinia 人体工学约 100 行可拿到；Zustand selector 模型完全不需要（细粒度更新免费，这是 vhtml 相对两者的优势）。

设计骨架（拍板结论）：

```js
// env.js（现有模块初始化槽位，不新增文件类型）
export default async ($mod, manager) => {
  $mod.defineStore('counter', {
    state: () => ({ count: 0 }),
    getters: { double: (s) => s.count * 2 },   // 访问器属性，模板 {{ $mod.counter.double }}
    actions: { inc() { this.count++ } },        // this = store 代理，写入即通知
  })
}
```

- store = 单个 Wrap 对象（state/getters/actions 合并），按名挂 `$mod.<name>`——模板与沙箱裸标识符（`counter.count`）直接可用。
- getters 用**访问器属性**（Pinia 手感），非缓存 computed（路线图已存档不做）；依赖注册靠 Reflect.get 的 receiver 传递——**编码第一步先验证 Wrap get 陷阱透传 receiver（this 落在代理上），必要时 store 层手动绑定**。
- actions `this` = store 代理，写入走 set 陷阱免费通知；调用形态 `counter.inc()` 经沙箱返回 store 代理后方法调用，this 正确。
- 订阅不造新 API：`$watch(() => $mod.counter.x, cb)` 已有且自动清理。
- `store.$set(patch)`：`batch(() => Object.assign(store, patch))` 批量合并单次通知，进 v1。
- 保留字/重名 fail-fast：撞 $mod 既有键（scoped/$bus/$i18n/$t/fetch/restrictedFetch/...）或已注册 store 名 → throw；state/getters/actions 内部同名冲突也 throw。
- 定义位置不限：env.js 为主约定，setup 内懒注册允许（API 位置无关）。
- 生命周期随模块常驻（不做 unload/持久化）；`__vhtml_dev.stores` 登记表。
- 跨模块：`manager.loadModule('/other')` 返回对方 $mod，直接读对方 store，机制已有。

### B. 路由前缀清理（破坏性，NoCompat）

查证结论：导航前缀三层链条 `$router.router_prefix` > `$mod.router_prefix` > `$mod.scoped` 中，**`$mod.router_prefix` 是纯冗余**——全生态仅 aic/rses env.js 写入且都是 `mod.router_prefix = mod.router_prefix || mod.scoped`（把第三层兜底值抄到第二层），无任何模块设过不同值、无模板读取。权威值本就在 RouterView（`#routerPrefix`，来自 `<vrouter prefix>` / `:prefix` 节点通道）。

改动面：

- vhtml `view.js`：`resolveNavigationPrefixInfo` 删 `$mod` 中间层，链条收敛为 **`<vrouter>` 元素声明（prefix 属性 / :prefix 绑定）→ `$mod.scoped` 兜底**；getter `$router.router_prefix` 改名 **`$router.prefix`**（不留别名）；`compiler-attrs.js`×3、`anchor.js` 读取点同步。
- `aic/ui/env.js`、`rses/ui/env.js`：删 router_prefix addWrapper（删后行为等价——兜底本就给出同值）。
- 文档：design.md 优先级段、SKILL.md、CHANGELOG；`router.test.js` 补两级链用例。
- `$mod.scoped` 维持原样：模块资源前缀（fetch/alias/模板加载）+ 路由兜底，语义正确。

---

## v0.11.0 — API 冻结

- [ ] **AOT 绑定计划评估**：per-template 编译一次生成绑定计划（节点路径 → 指令操作），实例化 = clone + 执行计划，替代每实例全树 compileNode 扫描。大列表场景收益显著；不做则记录理由。前置注意：避免把「编译即遍历」假设写进更多模块。
- [ ] 文档冻结：SKILL.md + skill 镜像 + README 终稿。
- [ ] **vmessage 移出框架内核评估**：$message 是内核里嵌的具体 UI 组件（544 行、硬编码样式/位置），考虑挪到 vhtml-ui 或主题化；sys.$message 调用面不变。
- [ ] 之后进入 semver 纪律，破坏性改动只走大版本。

---

## 已评估不做（结论存档，避免翻案）

- **custom elements 化 / Shadow DOM 默认化**：全局注册表杀模块级 tag 解析与磁盘热更新；shadow 杀 vcss 穿透、$refs 可观测性与 observer 体系。2026-08-27 评估定论。
- **原生 slot 引用投影替代克隆投影**：vslot 克隆 + caller runtime 编译是语义核心（vbind 作用域属性），原生 slot 语义不匹配。
- **v-for 恢复 `:key`**：自动身份（DataID/位置键/形状）是设计取舍，v0.10.0 splice 修复后契约进一步简化。
- **细粒度 signals 化**（2026-08-27）：抹掉 `$data.items.push()` 裸对象人体工学，全生态写法重写，收益（更细通知粒度）在 Proxy + 变更门控 + v-for merge 方案下已大部分拿到——不值。
- **computed 懒求值缓存**（2026-08-27）：模板表达式作用域随 v-for 行变化，缓存粒度对不上；不做。
- **数组按索引订阅依赖**（2026-08-27）：splice 后索引身份无意义，Vue 同款反模式；数组恒 `''` 单粗通道。
- **store 持久化插件**（2026-08-28）：测试版无需求，等真实用例再说。
- **Zustand selector 模型**（2026-08-28）：细粒度更新在 vhtml 读追踪下免费，不需要 selector 订阅机制。
