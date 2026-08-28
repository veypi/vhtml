# vhtml 路线图（todo）

来源：2026-08-27 机制评估（Web Components 对比 + 全源码审计）+ 2026-08-28 复核修正 + 2026-08-28 补充设计方向（$mod 职责归位 + 全局对象）+ 2026-08-28 综合评估（双评估交叉核验：修正 check 载体事实错误、补 WC/AOT/契约冻结设计、HMR 定论）。
已发布 v0.10.1。原则：无用户期允许破坏性改动；错误该暴露就暴露；不做历史兼容。

每个版本通用验收：`node --test` 全过、`vite build` 重建 dist、aic 4000 debug 环境回归高频页面（chat / agents / explorer / os）；性能/内存不倒退——活 DOM 节点与游离驻留水位对比基线（`__vhtml_dev` 缓存水位或 heap snapshot 方法论）；语法或契约变化时同步 SKILL.md 与 skill 镜像（~/.cache/aic/u/admin/skills/vhtml/SKILL.md）。

---

## v0.10.0 — 已发布（2026-08-28，git tag v0.10.0）

四个子版本一轮交付（用户面向的发布说明见 docs/CHANGELOG.md）：

- **响应式系统全新重写（reactive.js）**：Effect handle 取代全局数字索引（Set 依赖表、O(1) 幂等 Cancel、伪回调洞结构性消除）；两阶段 flush + 变更门控（Object.is 缺省 / `equality: null` 恒跑 / 自定义比较器；v-for reconcile 恒跑豁免）；`batch` 原语（数组七变异方法 get 陷阱自动包装、sort 比较器窗口内写他物延迟通知）；set 陷阱纯替换——copyBind 迁出为显式 `mergeIntoProxy` 由 reconcile 位置键复用分支调用，写路径恢复字段级精确通知；级联防护（单帧 10 轮上限、调度层 throw 带 effect 链诊断、flushScheduled 先复位可恢复）；删除 `deepAccess`/`deep` 选项（`:x` 引用语义）；root 链穿透读补注册本地 key 通道（修旧追踪洞）；sandbox 编译缓存 LRU 512；runtime 鸭子判定改 RUNTIME symbol；`__vhtml_dev` 观测层（stats/cascadeErrors/errors）。
- **生命周期确定性**：`disposeNode` 公开契约（谁移除 DOM 谁 dispose、幂等）；observer 降级为兜底 + dev 警告门控（只警告 vhtml 模板衍生 DOM）；`keepOnDetach` 实例字段（data-keep 属性通道整体废除）；generation token 统一异步挂载竞态（嵌套异步段复用父票据契约，子段另行 issue 会作废父段）。
- **路由语义重设计（router.js 拆分为 router/ 六模块 + 18 行门面）**：导航状态机事务化（staging→commit、令牌作废在途导航、同目标/已激活 no-op 收拢为单一决策点）；staging 期写入目标参数快照、作废/阻断/redirect 回滚到 `#lastCommitted`（新页面首次构建即可读目标参数，修直开 `/a/:id` 卡死与 Chat 按钮无反应）；layout 所有权上移 RouterView（活性校验、引用计数回收、resetRoutes 显式销毁）；页缓存 LRU per-RouterView=8（OS 多窗口互不驱逐）；fire-and-forget 导航 rejection 收口（`#swallowNav` 进错误登记表，锚点点击/redirect/守卫/dropPage/nav 监听全覆盖）。
- **沙箱与错误契约**：unsafe 定性「防误触层非安全边界」（safeFunction/safeView 堵 `.constructor` 逃逸链，lockProperty 只读不可配置属性代理不变式兼容）；`$emit` 内置事件名 throw；errors.js 全局错误登记表（编译/表达式/挂载/navigation 四类，`__vhtml_dev.errors`）；编译失败 throw（旧返回 null 静默失效废除）；挂载失败渲染可见错误占位；`$watch` 50ms 魔法延迟删除——scope 延迟队列（setup 期入队、props 绑定后排空，生命周期脚本同机制）；compileCode 注释剥离改字符串感知扫描器；未命中标识符按 key 去重警告；`setCompileContext` 编译上下文（表达式错误带组件定位）。

破坏性契约变更（SKILL.md + 镜像已同步）：「禁 splice、slice 拷贝再赋回」废除（变异方法安全且保留行身份）；数组元素整体赋值 = 新身份（不再原位 merge）；`deep` 选项删除；data-keep 废除；导航事务 + 幂等不变式（同目标导航直接吸收、空目标非法、无 href 锚点不注册）；错误暴露规则（静默空白/静默 null 一律可见化）。

期间修复的阻断/高危 bug（测试已锁定）：嵌套异步段票据作废父段（全部 setup 组件编译中止）；disposeRuntimeSubtree 实例分支提前 return 破坏幂等；staging 后同目标导航作废在途构建（无限构建循环）；空目标解析成当前路径污染无 href 锚点；评审修复（navigation rejection 泄漏/resetRoutes 外壳泄漏/失败 scope 未销毁/cascadeErrors 无界）。

---

## v0.10.1 — 模块层职责归位：$mod 二级对象树 + define 公共原语（$mod.define / all.define）+ 路由前缀清理 + addWrapper 移除（破坏性）— 设计定稿 2026-08-28（v3）；2026-08-28 落地并提交（f3e41e6，已打 tag v0.10.1；163/163 测试绿，dist 270.5kB）；路由前缀 P1 修复见 B 节最终方案；2026-08-28 综合评估复核：双评估独立核验落地无水分（第二份评估 9/9 事实声明属实），遗留 P2/P3 移交 v0.10.2 顺手修复；dist 已 terser minify（b23eafd，114.7kB）

主题：$mod 从杂物袋升级为「本地条目 + 全局回落」的二级对象树；跨模块共享从「addWrapper 逐模块复制」改为「define 到 manager.globals + root 链动态回落」；define 是 Object.defineProperty 的响应式增强公共原语。设计经 2026-08-28 三轮收敛（v2 三键 store → v3 defineProperty 原语），**以 v3 为准**。

### A. `$mod` 二级对象树：`define` = defineProperty 响应式增强公共原语（v3 定稿）

现状：跨模块共享只有 addWrapper 一条路——把同一引用逐模块复制（vbase `$auth`、aic 6 服务的活证据），有时序问题（wrapper 晚注册旧模块漏注、创建中模块要 `entry.applied` 去重占位）与双写丑陋（本地写一次 + wrapper 复制一次）。aic env.js 10 处 `mod.` 平铺写入（组件内另有 layout $os 等），服务/配置/状态混铺无约定。
关键洞察：vhtml 响应式是读追踪（代理读取即注册依赖），任何 Wrap 过的对象在模板里天然自动更新——**不需要引入新响应式引擎，缺的只是结构、约定、生命周期**。而「包不包」的判定 isProxyType（reactive.js:298-302）早已完成：类实例（constructor≠Object/Array）、Node/Date/RegExp/Event、`__noproxy`、函数（get 陷阱提前返回）一律不包，纯字面量/数组读时惰性 Wrap——**无需任何形态分派/raw 标志**。

**v3 拍板（2026-08-28 用户定）：$mod 是一级对象树 + root 链二级回落；define = Object.defineProperty 的响应式增强公共原语；`$mod.x = y` 保留 = `$mod.define('x', y)` 无 opts（define 存在意义 = 带 opts 的赋值 + 目标选择）；没有 global 标志、没有保留字清单、没有形态分派、没有写封膜**

```js
// 公共原语（reactive.js 导出，对任意对象安全）
defineProperty(target, key, value, opts)   // opts 透传 {get, set, writable, configurable, ...}

// 便捷绑定（module.js 装配期挂上，env.js 无需 import）
$mod.define('counter', { count: 0, inc() { this.count++ } })   // 绑本模块（本地条目）
all.define('$auth', vbase)                                      // 绑 manager.globals（全局条目）

// 派生值 = getter（defineProperty 原生语义，模板 {{ $mod.counter.double }} 属性形态）
$mod.define('double', 0, { get() { return this.count * 2 } })
```

- **机制**：`defineProperty(target, key, value, opts)`——普通对象 = 纯 defineProperty 语义；Wrap 对象上自动接响应式：get 陷阱 `Reflect.get(target, key, receiver)` 透传 receiver → **getter this = 代理**、体内读字段注册依赖；set 陷阱 `Reflect.set` 调用 setter 后发通知；key 已存在 → 走代理 set（覆盖+通知，运行期覆盖也生效），不存在 → 描述符新装。
- **二级树**：模块 `$mod`（一级，本地条目）→ root 链 → `manager.globals`（二级，`Wrap({})`，挂在 manager 上是干净对象，不直接拿 manager 实例当 root——会泄漏 modMap 等内部字段）。root 链读现成（reactive.js:376-382：本地无 key 且 `key in globals` → 返回 `globals[key]`，globals 是 proxy 时读取本身注册 root 通道依赖）——**b 模块后 define 覆盖 global 条目 → globals set 通知 → 已订阅模板重估**。**读/写对称穿透**（reactive.js:399-405 现成语义）：本地有 key → 读写本地；本地无+global 有 → 读从 global 返回、写穿透到 global（全平台生效，谁后弄谁生效）；都没有 → 写本地新建私有条目。**无 local 遮蔽 global 语义**（遮蔽=穿透写，全局条目即共享条目；模块私有状态用不同名字）。
- **只读 = 描述符锁**：`{writable: false, configurable: false}`——读原样、写 throw（Reflect.set 返回 false → ESM 严格模式 TypeError）、再 define 同名 → 原生 `TypeError: Cannot redefine property`（**不需要保留字清单，描述符即边界**）。深只读（对象值内部禁写）由调用者先把值包只读代理再 define（内置件无此需求）。
- **内置件 = 装配期 define**（$mod 生成时先装）：`scoped`/`$bus`/`$i18n`/`$t`/`fetch`/`restrictedFetch`/`define` 自身，全部锁只读——env.js 后 define 同名自动报错，正是「先定义者不可覆盖」。lockProperty 机制删除（语义并入）。
- **写封膜（破坏性）**：`$mod` 代理 set 陷阱一律 throw（提示走 define）——`$mod.$cloud_fs = x`、打错字赋值全部 fail-fast；框架装配在封膜前于 raw 完成。方法调用不受影响（`$mod.$i18n.load(data)`/`$mod.$nc.connect()` 是服务内部行为，不是 $mod 属性写）。
- **赋值 = define 无 opts（无写封膜）**：`$mod.x = y` ≡ `$mod.define('x', y)`——普通条目纯替换+通知（Wrap set 现成行为，新值读时惰性 Wrap）；需要 get/set/writable/readonly/global 时才用带 opts 的 define。只读防线不靠 set throw：内置件描述符锁（writable:false+configurable:false）——`$mod.scoped = x` 走 Reflect.set 返回 false → ESM 严格模式原生 TypeError；`define('scoped', ...)` 带描述符 → 原生 Cannot redefine property。
- **条目类型**：类实例/函数/`__noproxy` 直接 define（isProxyType 天然豁免）；纯字面量/数组 define 后读时惰性 Wrap（响应式自动）。同名字重复赋/define = 覆盖，assign 语义谁后谁生效，无警告。
- **名字允许 $ 前缀**（`$auth/$nc` 惯例保持）——迁移后全部模板/调用点零改动。
- **登记表**：`__vhtml_dev.defines`（名称+目标+描述符摘要；可选，鉴定后加）。
- 定义位置不限：env.js 为主约定，setup 内懒注册允许（API 位置无关）。生命周期随模块常驻（不做 unload/持久化——测试版无需求，存档）。

**已评估不做（留档）**：① Pinia 三键 store 形态（state 工厂对 $mod 单例注册无意义——define 一次恒单实例；类实例豁免 isProxyType 已天然完成；getters = defineProperty get、actions = 普通方法 this 恒代理）；② 保留字清单（描述符即边界）；③ `{global: true}` 标志（global 目标即 manager.globals，目标对象即配置）；④ 重名警告/拒绝（assign 语义，非只读覆盖谁后弄谁生效）；⑤ 写封膜（`$mod.x = y` 保留 = define 无 opts，只读靠描述符锁原生 TypeError，不做 set throw）。

### B. 路由前缀清理（破坏性，NoCompat）——2026-08-28 查证修订

原查证「`$mod.router_prefix` 无模块设过不同值、无模板读取」**不成立**，修订如下：

- **vbase.js:288 读取点补记（2026-08-28 P1 源头）**：`vbase/ui/vbase.js` `login_page` getter 用 `this._mod.router_prefix ?? this._scoped`（`??` 仅 nullish 回退）——旧 wrapper 注入的 `''`（压平到根）是**有效值**，登录跳转 = `/login`；删 wrapper 变 `undefined` 后回退 `/vb`，登录重定向 404。ico.html:150 用 `||`（空串 falsy 回退）不受影响——**同删一个值，`??` 侧与 `||` 侧行为分叉**，查证必须覆盖 `??` 读取点。
- **最终方案（2026-08-28 用户定，P1 修复）**：aic 根 env 重建根默认条目 `all.define("router_prefix", $mod.scoped)`（aic 根 scoped=''）；agent 端 `$mod.define("router_prefix", ...)` 本地遮蔽——**裸写会穿透写 globals 污染根默认条目**（agent 赋值时本地无该键 + globals 已有 → set 陷阱穿透分支，探针实锤），vbase.js:288 不改（globals 恒有根默认值）。

- **保留 `$mod.router_prefix` 层**：`aic/agents/env.js:11`（agentui 默认 env，go:embed 于 aic/agents/agentui.go）经 `$mod.define("router_prefix", $mod.scoped.replace("/agents", "/a"))` 本地遮蔽设置——agent UI 资源路径为 `/agents/{id}`（后端 agentui 服务），平台前端路由为 `/a/{id}`（routes.js `/a/:agent_id/i` → `/agents/{id}/index.html`），该映射是 agent UI 内 `$router.push('/i/xxx')` 落到 `/a/{id}/i/xxx` 的必要通道（code_anylse goReq/goTrace 活例，删除后 push 目标变 `/agents/{id}/...` 平台路由不匹配）。agent ui 页面自身不持有 `<vrouter>` 节点，平台 RouterView `#routerPrefix` 恒空——无法用「vrouter 声明」替代。
- **删三处兜底 wrapper**（aic/aiv/rses env.js 的 `mod.router_prefix = mod.router_prefix || $mod.scoped`）：其真实语义是「把子模块导航前缀**压平为 aic 根 scoped（''）**」而非「同值兜底」（闭包 $mod 是 aic 根，不是被注入子模块）；agent env.js 覆盖在后不受影响；rses loadModule aiv 遗留路径同删。
- **链条不变**：`<vrouter>` 元素声明（prefix 属性 / :prefix 绑定）→ `$mod.router_prefix`（显式设置者）→ `$mod.scoped` 兜底。view.js `resolveNavigationPrefixInfo` 保留三分支，只删 wrapper。
- getter `$router.router_prefix` 改名 **`$router.prefix`**（不留别名）：全仓无模板/组件读取，仅 view.js 内部 `#routerPrefix` 引用 + compiler-attrs.js×3 / anchor.js 的 `router?.router_prefix` 调试字段同步——低收益，可选做。
- `vbase/ui/ico.html:150` 模板读取 `scoped = $mod.router_prefix || $mod.scoped`（第二段 script 用 parentScoped 覆盖）——迁移时按「组件宿主 scoped」核对行为。
- `router.test.js` 补两层（vrouter 声明 / $mod.router_prefix）用例，agent 页面导航回归（/a/{id}/i 打开 agent UI + 内链）。

### C. addWrapper 移除 + 全量迁移面

vhtml：删 `addWrapper`/`this.wrappers`/`entry.applied` 整套机制（module.js 约 40 行 + 两段时序注释）；**`lockProperty` 一并删除**（描述符锁语义并入 define，see A）。

**开工第一步（破坏性面清查）**：`rg '\$mod\.?[\w$]*\s*=[^=]' aic/ui rses/ui vbase/ui aic/agents`（含组件 `<script setup>`/`<script>`/`<script dispose>` 内对 $mod 的写入）——裸写全部改走 define；此 grep 结果同时决定迁移工作量。

| 迁移点 | 现状 | 迁移后 |
|---|---|---|
| `vbase/ui/env.js:19-23` | `$mod.$auth = vbase` 本地写 + addWrapper 逐模块复制 | `all.define('$auth', vbase)`（类实例，isProxyType 天然豁免） |
| `aic/ui/env.js:58-92` | root 本地写 6 服务（$nc/$cloud_fs/$host_fs/$page_fs/$fsdrv/$page_exec）+ addWrapper 复制 | 6 个 `all.define(...)`（实例→原样、工厂函数→callable） |
| `aic/ui/env.js:42-44`、`rses/ui/env.js:14-16`、`aiv/ui/env.js:17-19` | router_prefix addWrapper（B 的冗余） | 直接删除（B 节修订，见上） |
| `aic/ui/env.js`、`vbase/ui/env.js` 其余裸写（$nc/$err/$fetch/$local/$t 相关、users/startCountdown 等） | `$mod.x = ...` | `$mod.define('x', ...)`（默认 local，语义等价；users 等对象若模板有订阅，define 后惰性 Wrap 响应式不变） |
| `aic/agents/env.js` | `$mod.router_prefix`（特殊值）+ `$mod.$fetch` | router_prefix 保留（B）；$fetch → `$mod.define('$fetch', fn)` |
| `aic/ui/layout/default.html:717/734` | `$mod.$os = {...}`（setup 挂）→ dispose 置 null（运行期写 $mod；无封膜，赋值语义 = 「本地无+global 有」穿透写 global、「都没有」写本地——所以 global 条目必须先行建立） | env.js `all.define('$os', {cap: null})` 建立 global 条目；layout setup 里用 `$mod.$os.cap = {...}`（字段写→通知）或直接 `$mod.$os = {...}`（穿透写 global 覆盖，谁后弄谁生效）；dispose 清 null；多窗口单槽互相覆盖为现状语义，注释写明 |
| `rses/skills/vhtml-ppt/ui/*` | `$mod.page_current/$mod.ppt_mode/$mod.page_count/$mod.ppt_zoom` 跨组件共享状态（模板直读注册依赖） | store 语义的现成用例：define 普通对象（{page_index, ppt_mode, ...}），模板读照旧（惰性 Wrap） |

（2026-08-28 用户定：vhtml-ppt 已弃用、后续删除，替代品 = ppt-studio——上表 ppt 迁移行不再涉及，回归也不用覆盖。）

注意：`$err`/`$local` 等当前**不在** wrapper 共享清单里（vbase 注释明确"不通过 addWrapper 共享"）——迁移为 local define，语义等价，不顺手扩大共享面。

### 验收

- **前提：先重启 4000/4002**——aic/ui/env.js、aic/agents/env.js 走 go:embed（vhtml src 本身 debug 直读实时生效，env.js 需重启）；agent env.js 改动在 agentui.go embed。
- aic 4000 全页面回归：登录/唤醒刷新（$auth 高频）、聊天（$nc/$page_exec）、文件管理器（$cloud_fs/$fsdrv/$host_fs）、**agent 页面 /a/{agent_id}/i（agent UI 加载 + 内链导航，B 节翻车点）**——global 回落零改调用点，回归重点在 env.js 加载时序（vb 模块早于 aic root ↔ dynamic 回落双向可见；组件先读后 define 不保证重估——env.js 全完成后才编译组件，天然规避，文档写清）。
- 只读防线：`$mod.scoped = x` 与 `$mod.define('scoped', x)` 均原生 TypeError；内置件赋值/再定义不可绕过。
- rses 壳回归（含 vhtml-ppt 共享状态）。
- `node --test` 全过 + dist 重建；SKILL.md + 镜像同步（$mod.define/all.define 二级树 / defineProperty 原语语义 / 只读=描述符锁 / 无形态无标志 / router prefix 链条 / addWrapper 删除）。

---

## v0.10.2 — 工具链（cli/vhtml）

主题：AI 写 UI 工作流的静态保障。**执行顺序（2026-08-28 综合评估定）**：先做任务 0 编译器边界界定——同时解锁 check 与 v0.10.3 AOT 测量的前置注意，一次投入双收益。**契约纪律：check 输出格式、WC 绑定规则等新契约必须在本版本内定稿**——v0.10.3 冻结后破坏性变更只能走大版本。

- [x] **任务 0 — 编译器边界界定（纯编译核剥离，2026-08-28 综合评估修正载体设计）**：原设计「node 端直接 import sandbox.js / loader.js」**事实错误**——sandbox.js 顶层无条件 window 引用（`alert.bind(window)` 105-113、`window/document/history/windowValue('fetch')` 118-123），loader.js 依赖 `document.createElement`/`DOMParser`（56/65/185 等），node import 首行即抛 ReferenceError。修正：把 `compileCode`/`stripComments`/isStatement 分类（+ compiler-attrs.js 属性表达式提取）抽成零 DOM 依赖纯模块（如 `sandbox-compile.js`），浏览器与 checker 共用同一文件——零 shim、零语义漂移。编译核本身干净：`new Function('sandbox', 'with(sandbox){...}')` 的产物非严格模式、with 合法，node 可直接执行。顺带满足 AOT 前置注意（先界定编译器边界，不再把「编译即遍历」假设写进更多模块）。**已落地（2026-08-28）**：新文件 `src/compile.js`（compileCode/stripComments/toPreview/编译缓存 LRU/编译上下文 setCompileContext+getCompileContext，唯一依赖 errors.js 同样零 DOM）；sandbox.js 移除对应 ~110 行改由 compile.js 导入（setCompileContext 原路径 re-export，lifecycle.js/component.js 无感）；node 直跑冒烟通过（sync/async 编译执行）；164/164 测试绿；dist 重建。
- [x] **`vhtml check` 静态检查命令**：复用任务 0 纯编译核。能力边界（写进方案防过度承诺）：**能抓** = 表达式语法错误、指令拼写（`v-fo`）、vslot 名称配对、模板结构错误；**不能抓**语义——`{{ $mod.foo.bar.baz }}` 编译完全通过（运行时才 TypeError）；未定义标识符静态默认静默（has 恒 true + 运行期 `warnMissedIdentifier` 去重警告是运行时机制，sandbox.js:240-262）。**只编译不执行（compileCode 与 executeFn 分离），天然无副作用**。输出格式本版本定稿。与 i18n scan 联动；Go 命令探测 node 执行；无 node 环境 = 明确报错而非静默通过。**已落地（2026-08-28，契约 v1 定稿）**：`cli/vhtml/check.mjs`（字符串级扫描器：注释/script/标签/text 分区遮蔽保行号 → compileCode 只编译检查）+ `cli/vhtml/check.go`（go:embed 检查器、node 探测、编译核解析 VHTML_COMPILE_CORE→向上找 src/compile.js、退出码透传 0/1/2）。实语料全绿（aic/ui、vbase/ui、rses/ui、aic/agents）；变异测试 6 类缺陷全抓（插值/绑定/事件/v-for/script/指令拼写）+ 结构/vslot 警告；两个 false-positive 类已修：setup 脚本静态 import 按 imports.js parseImports 同正则剥离（运行时即剥离后另载 ESM）；含 Go 模板语法 `{{.` 的文件整体跳过（服务端模板，运行时编译渲染产物）。契约已写入 SKILL.md「Tooling: vhtml check」节（exit 0/1/2、text/JSON 双输出、kind 清单、能力边界）。
- [x] **WC 互操作口子 —— 已评估不做（2026-08-28 用户定，原设计已整体撤销）**：原计划 compiler 组件分支 `customElements.get` 判定（编译期固化）、`v-component` 撞名豁免、`:x` property-first 绑定三细节；落地后用户裁定不与 Web Components 牵扯——vhtml 处理的带 `-` tag 一律内部组件，引用 WC 由用户自行申请非 vhtml DOM（no-vhtml 区域/手动 DOM）处理。代码已全部回退（compiler.js / compiler-attrs.js / test/wc.test.js），决策理由存档见末节「已评估不做」。
- **组件级 HMR —— 已评估，不做**（2026-08-28 综合评估定论，存档见末节「已评估不做」）：vite build --watch 已覆盖 live reload；保留状态热替换与 v0.10.0 组件实例树/keepOnDetach/生命周期语义纠缠，高成本低回报；AI 写 UI 工作流改组件手动刷新可接受。

### 顺手修复（v0.10.1 评估复核遗留，不阻塞主线）

- [x] **P2 只读锁 sloppy 静默**：组件代码经 `new Function` 编译无 `'use strict'`（sandbox.js:357-360），对锁属性赋值（`$mod.scoped = x`）set 陷阱返 false → sloppy 模式静默 no-op，且不进错误登记表；只有 env.js（ESM 严格模式）真正抛。再 define 抛 TypeError 与严格性无关（Object.defineProperty 原生行为，硬边界可靠）。修法二选一：set 陷阱在 `Reflect.set` 返 false 且描述符锁定时显式 throw（**推荐**——fail-fast 不依赖调用方严格性）/ 仅改 SKILL.md 措辞（SKILL.md 现表述 "later assignment or re-define throws the native TypeError" 无前提，过强）。**已落地（2026-08-28，按推荐修法）**：Wrap set 陷阱 `!result` 显式 throw TypeError（含 getter-only 访问器场景）；define.test.js 补 sloppy 回归用例（new Function 赋值锁属性必须 throw）。
- [x] **P3-1 recordDefine 顺序**：module.js:204-205 登记先于 defineProperty 执行，对锁属性再 define 抛错时留幻影条目——调换顺序。**已落地（2026-08-28）**：$mod.define 绑定与 manager.define 均改为先执行 defineProperty 成功后再 recordDefine。
- [x] **P3-2 defineRegistry 不随 clear() 清空**：loader.js:225 reset 路径触发后 `__vhtml_dev.defines` 积累 stale 条目。**已落地（2026-08-28）**：manager.clear() 增 `defineRegistry.length = 0`（原数组引用，__vhtml_dev.defines 同步清空）。
- [x] **P3-3 _loadingMod 单槽并发错配**：并发模块加载（await 交错）时错配 recordDefine 的 scope 归属、误抑制 outside-env 警告；沿用的既有单槽模式，all.define 是新增消费者，概率低，随下次触碰 module.js 处理。**已落地（2026-08-28）**：单槽改 `_loadingStack` 数组 + `_loadingMod` 栈顶 getter；loadEnvConfig push/pop 自平衡（替代旧手动保存/恢复，旧代码内层 finally null 本就会清空外层状态）；loadModule 移除 savedLoadingMod 样板。
- [x] **P4 嵌套 v-for 触发 observer 兜底警告**（code_anylse menu.html 实案，外部定位报告 2026-08-28，机制经代码复核属实）：`<template v-for>` 多根行内嵌第二层 `v-for` 时，外层行编译先 `ensureStructuralBoundary` 给行根挂 boundary 实例、再 `compileNode`——行根带内层 v-for 则 `compileVfor` 的 `replaceWith`（compiler.js:173）把刚挂实例的节点替换成标记注释且未显式 dispose → MutationObserver 兜底回收 → dev 警告 `disposed via observer fallback`（×行数）。全平台唯一触发模板结构。**修复（2026-08-28）**：`compileVfor` 替换前 `disposeRuntimeSubtree(dom)`（disposeNode 契约「谁移除谁 dispose」；此时实例尚为空壳——内层 watch/cleanup 挂父级 scope，实测链路 compiler.js:176/178——释放安全；常规流程 dom 无实例，幂等空转）。vfor.test.js 补回归用例（template 多根 v-for + 行内 v-for + vrefof → 断言无兜底警告且嵌套 reconcile 正确；已做反证验证：临时回退修复则新用例必失败）。

---

## v0.10.3 — API 收敛与冻结评估

主题：进入 semver 纪律前的收尾评估；各项「不做」须记录理由（延续存档传统）。**契约提醒（2026-08-28 综合评估）**：semver 启动前的破坏性窗口在 v0.10.2——check 输出格式、WC 绑定规则等新契约须已在 v0.10.2 定稿，本版本只收文档，不再收新契约。

- [ ] **AOT 绑定计划评估 —— 先测量再决策（2026-08-28 综合评估方法）**：收益入口真实——compiler.js:274 v-for reconcile 每行 `compileNode` 全子树编译（DOM 遍历 + 属性解析），初始渲染大列表 = O(行数 × 行节点数)，AOT（编译一次生成绑定计划，实例化 = clone + 执行计划）把它压成 1 次编译 + N 次轻量执行。但实现复杂度高（编译器两阶段化，slots/嵌套组件/动态组件/生命周期在计划体系里重新表达，163 测试全量重验）。步骤：①dev 模式加编译计数/耗时诊断挂 `__vhtml_dev`，跑 chat / explorer 长列表实测「编译 vs 渲染」占比；②占比 <10% → 不做留档；占比显著 → 只对 v-for 行模板做计划化（范围内优化，不做全量 AOT）。前置 = v0.10.2 任务 0 编译器边界界定。
- [ ] **vmessage 移出框架内核 —— 成本已核实，建议做（2026-08-28 综合评估 + 用户定装配方式）**：vmessage.js 零内核 import（纯自包含，544 行硬编码样式/位置），唯一挂载点 module.js:87-88（`sys.$message = vmessage`）。**装配方式（2026-08-28 用户定）：挪入 vhtml-ui，经 vhtml-ui 的 env.js `all.define('$message', vmessage)` 定义到 manager.globals——aic/vbase 全部调用面零改动**（模板 `$message(...)` 经 $mod 层 root 链回落解析，不再走 $sys 层；sandbox `$sys` 暴露面 sandbox.js:212 同步收窄）。sys.$message 挂载点删除，内核零 UI 依赖。回归 4000 全页面（$message 高频调用面）。
- [ ] 文档冻结评估：SKILL.md + skill 镜像 + README 终稿。
- [ ] 冻结落定后进入 semver 纪律：破坏性改动只走大版本（v0.11.x → 1.0.0）。

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
- **global 对象卸载/版本化**（2026-08-28）：测试版无需求；global 改写走 define（非只读覆盖，谁后谁生效），无热替换诉求。
- **$mod.define 三键 store 形态**（2026-08-28 v3 定稿后）：state 工厂对 $mod 单例注册无意义（define 一次恒单实例）；类实例豁免 isProxyType 已天然完成；getters = defineProperty get（`{get(){...}}`）、actions = 普通方法（this 恒代理写入即通知）——三键是纯仪式，不引入。
- **define 保留字清单 / 重名警告 / `{global:true}` 标志**（2026-08-28）：描述符（writable:false）即只读边界，无需清单；非只读覆盖 = assign 语义（谁后弄谁生效），不警告；global 目标即 manager.globals（`all.define`），目标对象即配置。
- **checker 走 happy-dom shim**（2026-08-28 综合评估）：shim 的 DOMParser/querySelector 行为与浏览器存在已知漂移，检查结果与真实运行不一致正是该功能要避免的；纯编译核剥离（v0.10.2 任务 0 方案 A）零 shim、零漂移。
- **组件级 HMR（保留状态热替换）**（2026-08-28 综合评估）：vite build --watch 已覆盖 live reload；保留状态热替换与 v0.10.0 组件实例树 / keepOnDetach / 生命周期语义纠缠，高成本低回报；AI 写 UI 工作流改组件手动刷新可接受。
- **WC 互操作 / customElements 判定 / v-component 豁免 / property-first 绑定**（2026-08-28 用户定）：vhtml 处理的带 `-` tag 一律内部组件，不与原生 Web Components 牵扯——判定分支、豁免属性、绑定特化全部撤销（曾落地后回退）。用户需要引用三方 WC 时自行申请非 vhtml DOM（`no-vhtml` 区域跳过编译 / 手动 DOM 自建），框架不开口子。
