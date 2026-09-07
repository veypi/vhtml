# 更新日志

本项目的所有重要变更都将记录在此文件中。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)，
并遵循 [语义化版本](https://semver.org/lang/zh-CN/spec/v2.0.0.html)。

## [Unreleased]

## [0.11.0] - 2026-09-08

### 变更（破坏性）
- **组件生命周期重新设计（状态机显式化）**：实例状态机 `setup → building → mounted → disposed`，`active` 为叠加在 mounted 上的布尔子态。核心修复 = v0.10.0 导航 staging 化引入的语义漂移：plain `<script>` 与 `active('mount')` 此前在「构建完成」触发（页面游离构建时宿主未连接），现统一收口到 **`tryMount()` 资格制迁移**——`building ∧ 宿主已接入文档` 才执行 plain script 并做激活判定。契约上下文无关：路由页（staging 构建）与动态组件（原地构建）的脚本都保证 `$node.isConnected === true`。挂载钩子两个触发源：`Page.attach()` 树遍历 flush（确定性主路径）+ 新增 `connection.js` 窄连接观察（仅 pending 时挂 MO，覆盖外部游离宿主插入/嵌套路由 staging commit 等框架外接入点）。作废导航零脚本副作用（脚本从未执行，setup 外部副作用不回滚，框架托管资源经 dispose 回收）
- **激活资格单一决策点 `reconcileActivity(reason)`**：`active ⟺ mounted ∧ connected ∧ 路由分支当前 ∧ 文档可见`。路由（`setRouteCurrent` 树维护）/连接/可见性任一变化重算资格做迁移；取代 visHiddenScopes 集合追踪（旧机制覆盖不了 hidden 期间首次 mounted 的组件，复显漏激活）
- **scope 公开面改名**：`scope.state`（'created/active/inactive/disposed'）→ `scope.phase`（'setup/building/mounted/disposed'）+ `scope.active` 布尔；`scope.activate()/deactive()` 移除（迁移唯一入口 `tryMount()` + `reconcileActivity()`/`setRouteCurrent()`）
- **`@mounted` 事件整套机制删除**（init 时代遗留，生命周期重设计后冗余，全仓零使用）：`compiler-attrs.js` mounted 分支、`index.js` `_onMountedRun`/`vdelay`/`_delayCache`、`lifecycle.js` `runMountedHandler` 全部移除；VHTML 实例 MO 不再处理 addedNodes（只保留 removedNodes 销毁兜底）；`slots.js` owner 未就绪重试迁移到 `whenConnected`（一次性登记取代常驻重试，修复重复接入叠加 watcher 的旧缺陷；接入后仍无 owner 显式警告）

### 契约成文（SKILL.md Script Types 章节重写）
- 跨实例无顺序保证（子组件异步挂载，两个时代皆然）；同实例 plain 先于 active
- 调用序非完成序：plain → active 不等待脚本内 await
- `$refs` 弱保证（慢子组件可能未就绪，访问需判空）
- 测试 `test/lifecycle_mount.test.js` 7 用例：staging 页 connected 断言、作废导航零执行、缓存重入 active(route)、v-if 双上下文一致、hidden commit 的 script/active 分离、dispose 抗错、disposed 后 cleanup 立即执行

### 新增
- **`clearScoped(prefix)` 按 scoped 前缀清缓存**：模块磁盘内容变更后运行时刷新——不清页面、不整站 reload。`templateLoader.clearScoped(prefix)` 清模板描述符/在途 fetch/head 注入样式（`style[vref]` 节点真移除，旧实现永久驻留）/同前缀模块上下文与别名；前缀匹配整段边界（`/a` 不撞 `/a2`），支持绝对 URL scoped 与本源 origin 双键形态，文件级 prefix（`…/x.html`）兼容描述符级键，空前缀 = 全部。语义 = invalidation 非 HMR：已存活实例照旧运行，之后加载用新源；reload = clearScoped + 重访路由。另有 epoch 守卫：clear 时在途 fetch 完成的结果丢弃，不回流缓存。`manager.clearScoped` 为模块层对应物（modMap/_aliasMap 前缀清除，空前缀 = 全部模块上下文；globals 是全局层不动）。`clear()` 全清补上原缺失的样式回收。**`clearScoped(prefix, {keepLive})`**：只清描述符/在途 fetch/穿透令牌，保留模块上下文与 style 节点——适用有存活持有的 scope（根模块：常驻 layout 把 $os 类服务注册在根上下文、存活页面的 style 节点不随重建恢复；全清会丢服务且全站掉样式，实测中招）；样式去重键 vref::CSS文本 内容寻址使保留旧节点基本无害（CSS 变更追加新节点居后胜出，未变更去重命中；边角=被删规则残留旧节点）。页面树整体 dispose 的 scope（skill 页）勿用，要重跑 env.js 刷 langs
- **`templateLoader.scopeOf(url, runtime)` + `VHTML` 实例暴露 `templateLoader`**：reload 流按模块根刷新——`scopeOf` 反查已缓存描述符的 `scoped`（未缓存返回 null），调用方 `clearScoped(scopeOf(...) ?? url)` 即整包页面+子组件全失效（文件级清漏子组件）；**双键查找**（runtime 模块路径键 + 裸路径键）——fetch 发起方模块路径（vrouter 宿主）与页面解析后 runtime scoped（响应头模块根）常不一致，单键公式拼双前缀键必 miss（4000 实测：reload 退回文件级清、子组件旧样式残留，本修复验证通过）；实例属性 `window.$vhtml.templateLoader` 让宿主页面拿到与运行时同一单例（生产 bundle 直接 import `/vhtml/src/loader.js` 是另一份独立模块实例，清不到本缓存）
- **`SpaConfig(router, uiFS)`**：导出 SPA 壳的 `ufs.WithSpa` 三元配置（root.html 名、内容、scoped resolver），供"文件优先 + 目录/缺失对浏览器导航成壳"协商语义的 UFS handler 直接挂载（首个用途：aic `/fs/cloud` 文件服务——其 FS 是用户 UFS，壳内容必须显式传入，content=nil 会让 handler 去用户 UFS 找 root.html 必失败）。`SPAHandler` 是其成品 handler 封装（行为不变，仍含 env 响应头）。调用约定同 SPAHandler：须 UI 属主包直接调用（debug 按调用方目录磁盘直读）；壳内容在配置构建时一次性读入，debug 下改 root.html 需重启才反映到该挂载点

### 修复
- **dispose 抗错强化**：cleanup/生命周期回调逐个 try/catch 隔离，单个抛错进错误登记表（kind='lifecycle'）不阻断剩余回收（旧实现 `cleanups.splice(0)` 循环会被异常打断）；disposed 后 `addCleanup` 立即执行（异步脚本善后注册不泄漏）；dispose 撤销 whenConnected 登记
- **ESM import 吃浏览器原生模块缓存致 reload 拿不到新 JS（clearScoped 第三层根因）**：script setup 静态 import、动态 `await import()`、`env.js`、`routes.js` 全走浏览器原生模块表——按完整 URL 永久缓存（文档级），无任何 Web API 可驱逐，`clearScoped` 清描述符/模块上下文管不到它。表现：改任何 .js（平台 `/os/*.js`、`/assets/libs/*.js`，skill 的 `lib/*.js`、`env.js` 本身）后窗口 reload 的 HTML 是新的、import 绑定的 JS 全是旧模块，只有整页刷新才更新。修：新增 import 穿透令牌（module.js `importEpoch`/`bumpImportEpoch()`/`withImportBust(url)`）——`clear()`/`clearScoped()` 递增令牌，四个 import 点（imports.js 静态与动态重写、module.js env.js、router/view.js routes.js）在令牌非 0 时给同源 URL 追加 `?__ve={n}`（新 URL = 新模块表条目，强制网络重取；服务端对 query 无感，etag 协商仍生效）。外部 http(s)（CDN）与 blob:/data: 不穿透；跨令牌同文件并存两个模块实例（旧页面实例持旧引用），与 invalidation 语义一致。动态 import 的令牌在 parseImports 重写时烘焙（清缓存后必重编译，烘焙值恒为当前代次）。测试 `test/import_bust.test.js` 7 用例。注意：运行中的 tab 若在本特性之前加载框架，需一次整页刷新才能装上本修复。覆盖边界：穿透只覆盖四个框架 import 点——被穿透模块内部的原生相对 import（如 page_fs.js 里的 `import './fsops.js'`）按 URL 规范解析时基址 query 被丢弃，落到无 __ve 的干净 URL 仍命中模块表旧条目，改这类传递依赖仍需整页刷新
- **模板 fetch 吃浏览器 HTTP 缓存致 reload 失效（clearScoped 第二层根因）**：描述符缓存清掉后，重建 fetch 不带 cache 选项，被浏览器启发式缓存直接喂旧文件（实测：改盘上 skill 文件 → clearScoped + dropPage → 页面仍是旧内容；同 URL `cache:'no-store'` 拉取则含新内容）。修：`fetchFile`/`fetchUI` 的 fetch 统一加 `cache:'no-cache'`——与服务端协商（etag/Last-Modified），不直接吃本地缓存；未变更 304 由服务端 etag 消化，成本不增
- **首 mount 页面加载失败白屏杀全站**：组件 404 时 `Page.build` 抛穿 → `#stageNavigation` 重抛 → `mount()` rejection 无人接 → 整个应用白屏（视觉静默空白，恰违错误暴露契约）。修：无在显页面（首 mount）时降级为错误盒页照常 commit（`Page.buildError`——`[Load Error] <htmlPath>` 红盒 + 布局外壳挂载 + `errors` 登记表 `navigation` 项 + console warn），应用存活；在应用内导航失败语义不变（保留当前页 + 登记表，`#swallowNav` 吞 rejection）。`error_redirect` 优先级高于该降级。实测场景：aic skill 包页面客户端子路由刷新（/skills/{id}/abs）组件 miss 不再白屏
- **data: URL 被 scoped 前缀化致内联资源失效**：data: 是内联非网络资源（img src、fetch(dataURL)），三处 scoped URL 解析（loader normalizeFetchUrl→resolveScopedUrl、模块 mod.fetch、restrictedFetch）此前当普通路径加前缀变成包内 404 请求。修：三处一律透传（loader/模块层与 blob: 同语义；模板属性层 sanitizeUrl 仍拦截 data:text/html 防注入，安全分层不变）。测试 `test/scoped_url.test.js`

## [0.10.4] - 2026-08-31

### 新增
- **`SPAHandler`（WrapUI 抽离）**：壳 handler（root.html 模板 + scoped 注入 + env 响应头 + embed 内容哈希 etag）原封在 `WrapUI` 闭包内，动态文件路由无法复用；现抽为导出 `SPAHandler(router, uiFS, args...)`，`WrapUI` 委托之（行为不变）。调用约定同 WrapUI：须 UI 属主包直接调用（debug 磁盘直读取调用方目录）。用途：aic/skills 包文件路由与 SPA 页面同址，文档导航直达 .html 时由包文件路由回落壳（组件 loader 带 X-No-Fallback 重取走原样分支）

### 修复
- **embed 前端 ETag 陈旧缓存（生产 304 假命中发旧内容）**：go:embed 文件 mtime 恒为零，vigo 默认 etag（size+mtime）退化为纯尺寸函数——文件同尺寸修改后 If-None-Match 仍命中旧 etag，304 返回旧缓存（embed 部署升级后浏览器不更新，实测中招）。修复：init 新增 `embedETags()`——启动对 embed FS 全量 Walk 计算 sha1 内容哈希表（map[路径]quoted-etag，文件本在内存成本可忽略），经 vigo 新增 `WithETagCache` 注入 Handler；vhtml 自路由与 `WrapUI` embed 分支两处接入。debug 磁盘分支不注入（mtime 真实且需随编辑实时变化，注入反而冻住 etag）。依赖 vigo ufs 同步修复（resolveSpa etag 改内容哈希）

## [0.10.3] - 2026-08-29

### 变更（破坏性）
- **`$message` 移出内核**：`src/vmessage.js` 删除，改由 vhtml-ui 提供——vhtml-ui env.js 经 `all.define('$message', vmessage)` 注册到 manager.globals（守卫读防多挂载点重复 define），应用根 env.js 装配 `all.loadModule("v")`（须先于 vbase 装载）。模板/脚本调用面零改动（`$message` 经 $mod root 链回落解析）；`$sys` 暴露面同步收窄。docs 示例页（examples/runtime_smoke/preview）改用内联实现，docs sys 表标注来源。

### 变更
- **AOT 行模板计划化评估后撤回（实测收益不成立）**：v-for 行计划化（buildRowPlan/instantiateRowPlan）落地后同日撤回——结构编译耗时占比 62-92% 的大头是绑定安装/DOM 而非行分发，真实语料 full 200 行实测持平偏负（63.5ms vs 57.9ms），仅纯结构行 -40% 无实际场景；且 instantiateRowPlan 对 compileVif/compileNode 逐行镜像带来永久双份维护债（落地期间已产生 3 个镜像漂移 bug）。撤回后 `__vhtml_dev.compileStats` 保留 5 项轻量诊断（nodeCompiles/nodeMs/codeCompiles/codeMs/vforLines）。教训：编译优化立项前必须把「分发开销」与「绑定安装/DOM」在计时上拆开测量。

## [0.10.2] - 2026-08-28

### 新增
- **`vhtml check` 静态检查命令**：AI 写 UI 工作流的静态保障——模板内每个候选表达式仅编译验证不执行（零副作用）。复用新剥离的纯编译核 `src/compile.js`（compileCode/stripComments/编译缓存/编译上下文自 sandbox.js 迁出，零 DOM 依赖，浏览器与 node 检查器共用同一文件，检查语义 = 运行时语义）。能抓：表达式语法错误、指令拼写（`v-fo`）、vslot 名称配对、模板结构错误；不能抓：语义（未定义标识符静态静默）。受支持输入 `*.html`；无 node 环境明确报错（exit 2）不静默通过。text/JSON 双输出（JSON 供 agent 消费）。

### 修复
- **只读锁 sloppy 静默**：组件代码经 `new Function` 编译为非严格模式，对描述符锁属性赋值曾静默 no-op 且不进错误登记表；Wrap set 陷阱 `Reflect.set` 返 false 时显式 throw TypeError（含 getter-only 访问器）——fail-fast 不依赖调用方严格性。
- **recordDefine 顺序**：登记表先于 defineProperty 执行，锁属性再 define 抛错时留幻影条目；改为执行成功后才登记（$mod.define 与 manager.define 两处）。
- **defineRegistry 不随 clear() 清空**：manager.clear() 增 `defineRegistry.length = 0`（原数组引用，__vhtml_dev.defines 同步清空）。
- **并发模块加载单槽错配**：await 交错时 `_loadingMod` 单槽错配 recordDefine 归属、误抑制 outside-env 警告；改 `_loadingStack` 数组 + 栈顶 getter，loadEnvConfig push/pop 自平衡。
- **嵌套 v-for 触发 observer 兜底 dev 警告**：`<template v-for>` 多根行内嵌 v-for 时 compileVfor 的 replaceWith 未 dispose 行根（刚挂 boundary 实例）→ MutationObserver 兜底回收报警告；修复为替换前 `disposeRuntimeSubtree(dom)`（实例尚为空壳释放安全；常规流程无实例幂等空转）。

## [0.10.1] - 2026-08-28

### 新增
- **`defineProperty` 原语（reactive.js 导出）**：`Object.defineProperty` 的响应式增强。普通对象 = 纯 defineProperty 语义（descriptor 默认值 configurable/writable/enumerable 全 true，重复 define 覆盖）；Wrap proxy 新装 key = 描述符安装 + 通知（key 通道 + 对象 `''` 结构通道）；已有 own key（数据语义）= 赋值语义（覆盖+通知）；带 get/set = 描述符语义——getter `this = 代理`、体内读字段注册依赖，setter 写入经 Wrap set 陷阱通知。显式目标写入永不触发 root 链穿透。
- **$mod 二级对象树**：模块 `$mod`（本地条目）→ root 链 → `manager.globals`（全局层，per-page `Wrap({})`）。本地 miss + 全局命中 → 读穿透（响应式）；赋值写穿透（全局命中写全局、都没有建本地私有）；`$mod.define` 显式本地（可遮蔽全局同名键），`manager.define`（env.js 第二参 `all.define`）显式全局。框架内置件（scoped/$bus/$i18n/$t/fetch/restrictedFetch/define）装配期 define 锁只读。`__vhtml_dev.defines` 登记表（name/target/opts 摘要）。`manager.define` 在 env.js 装载期之外调用打 dev 警告（装载顺序不变式：组件编译恒晚于 env.js，先读 miss 后 define 的模板不重估）。

### 变更（破坏性）
- **addWrapper 整套机制删除**（module.js ~40 行 + loader 透传 + `entry.applied` 占位 + 三段时序注释）：跨模块共享从「逐模块复制引用」改为 globals 动态回落，时序窗口（晚注册漏注/双写/去重占位）机制性消失。aic/vbase/aiv/rses env.js 全部迁移（6 平台服务 + `$auth` → `all.define`；`$local`/`$err`/`$fetch` 等保持本地 define 不扩大共享面）。
- **lockProperty 删除**：只读语义并入 define 描述符锁。
- **router_prefix 兜底清理**：删除 aic/aiv/rses env.js 三处 `mod.router_prefix = mod.router_prefix || $mod.scoped` 兜底 wrapper（真实语义是压平到树根 scoped；view.js `!== undefined` 守卫使删除后自然回落自身 scoped）；`$router.router_prefix` getter 改名 `$router.prefix`（无别名）；`aic/agents/env.js` 的 `$mod.router_prefix`（/agents→/a 映射，全仓唯一真实设置者）保留；rses `loadModule("aiv")` 遗留路径删除（aiv 已并入 aic）。

### 修复
- define-on-existing-key 遇 Object.is 相同值时 set 陷阱早退导致内置件锁未生效：内置件改在 raw 对象装配期 define（纯语义），wrap 后再绑 `define` 自身。

### 新增
- **响应式系统全新重写（破坏性）**：Effect handle（对象身份）取代全局数字索引——`Watch` 返回不透明 handle，`Cancel` O(1) 幂等，依赖表改为 `Set` 天然去重，伪回调漏洞与槽位膨胀结构性消失。两阶段 flush + 变更门控：重求值后按 equality 比较（缺省 `Object.is`），变了才调回调；框架内部恒跑型订阅（v-for reconcile）传 `equality: null` 豁免。`batch(fn)` 原语：深度计数器挂起通知、归零按 listeners×key 去重单次通知，数组变异方法（splice/shift/unshift/sort/reverse/copyWithin/fill）在 get 陷阱自动返回 batch 包装（per-proxy 缓存、函数身份稳定），sort 比较器窗口内对其他对象的写入延迟到 batch 结束。级联防护：单帧 flush 10 轮上限，超限调度层 throw（不被单 watcher 隔离吞掉）并附 effect 链诊断，`__vhtml_dev.cascadeErrors` 可查。`document.hidden` 时 setTimeout 双通道兜底 + visibilitychange 强制 flush。
- **生命周期确定性**：公开 `disposeNode(el)` 销毁契约（谁移除 DOM 谁 dispose、幂等）；observer 降级为兜底并在真正清理时打 dev 警告（只警告 vhtml 模板衍生 DOM，三方库自管 DOM 静默回收）；`keepOnDetach` 实例字段取代 data-keep DOM 属性 hack；generation token 统一异步挂载竞态（await 边界 issue/alive 校验，嵌套异步段复用父票据）。
- **路由导航状态机（破坏性）**：导航事务化——staging（守卫+页面游离构建）→ commit（同步原子切换），新导航令牌作废在途导航，被作废导航零可见副作用（不换页/不改地址/不跑生命周期）；同目标与已激活导航 no-op 吸收（单一决策点）。staging 期写入目标参数快照，作废/阻断/redirect 回滚到最近提交快照——新页面 setup/模板首次构建即可读到目标路由参数。layout 外壳所有权上移 RouterView（活性校验 + 引用计数回收）；页缓存显式 LRU（上限 8，per-RouterView 实例，OS 多窗口互不驱逐）；`router.js` 拆分为 `router/{util,history,matcher,anchor,page,view}` 六模块 + 门面。
- **全局错误登记表**：新模块 `errors.js`（ring 100），`__vhtml_dev.errors` 为排障唯一聚合入口，编译/表达式/挂载/navigation 四类错误统一登记。

### 变更
- **set 陷阱纯替换（破坏性）**：深度合并（旧 copyBind）从写路径整体移除，迁为显式 `mergeIntoProxy` 由 v-for reconcile 位置键复用分支调用；写路径恢复字段级精确通知。数组元素整体赋值 `list[i] = {...}` 变为新身份（条目重建）而非原位合并。
- **响应式契约简化（破坏性）**：「禁 splice、slice 拷贝再赋回」废除——数组变异方法安全且保留行身份；`deep`/`deepAccess` 删除——依赖只来自求值时的真实读取，props `:x` 改引用语义；root 链穿透读补注册本地 key 通道（修复旧追踪洞）。
- **$watch 延迟队列**：删除 setup 内 $watch 的 50ms 魔法延迟——setup 期注册入队，props 绑定完成后统一排空（比 microtask 可靠）；生命周期脚本同机制，两条路径统一。
- **错误暴露规则（破坏性）**：`$emit` 使用 DOM 内置事件名从 console.warn 改为 throw；compileCode 编译失败从返回 null（静默失效）改为 throw + 登记；组件挂载失败渲染可见错误占位（pre.vhtml-error）取代静默空白；未命中任何层的裸标识符按 key 去重打拼写警告（行为不变，错误可见）。
- **unsafe 威胁模型定调**：unsafe 是「防误触层」而非安全边界（字符串字面量 `"x".constructor.constructor` 原理上可直达 Function，真隔离需 ShadowRealm/iframe）；$data/$mod/$sys 路径返回的函数统一过 safeFunction 堵住最常见的意外逃逸链，与 lockProperty 只读不可配置属性的 Proxy 不变式兼容。
- **compileCode 注释剥离**改字符串感知扫描器，不再误剥 `"http://..."` 内的 `//`（isStatement 分类正确性）。
- **导航 rejection 收口**：fire-and-forget 导航（锚点点击/redirect/守卫 next/dropPage 重建/history 监听）的页面加载失败统一登记进错误登记表，不再产生 unhandled rejection；直接 await `push()/replace()` 的调用方仍会收到 rejection。
- 导航目标校验收紧：空目标非法（曾被 `new URL('', 当前地址)` 解析成当前路径，污染无 href 锚点的 href/active）；无 href 锚点（纯 @click）不再被注册 active 同步。

### 修复
- **嵌套异步段票据作废父段**：setupRef 内部另行 issue 会作废 parseRef 在途票据，导致全部含 `<script setup>` 的组件编译中止（模板体插入但插值不渲染）；修复为子段复用父段票据，契约写入 lifecycle.js 注释。
- **disposeRuntimeSubtree 幂等契约破坏**：实例分支提前 return 跳过 DOM 子树遍历，纯元素后代 meta 残留使二次 dispose 返回 true；修复为统一「清实例树 + 清自身 + 遍历 DOM 后代」。
- **staging 后同目标导航作废在途构建**：参数快照修复使构建页自身 setup 的 URL 同步 watcher 首轮回调发起同目标导航，领票即作废在途票据——push 跳转无反应、直开 `/a/:id` 无限构建循环卡死；修复为 issue 前同目标/已激活守卫。
- **routes reload 泄漏 layout 外壳**：resetRoutes 整体丢弃缓存表前未销毁存活外壳实例（实例/watchers 泄漏）。
- **挂载失败路径 scope 未销毁**：parseRef catch 只渲染占位未 dispose，已注册 props watchers 留待 observer 兜底；现走唯一销毁口。
- **cascadeErrors 无界增长**：级联诊断 ring 上限 50。
- **锚点拦截 head 加载崩溃**：模块在 <head> 加载时 document.body 不存在，延迟到 DOMContentLoaded 绑定。

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
