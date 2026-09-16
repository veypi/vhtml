# V1–V4 性能优化与验证

2026-09-16。改动覆盖框架源码及 `dist/vhtml.min.js`；没有修改 aic 的消息列表、窗口管理或缓存策略。

## 实现

| 项目 | 行为 |
| --- | --- |
| V1 订阅生命周期 | effect 记录当前依赖，重估解绑旧分支；Cancel 立即退出 dirty、解除所有订阅并释放闭包/返回值；scope 销毁清空生命周期、排队 watch、宿主；分支退出从仍存活的父 scope 删除清理入口 |
| V2 销毁调度 | 每根一个候选 Set，每批一组 rAF/100ms 定时器；先到者取消另一通道，执行时合并父子候选、跳过重新连接和缓存子树；destroy 收取剩余 MO 记录并取消任务 |
| V3 模板节点 | 缓存前清除开发注释，递归 template.content；保留结构锚点和显式边界；空 v-if 只留锚点；空白压缩显式启用 |
| V4 DOM 写入 | 插值按完整文本字符串门控，一个文本节点一个 effect；class 按 token 集合比较并保留静态 class；style 使用浏览器 CSS 解析器生成属性快照，按属性、优先级差异写入 |

v-for 的原地数组变更仍执行 reconcile，行身份和相邻位置复用、batch 事务顺序、级联上限保持原有契约。没有引入视图暂停或编译分片。

## 模板兼容性

默认不删除空白文本，静态文本及插值周围的空白原样保留（旧实现会 trim）。代码缩进和行内文字间距因此不再丢失。普通开发注释在源模板进入共享缓存前移除；需要保留的边界可写 `<!-- vhtml:keep boundary -->`。

```html
<section v-whitespace="compact">
  <div>缩进换行不参与排版的区域</div>
  <span>A</span> <span>B</span>
  <div v-whitespace="preserve">需要保留格式的子树</div>
</section>
```

compact 仅删除含换行的纯 ASCII 空白节点，单行空格和 NBSP 保留。`pre/code/textarea/script/style`、声明保留空白的内联样式、`v-whitespace="preserve"` 子树受到保护。框架不推断外部样式表：若区域由 CSS class 设置 `white-space: pre-wrap`，应显式标注 preserve，或不启用 compact。`no-vhtml`、SVG 等外部命名空间、动态 `v-html` 不参与这次源模板规范化。

`Cancel` 的成本为 O(effect 当前依赖数)，以真实释放资源取代惰性置 dead。已取消 handle 不再保留业务对象。scope 销毁后不能再注册 watcher 或定时器；迟到的 cleanup 立即执行，终态不保留宿主。

## 验证

```sh
npm test
node --expose-gc scripts/check-reactive-gc.mjs
npm run build
```

- 全量测试 232/232 通过（原有 210 项 + 新增 22 项）。覆盖条件依赖切换、自取消/同批取消、异常、嵌套 Watch、20 轮生命周期、常驻父 scope 的分支反复开关、后台 rAF 停止、祖先去重、同帧重插、路由缓存、模板空白、空 v-if、属性 diff。
- 独立 Node GC 实验：外部保留 20 个 canceled handle，原依赖从未再变化，20 份各 1MiB 的 payload 全部回收。
- 真实 Chromium 152 中，源码和压缩产物均通过：CSS 变量/优先级/带分号字符串、字符串和对象 style 切换、静态 class、pre 格式、过期依赖解绑；20 次 mount/destroy 后活跃 effect 和依赖边增量均为 0。
- happy-dom 的 `:class` / `class` localName 索引和 CSS 字符串分号解析存在差异；针对性单测直接安装属性绑定，完整模板和含分号 CSS 在真实浏览器检查。
- 在独立标签页加载原 coder 会话，确认新版计数器存在、页面渲染完成，框架 errors 为空、无 vparsing 残留或错误占位。该会话数据/应用代码可能变化，不把它与旧 Trace 的总节点/总堆直接作前后比较。

## 浏览器对照结果

基准页：`test/browser/performance.html`。用本地静态服务器打开页面点击 Run probe；默认加载源码，`?module=../../dist/vhtml.min.js` 加载构建产物。修改前源码由 Git `5293ac4` 导出到独立目录，使用同一测试页、同一浏览器、同一生成数据。节点数包含 element/text/comment，统计列表在 true→false 切换后的存活子树。

| 场景 | 修改前 | 修改后源码 |
| --- | ---: | ---: |
| 同批移除 10,000 元素的 rAF 申请数 | 10,000 | 1 |
| 一次等值 text/class/style 更新的 DOM mutations | 7 | 0 |
| 100 行节点 / watcher | 1,203 / 401 | 1,003 / 301 |
| 1,000 行节点 / watcher | 12,003 / 4,001 | 10,003 / 3,001 |
| 10,000 行节点 / watcher | 120,003 / 40,001 | 100,003 / 30,001 |
| 1,000 行，显式 compact，节点 | 12,003 | 7,003 |

采样首轮编译耗时（单次观测，非稳定性能承诺）：100/1,000/10,000 行，修改前分别 11.3/78.1/514.0ms，最终源码分别 11.8/57.7/451.5ms；1,000 行 compact 为 46.8ms。生产包相同节点、watcher、调度及 mutation 计数，1,000/10,000 行为 59.5/454.6ms。小样本时间会受 JIT、GC、并发应用影响，核心验收以确定性的工作量计数为准。

没有为总 JS 堆 MB 或 aic 全页面节点数设定固定承诺；aic 是否挂载整段历史、保留多少窗口和缓存仍决定应用的整体规模。框架基准也未取得可对比的强制 GC 后浏览器总堆数据，GC 回收结论来自独立实验，浏览器验证使用生命周期计数。

## 诊断与加载

`window.__vhtml_dev.stats` 提供 liveHandles、dependencyEdges、dirty；`perfStats` 提供 disposalCandidates/Pending/Schedules/Flushes/Roots、templateCommentsRemoved/WhitespaceRemoved、textWrites/classWrites/styleWrites。它们只保存数字，不保存节点或逐 effect 日志；写入计数只记录渲染 DOM，CSS 解析器的临时声明不计入。

代码更新后需要整页刷新一次来加载新框架；仅关闭/重开内部小窗口不会替换已经加载的框架模块。
