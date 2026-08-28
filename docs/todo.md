# vhtml 路线图（todo）

来源：2026-08-27 机制评估（Web Components 对比 + 全源码审计）+ 2026-08-28 复核修正。已发布 v0.9.2。
原则：无用户期允许破坏性改动；错误该暴露就暴露；不做历史兼容。

每个版本通用验收：`node --test` 全过、`vite build` 重建 dist、aic 4000 debug 环境回归高频页面（chat / agents / explorer / os）；性能/内存不倒退——活 DOM 节点与游离驻留水位对比 0.9.2 基线（`__vhtml_dev` 缓存水位或 heap snapshot 方法论）；语法或契约变化时同步 SKILL.md 与 skill 镜像（~/.cache/aic/u/admin/skills/vhtml/SKILL.md）。

---

## v0.9.2 — 已发布（2026-08-27，git tag v0.9.2）

内容见 docs/CHANGELOG.md：vhtml CLI、模板源/插槽/meta 内存修复、RouterView cacheKey 默认改 path。

**契约联动备忘（长期有效）**：后续版本删除「禁 splice」等响应式契约时，SKILL.md、skill 镜像（~/.cache/aic/u/admin/skills/vhtml/SKILL.md）与 coder agent 记忆三处必须同步，否则后续 AI 会话仍照旧契约写代码。dispose 契约（v0.10.1）与导航语义（v0.10.2）定型时同理。

---

## v0.10.0 — 响应式系统全新重写（reactive.js，破坏性）

主题：不是增量修补——借无用户期把 reactive.js 整体重新设计（用户定调），并把原 v0.10.3（props 浅化）吸收进来。设计骨架六条：

**第一交付物（前置，两个合入点）**：node 挂载级测试床。现状修正（2026-08-28 复核）：test/ 5 个测试文件已全部使用 happy-dom，os_tile_probe / dialog_lazy / vfor 本就是挂载级行为回归——缺的不是测试床本身，而是共享 harness（各文件各自复制约 20 行全局环境注入，抽 test/harness.js）与场景覆盖（props 链/路由/嵌套组件未覆盖）。**合入顺序：第一个提交只含 harness + copyBind 行为快照（同 DataID 合并 / 新实体重建 / 嵌套数组 / 别名四类黄金用例，不动产品代码），重写本体作第二个提交**——copyBind 现有语义是 aic 全部页面的行为基线（2026-08-26 ProxySpreadPitfall 在前），先锁旧行为再重写。

1. **保留的正确决策**：Proxy 自动追踪、数组 `''` 单粗通道（按索引订阅是反模式——splice 后索引身份无意义，已否决）、lazy wrap-on-read、DataID 盖章、SetDataRoot 作用域链、批量异步调度方向。
2. **Effect 句柄取代数字索引**（已定稿）：`callbackList` 全局数组整体删除；`Watch` 返回不透明 handle `{ fn, dead }`（对象身份永不复用），`Cancel(handle)` O(1) 幂等；依赖表 `listeners[lkey]` = `Set<handle>`，`add` 天然去重（顺带干掉现 push + indexOf 的 O(n) 扫描）；`notifyListeners` 迭代时清理 dead 条目（Set 迭代中删当前项安全）。伪回调漏洞与槽位膨胀结构性消失。调用方零改动（已查实 6 处全部不透明存/传）；`window.$vupdate` 无引用直接删。
3. **两阶段 flush + 变更门控**：阶段一重求值 dirty effect 拿新值，阶段二 `Object.is` 比较新旧值、**变了才调用户回调**（可传自定义 equality）——消灭「任何通知无条件触发回调」的伪触发根源。**例外：框架内部恒跑型订阅（v-for reconcile）必须 `equality: null`**——数组原地变异后引用不变，Object.is 会错误门掉。已知边界（写进契约文档，非 bug）：模板表达式每次求值返回新引用（如 `items.filter(...)`）时门控恒放行、恒触发，模板表达式应避免每次产生新引用。
4. **`batch(fn)` 原语**：深度计数器挂起通知、归零单次通知。数组变异方法（`splice/shift/unshift/sort/reverse/copyWithin`）在 get 陷阱内包装自动走 batch；`sort` 比较器窗口内对**其他**对象的写入延迟到 batch 结束才通知（写进语义文档）。`stopChecking` 死开关删除，由计数器取代；同时顺手堵 :214-216 root 链穿透读不注册的追踪洞（读走 proxy）。
5. **删 `deepAccess` / `deep` 选项**：依赖只来自求值时的真实读取，不再全子树遍历注册（现代价 = 子树规模 × 求值次数）。连带吸收原 v0.10.3：component.js:222-229 与 :226-228 的 props `deep:true`、slots.js:63 vbind `deep:true` 全部移除——`:x` 变引用追踪（变更门控下天然成立），深层需求由消费方 `$watch` 具体字段。
6. **copyBind 整体迁出响应式层**：set 陷阱变纯替换（Reflect.set，Object.is 相同不通知；新增/删除 key 结构通道 `''` 不变）。merge 逻辑迁到 compiler.js v-for reconcile 的位置键复用分支（mergeIntoProxy），作为 reconcile 的实现细节——响应式不再持有 DOM 身份语义。附带收益：写路径恢复字段级精确通知（现 copyBind 吞掉）。滞留语义：dead handle 随对应 key 下次通知惰性清理，一次性对象随 proxy 整体 GC，不劣于现状。

调度层：rAF 批量保持；`document.hidden` fallback setTimeout + `visibilitychange→visible` 兜底 flush；新增级联防护——单帧 flush 轮数上限（如 10），超限 throw（写循环死反馈 fail-fast，AI 生成 UI 排障刚需）。throw 必须附带诊断：当前轮数 + 触发的 effect 链（依赖附带清理中的表达式错误定位），裸 throw 无法排障。**保留不变式：flushUpdates 单 watcher try/catch 隔离（reactive.js:21-28，2026-08-11 vedio_studio 崩溃根治所加）重写后必须保留**——一处模板错误不得冻结全页响应式。

消费端改造清单：
- compiler.js v-for：reconcile watcher 传 `equality: null`；位置键复用分支用迁入的 merge 保持行身份；形状重建分支不变。
- component.js props `:x` 分支：删 `deep`，变更门控下默认即引用语义；`v:` 分支本就无 deep，两边恰好对齐。
- slots.js vbind：删 `deep`。
- lifecycle.js / runtime-watch.js / router titleWatchers / compiler 插值 cleanups / module.js locale watcher：切新 API（签名兼容，不透明 token）；module.js 回调预期需审计。
- 契约删除联动：「禁 splice、slice 拷贝再赋回」三处落点（SKILL.md、skill 镜像、coder 记忆）同步删；新增契约文档：变更门控（Object.is）、模板表达式避免每次产生新引用、batch 窗口语义、数组恒 `''` 通知且框架订阅恒跑。

测试：变更门控正反例（值不变不触发/变化触发/`equality: null` 恒触发）；数组六方法 batch 合并单次通知、搬移后相邻元素不同引用（别名回归）；v-for 原地 splice/shift/sort 正确重排且保留行身份（merge 迁入后）；字段级通知精度（改 a 字段不惊醒 b 字段订阅者）；级联防护触发；hidden/visible flush；dead handle 惰性清理。

附带清理（不单列版本）：
- **表达式错误定位（自 v0.10.3 提前，三处消费方的共同地基）**：`buildErrorContext` 增加组件 `vref`/模板 URL + 宿主节点信息——本版本级联 throw 诊断、`__vhtml_dev` 错误登记表、v0.10.3 错误占位渲染都要消费它，改动面小：编译期设模块级「当前编译上下文」（节点/模板 URL），buildErrorContext 取用，避免给所有 Run 调用点加参数。v0.10.3 保留面向用户的错误面。
- **缓存治理**：sandbox.js 的 syncCache/asyncCache 无界 Map 改 LRU + 计数（模板表达式有限，但 AI 动态 parseRaw 的代码串单调增长）；模板缓存同步审计。
- **runtime 鸭子类型 → 显式标记**：`runtime?.$mod || runtime?.$sys || runtime?.scoped !== undefined` 判定（component.js:48、index.js:98/109）换 Runtime symbol 标记。
- **dev 观测层**：借 effect handle + scope 注册表 + 实例映射建 `__vhtml_dev` 登记表（存活 watcher 数、实例树、缓存水位、错误登记表）——同时是 10.1 兜底告警收敛与内存排障的工具。

---

## v0.10.1 — 生命周期确定性（index.js / component-instance.js / router.js）

主题：销毁语义从 observer 推断换成显式注册/注销（借鉴 WC 但不引入 custom elements）。详细方案见 2026-08-27 讨论，五阶段：

- [ ] **阶段 1 契约形式化**：公开导出 `disposeNode(el)`（disposeRuntimeSubtree 封装）；文档化不变式「谁移除 DOM 谁负责 dispose；dispose 幂等」。
- [ ] **阶段 2 observer 降级为兜底**：删除 `_pendingDisposals`/`_cancelPendingDisposal` 取消启发式（rAF 时 isConnected 检查本身就是判据）；兜底真正销毁时打 dev 警告 `[vhtml] disposed via observer fallback`，让依赖兜底的路径可发现并收敛为零。**判据注意**：不能用 `instanceOf(node, false) == null → 跳过` 区分「已显式 dispose」——它会混淆「从未有实例」的节点：外部移除裸 wrapper（自身无实例、内含子组件）时子树实例全部泄漏，现有子树递归遍历恰好覆盖此场景且开销不大（WeakMap 查找）。二选一：保留子树遍历、本阶段重心放在 dev 警告收敛；或维护 disposed roots WeakSet 精确区分后再跳过。
- [ ] **阶段 3 data-keep → 实例字段**：`ComponentInstance.keepOnDetach`，改 router.js:830/857 两处设置点与 index.js:195 判读点，删除 DOM 属性 hack。时序注意：router 的 data-keep 在 parseRef **之前** setAttribute（实例尚未创建），迁移最省事的做法是 createInstance/parseRef 读属性翻译成字段，不挪设置时序。
- [ ] **阶段 4（观察后可选）liveScopes 批量清扫**：MO 只记录「本帧有移除」，单 rAF 扫 liveScopes 回收 `!isConnected && !keepOnDetach && !disposed`，替代逐节点调度。收益是性能不是正确性，前三阶段稳定后再定。
- [ ] **阶段 5 异步挂载统一契约（generation token）**：竞态检查现散落在每个 await 之后（component.js:92/:117 `instanceOf(dom, false) !== instance` 及 router 内同族补丁）。统一契约：每次异步挂载/解析发一个绑定实例代际的 token，所有 await 边界统一 `alive()` 校验，作废时走确定性清理路径。与阶段 1 的 dispose 契约合成生命周期闭环；改造点：component.js parseRef/parseRaw、router.js 导航链路（见 v0.10.2）。**token 原语与 v0.10.2 导航状态机是同一机制：本阶段定义归属模块与接口形状（如 lifecycle.js 导出 createGenToken），v0.10.2 直接复用，不得再造一版。**

测试新增：显式 dispose 后兜底不二次触发（dispose/deactive 计数）；外部 `el.remove()` 仍被兜底回收；keepOnDetach 节点移除后存活、重插后 activate('route')；同帧移动（v-for 重排）不误销；dispose 幂等；异步挂载：await 期间被 dispose 后 token 失效、无孤儿挂载。

风险区：router.js（缓存页软断开、layout 复用、导航竞态），只改标记读写点不碰结构。上线后先在 4000 debug 跑一轮收集兜底告警清单，补显式 dispose 后再进阶段 4。

依赖说明：排在响应式重写（v0.10.0）之后——响应式行为稳定后兜底告警才可信。

---

## v0.10.2 — 路由语义重设计（router.js，破坏性）

主题：用事务化导航模型取代竞态补丁群。77KB 单文件内补丁自认在案（:991-997 layout 死壳、:1458-1471 detachLayout、:1580-1588 缺失 layout、:1634-1638 导航复用、:1739 vparsing purge），根因两条：**layout 归 Page 所有却跨页共享**（于是有 detachLayout/reattach/dropLayoutCache/layoutInUse 整套所有权腾挪）；**导航不是事务**（异步步骤与后续导航交错，逐点打 `activePage !== page` 式补丁）。

- [ ] **导航状态机 + 取消令牌**：idle→resolving→commit，新导航作废旧导航令牌（借 10.1 阶段 5 的 generation token），取代全部散落竞态补丁。
- [ ] **layout 所有权上移**：RouterView 持有 layout 缓存（first-class），页面只按 URL 引用 layout；删除 detachLayout/reattach/dropLayoutCache/layoutInUse 整套机制。
- [ ] **页缓存显式 LRU**：上限（暂定 8，**per-RouterView 实例**——OS 平铺多窗口每窗一个 memory vrouter，全局上限会互相驱逐）+ 驱逐即 dispose；现 cachedPages 无上限，OS 平铺多窗口 memory vrouter（window.html）放大问题。
- [ ] **模块拆分收尾**：语义定型后再拆 history 适配 / matcher / anchor 拦截 / Page / View 五块；严禁把补丁原样搬进五个文件（原 11.0 纯拆分方案作废）。

回归重点：快速连续导航、不同 layout 间返回、缓存页跨 layout 跳转、vparsing 期间切页、OS 多窗口 memory 路由。

依赖说明：排在 10.1 之后——generation token 与 dispose 契约是其地基。

---

## v0.10.3 — 沙箱与错误契约（sandbox.js / component.js / lifecycle.js）

主题：趁无用户把语义决断做掉；终结静默失败。

- [ ] **unsafe 威胁模型决断（a + b 组合，不做二选一）**：
  - 事实修正：a **原理上不可能**建立真正的安全边界——即使所有函数出口都过 `safeFunction`，沙箱内字符串字面量 `"x".constructor.constructor('return this')()` 依然直达 Function（原始值自动装箱不走任何 proxy，而原生值必须暴露）。「评估冻结原型链」一并否决：会破坏大量三方代码。
  - a) 做防误触加固：`createScopeProxy` 里 `$data`/`$mod`/`$sys` 路径返回的函数统一过 `safeFunction`（当前只包 fallback 层，`$data.fn.constructor('return this')()` 可逃逸拿 window）。目标是堵住 AI 生成代码最常见的意外逃逸路径，不是防攻击。
  - b) 文档写死：unsafe 是「防误触层」而非安全边界；真隔离需要 ShadowRealm/iframe 级别方案。
  - 背景：aic 生态 UI 大量 AI 生成，意外路径发布后再堵代价大。
- [ ] **`$emit` 冲突名 fail-fast**：使用 DOM 内置事件名从 `console.warn` 改为 throw（component.js:104-107）。AI 生成的组件看不到 warn，错误必须暴露。
- [ ] **错误契约：终结静默失败（与上条表达式错误定位是一件事的两半）**：现状与「错误该暴露就暴露」原则相反——parseRef catch 后只 console.error + clearParsing（component.js:137-144），元素**静默空白**；compileCode 编译失败返回 null（sandbox.js:245-248），绑定无声失效；inst._scriptError 只覆盖生命周期脚本（lifecycle.js:33），模板/编译/表达式错误无记录。改造：组件级错误面统一（_scriptError 扩展为模板/编译/表达式/挂载四类）+ 声明式错误回退渲染 + dev 模式坏组件显示可见错误占位（而非空白）+ 全局错误登记表（接入 10.0 的 `__vhtml_dev`）。AI 生成 UI 最恶劣的失败形态是坏了但看不见。
- [ ] **`$watch` 50ms 魔法延迟去除**：component.js:163-169 的 `setTimeout(50)` 推迟注册。根因已确认：`<script setup>`（AsyncRun）执行完才轮到 setupRef 的 props 绑定循环（component.js:202-252），setup 内 $watch 立即注册会读到未绑定的 props。确定性修法：setup 期 $watch 进延迟队列，props 循环结束后统一排空（比 microtask 方案可靠——绑定在 AsyncRun 之后同步发生）。同时统一语义：当前 lifecycle.js `<script>` 块的 $watch 是立即注册无延迟，两边不一致，一并走同一队列机制。
- [ ] **表达式错误定位（基础设施已提前至 v0.10.0 附带清理落地）**：本版本只做消费侧——错误面（占位渲染/登记表）直接取用编译上下文；10.0 未覆盖的运行期错误场景在此补齐。
- [ ] **compileCode 注释剥离误伤（低优先）**：`code.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '')` 会剥掉字符串字面量内的 `//`（如 `"http://..."`），影响 isStatement 判断。实测危害比预期低——双编译回退能救大多数错分类，且剥离只影响分类判定、不影响实际编译的代码。字符串感知扫描器很便宜，值得修但排在本版本末位。
- [ ] **评估：has 恒 true 导致未声明变量静默 undefined**——debug 模式下对未命中任何层的裸标识符读取打警告（拼写检查），不改变默认行为。

---

## v0.10.4 — 工具链（cli/vhtml）

主题：AI 写 UI 工作流的静态保障。

- [ ] **`vhtml check` 静态检查命令**：模板表达式语法检查（抓 `v-fo` 类指令拼写、`vslot` 名称配对、表达式语法错误）；与 i18n scan 联动。零运行时成本，可作为 agent 工具直接调用。**载体设计（开工前定案）**：CLI 是 Go 二进制而表达式解析需要 JS（acorn），Go 侧无可用 JS 解析器（goja 太重不值得）。建议路径：checker 主体写成 JS，Go 命令探测 node 执行；或独立成 npm 包（aic agent 工具链直接调）。选前者需定义无 node 环境的降级行为（明确报错而非静默通过）。
- [ ] **WC 互操作口子（单向消费）**：compiler 组件分支前置判断 `customElements.get(tagName)`——已注册为原生 Web Component 的 tag 跳过 vhtml 编译，`:x` 绑定对 WC 走 property 赋值。解决三方 WC 被误当 vhtml 组件 fetch 出 `[Load Error]` 的冲突。三方 WC 名与 vhtml 组件名撞名时不得纯静默偏向 WC——dev 模式打警告（tag resolved to native custom element, vhtml component shadowed）。
- [ ] **组件级 HMR 评估**：CLI live reload 从整页刷新升级为保留状态的热替换；评估成本，不做则记录结论。

---

## v0.11.0 — API 冻结

- [ ] **AOT 绑定计划评估**：per-template 编译一次生成绑定计划（节点路径 → 指令操作），实例化 = clone + 执行计划，替代每实例全树 compileNode 扫描。大列表场景收益显著；不做则记录理由。前置注意：避免把「编译即遍历」假设写进更多模块。
- [ ] router.js 拆分并入 v0.10.2（语义先行、拆分为收尾），本版本不再单列。
- [ ] 文档冻结：SKILL.md + skill 镜像 + README 终稿。
- [ ] **vmessage 移出框架内核评估**：$message 是内核里嵌的具体 UI 组件（544 行、硬编码样式/位置），考虑挪到 vhtml-ui 或主题化；sys.$message 调用面不变。
- [ ] 之后进入 semver 纪律，破坏性改动只走大版本。

---

## 已评估不做（结论存档，避免翻案）

- **custom elements 化 / Shadow DOM 默认化**：全局注册表杀模块级 tag 解析与磁盘热更新；shadow 杀 vcss 穿透、$refs 可观测性与 observer 体系。2026-08-27 评估定论。
- **原生 slot 引用投影替代克隆投影**：vslot 克隆 + caller runtime 编译是语义核心（vbind 作用域属性），原生 slot 语义不匹配。
- **v-for 恢复 `:key`**：自动身份（DataID/位置键/形状）是设计取舍，v0.10.0 splice 修复后契约进一步简化。
- **细粒度 signals 化**（2026-08-27 重设计评估）：抹掉 `$data.items.push()` 裸对象人体工学，全生态写法重写，收益（更细通知粒度）在 Proxy + 变更门控 + v-for merge 方案下已大部分拿到——不值。
- **computed 懒求值缓存**（2026-08-27）：模板表达式作用域随 v-for 行变化，缓存粒度对不上；不做。
- **数组按索引订阅依赖**（2026-08-27）：splice 后索引身份无意义，Vue 同款反模式；数组恒 `''` 单粗通道。
