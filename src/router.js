/*
 * router.js — 客户端路由器（门面，v0.10.2 拆分）
 *
 * 实现按职责拆分到 router/ 六模块（单向依赖 util → history/matcher/anchor → page → view）：
 *   router/util.js    路径与路由目标纯函数工具（无状态）
 *   router/history.js history 适配：memory 实现、browser 单例、具名注册表
 *   router/matcher.js 路由匹配（RouteMatcher）与路由模块归一化
 *   router/anchor.js  <a> 链接拦截与 active 态同步
 *   router/page.js    页面与 layout 外壳：游离构建 → commit 接入 → 软断开 → 幂等销毁
 *   router/view.js    RouterView：导航状态机（idle → resolving → commit）、
 *                     layout 外壳缓存（视图所有）、页缓存 LRU、$router 运行时入口
 */

export { createMemoryHistory, registerRouterHistory } from './router/history.js'
export { bindAnchorRouter, syncRouterAnchor } from './router/anchor.js'
export { RouteMatcher, parseUrlString, normalizeRoutesModule } from './router/matcher.js'
export { prepareLayoutDom } from './router/page.js'
export { $router, setRouterRoutesSource, setRouterPrefixSource, setRouterParamsSource } from './router/view.js'
