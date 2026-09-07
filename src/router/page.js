/*
 * router/page.js — 页面与 layout 外壳（游离构建 / commit 接入 / 软断开 / 幂等销毁）
 */

import { Watch, Cancel } from "../reactive.js";
import { Run } from "../sandbox.js";
import { normalizeFetchUrl, templateLoader } from "../loader.js";
import { getModulePath } from "../module.js";
import {
  instanceOf,
  createInstance,
  detachInstance,
  attachChildInstance,
  disposeRuntimeSubtree,
} from "../component-instance.js";
import { routeHash } from "./util.js";

export function prepareLayoutDom(layoutRoot) {
  if (!layoutRoot) return null;
  const outlet =
    layoutRoot.querySelector("vslot:not([name])") ||
    layoutRoot.querySelector("vslot");
  if (!outlet) return layoutRoot;
  outlet.setAttribute("data-vrouter-outlet", "");
  outlet.setAttribute("data-vrouter-managed", "");
  return layoutRoot;
}

export function normalizeLayoutUrl(layout) {
  if (!layout) return "";
  let url = layout;
  if (!url.startsWith("/")) url = `/${url}`;
  if (!url.endsWith(".html")) url += ".html";
  if (!url.startsWith("/layout")) url = `/layout${url}`;
  return url;
}

// ---- 生命周期辅助 ----

/** 树遍历（实例树，visited 防环）。 */
function walkInstanceTree(root, fn) {
  const rootInstance = instanceOf(root);
  if (!rootInstance) return;
  const visited = new Set();
  const walk = (instance) => {
    if (!instance || visited.has(instance)) return;
    visited.add(instance);
    fn(instance);
    instance.children.forEach((child) => walk(child));
  };
  walk(rootInstance);
}

/** 路由分支当前性树维护：commit 换页时旧页 false / 新页 true，激活资格重算。 */
export function setRouteCurrentTree(root, current, reason) {
  walkInstanceTree(root, (instance) => {
    instance.scope?.setRouteCurrent(current, reason);
  });
}

/** commit 接入后的确定性挂载 flush：树上仍处于 building 的 scope 依次 tryMount。 */
function tryMountTree(root) {
  walkInstanceTree(root, (instance) => {
    instance.scope?.tryMount();
  });
}

// ---- Page ----

export class Page {
  constructor(ownerView, renderer, node, matchedRoute, cacheKey) {
    this.ownerView = ownerView;
    this.renderer = renderer;
    this.node = node;
    this.instance = createInstance(node, ownerView.instance, "page");
    this.instance.route = matchedRoute;
    this.instance.cacheKey = cacheKey;
    // layout 外壳为 RouterView 所有（按 URL 缓存），页面仅持有引用；
    // 生命周期（创建/回收）全部由视图侧 #ensureLayoutEntry/#releaseLayoutIfUnreferenced 收口
    this.layoutEntry = null;
    this._destroyed = false;
    this._meta = {
      htmlPath: this.resolveHtmlPath(matchedRoute),
      title: "",
      titleWatchers: [],
      didInitialActivation: false,
      layoutOutlet: null,
    };
  }

  get meta() {
    return this._meta;
  }
  get matchedRoute() {
    return this.instance.route;
  }
  set matchedRoute(value) {
    this.instance.route = value || null;
  }
  get cacheKey() {
    return this.instance.cacheKey;
  }
  get htmlPath() {
    return this._meta.htmlPath;
  }
  get dom() {
    return this.instance.host;
  }
  set dom(value) {
    this.instance.host = value || null;
  }
  get layoutDom() {
    return this.layoutEntry?.dom || null;
  }
  get layoutInstance() {
    return this.layoutEntry?.instance || null;
  }

  resolveHtmlPath(matchedRoute) {
    const params =
      this.ownerView?.mergeParams?.(matchedRoute.params) ||
      matchedRoute.params ||
      {};
    let path = matchedRoute.route.component || matchedRoute.route.path;
    if (typeof path === "function") path = path(matchedRoute.path, params);
    Object.entries(params).forEach(([key, value]) => {
      path = path.replace(`:${key}`, value);
    });
    if (!path.startsWith("/")) path = `/${path}`;
    if (path.endsWith("/")) path = path.slice(0, -1);
    if (!path.endsWith(".html")) path = `${path}.html`;
    return path;
  }

  resolveErrorRedirect(error) {
    const config = this.matchedRoute.route?.error_redirect;
    if (!config) return null;
    if (typeof config === "function") return config(this.matchedRoute, error);
    return config;
  }

  updateRouter(matchedRoute) {
    this.matchedRoute = matchedRoute;
    const router = this.runtime()?.$sys?.$router;
    if (!router) return;
    Object.assign(router.current, {
      path: matchedRoute.path,
      fullPath: matchedRoute.fullPath,
      params:
        this.ownerView?.mergeParams?.(matchedRoute.params) ||
        matchedRoute.params,
      query: matchedRoute.query,
      hash: routeHash(matchedRoute.fullPath, this.ownerView?.navigation),
      meta: matchedRoute.route?.meta || {},
    });
  }

  roots() {
    if (this.layoutInstance?.host) return [this.layoutInstance.host];
    return this.instance.host ? [this.instance.host] : [];
  }

  runtime() {
    return (
      instanceOf(this.dom)?.runtime ||
      instanceOf(this.layoutDom)?.runtime ||
      null
    );
  }

  outlet() {
    if (!this.layoutDom) return this.node;
    this._meta.layoutOutlet =
      this._meta.layoutOutlet ||
      this.layoutDom.querySelector("[data-vrouter-outlet]") ||
      this.layoutDom;
    return this._meta.layoutOutlet;
  }

  /**
   * commit 阶段：把游离构建产物接入活动树。
   * 纯树操作（layout 未连接则接入宿主、内容进 outlet、实例链重建）——
   * 游离 staging 架构下不存在「内容反包 outlet / layout 缺失」等离败形态，
   * 无需防御分支。
   */
  attach() {
    if (this.layoutDom) {
      if (!this.layoutDom.isConnected) {
        this.node.innerHTML = "";
        this.node.append(this.layoutDom);
      }
      const outlet = this.outlet();
      if (this.dom && this.dom.parentNode !== outlet) {
        outlet.innerHTML = "";
        outlet.append(this.dom);
      }
      this.instance.host = this.dom;
      const layoutInst = this.layoutInstance;
      if (layoutInst) attachChildInstance(instanceOf(this.node), layoutInst);
      const contentInst = instanceOf(this.dom, false);
      if (layoutInst && contentInst)
        attachChildInstance(layoutInst, contentInst);
    } else {
      if (this.dom && !this.dom.isConnected) {
        this.node.innerHTML = "";
        this.node.append(this.dom);
      }
      this.instance.host = this.dom;
      const contentInst = instanceOf(this.dom, false);
      if (contentInst) attachChildInstance(instanceOf(this.node), contentInst);
    }
    // 挂载 flush（v0.11）：接入活动树后树遍历 tryMount——游离 staging 期
    // 积累的 building 态 scope 在此确定性迁移（plain script + active 判定），
    // 已 mounted 的（缓存页重入）幂等空转
    tryMountTree(this.node);
  }

  /**
   * resolving 阶段：解析页面组件到游离 DOM。
   * 不触碰活动树——被作废的导航直接丢弃 build 产物即可，不会污染当前
   * 显示；plain script / active 等挂载钩子由 commit 接入后的 tryMount
   * 树遍历补迁移（接入前脚本零执行，作废零脚本副作用）。
   * 返回 { redirect }（error_redirect 命中）或 { built: true }。
   */
  async build(runtime, layoutEntry = null) {
    const parser = await templateLoader.fetchUI(this.htmlPath, runtime);
    if (parser.err) {
      const redirectTarget = this.resolveErrorRedirect(parser.err);
      const matchedRoute = this.matchedRoute;
      this.ownerView?.warn?.("page component load failed", {
        htmlPath: this.htmlPath,
        fetchUrl: normalizeFetchUrl(this.htmlPath, getModulePath(runtime)),
        routePath: matchedRoute.path,
        fullPath: matchedRoute.fullPath,
        component:
          typeof matchedRoute.route?.component === "function"
            ? "[function]"
            : matchedRoute.route?.component,
        modulePath: this.ownerView?.modulePath,
        redirectTarget,
        error: parser.err,
      });
      if (redirectTarget) return { redirect: redirectTarget };
      throw new Error(`load page failed: ${this.htmlPath} ${parser.err}`);
    }
    this._meta.title = parser.title || "";
    this.dom = document.createElement("div");
    this.dom.setAttribute("vsrc", this.htmlPath);
    this.layoutEntry = layoutEntry;
    const layoutRuntime = layoutEntry
      ? instanceOf(layoutEntry.dom)?.runtime || runtime || null
      : runtime;
    await this.renderer.parseRef(
      this.htmlPath,
      this.dom,
      {},
      layoutRuntime,
      null,
      { keepOnDetach: true },
    );
    return { built: true };
  }

  /**
   * 首 mount 失败的降级页（view 侧仅在无在显页面时调用）：不抛穿——错误盒
   * 页面照常 commit，布局外壳照常挂载。初始 deep link 组件 404 若抛穿杀整个
   * 应用 = 白屏，即视觉静默空白，违反错误暴露契约；错误仍三处可见：红盒、
   * console warn、errors 登记表。
   */
  buildError(layoutEntry = null) {
    this.dom = document.createElement("div");
    this.dom.setAttribute("vsrc", this.htmlPath);
    const box = document.createElement("div");
    box.style.cssText =
      "display:block;padding:8px 12px;margin:4px 0;" +
      "background:#fef2f2;border:1px solid #f87171;border-radius:4px;" +
      "color:#991b1b;font-size:13px;line-height:1.4;";
    box.textContent = `[Load Error] ${this.htmlPath}`;
    this.dom.appendChild(box);
    this._meta.title = "Load Error";
    this.layoutEntry = layoutEntry;
    return { built: true };
  }

  updateTitle() {
    this.clearTitleWatchers();
    if (!this._meta.title) return;
    const title = this._meta.title.trim();
    if (!title.includes("{{")) {
      document.title = title;
      return;
    }
    const target = this.dom || this.layoutDom;
    if (!target) return;
    const titleRuntime = this.runtime() || {};
    const varRegex = /{{|}}/g;
    let match,
      nextStart = 0,
      start = -1;
    const parts = [];
    while ((match = varRegex.exec(title)) !== null) {
      if (match[0] === "{{") {
        start = match.index;
      } else if (start >= 0) {
        if (nextStart !== start) parts.push(title.slice(nextStart, start));
        parts.push("");
        const expr = title.slice(start + 2, match.index);
        const partIndex = parts.length - 1;
        nextStart = match.index + 2;
        start = -1;
        const watchId = Watch(() => {
          let value = Run(expr, {}, titleRuntime || {});
          if (typeof value === "function") value = value();
          else if (typeof value === "object" && value)
            value = JSON.stringify(value);
          parts[partIndex] = value;
          document.title = parts.join("");
        });
        this._meta.titleWatchers.push(watchId);
      }
    }
    parts.push(title.slice(nextStart));
    document.title = parts.join("");
  }

  clearTitleWatchers() {
    while (this._meta.titleWatchers.length > 0)
      Cancel(this._meta.titleWatchers.pop());
  }

  // 一次性求值标题（不建 watcher，供缓存页列表等非激活场景读取）。
  // 拆分规则与 updateTitle 一致；表达式求值失败兜底为空串。
  evalTitle() {
    const title = (this._meta.title || "").trim();
    if (!title) return "";
    if (!title.includes("{{")) return title;
    const titleRuntime = this.runtime() || {};
    const varRegex = /{{|}}/g;
    let match,
      nextStart = 0,
      start = -1;
    const parts = [];
    while ((match = varRegex.exec(title)) !== null) {
      if (match[0] === "{{") {
        start = match.index;
      } else if (start >= 0) {
        if (nextStart !== start) parts.push(title.slice(nextStart, start));
        const expr = title.slice(start + 2, match.index);
        let value;
        try {
          value = Run(expr, {}, titleRuntime);
        } catch {
          value = "";
        }
        if (typeof value === "function") {
          try {
            value = value();
          } catch {
            value = "";
          }
        } else if (typeof value === "object" && value) {
          value = JSON.stringify(value);
        }
        parts.push(value ?? "");
        nextStart = match.index + 2;
        start = -1;
      }
    }
    parts.push(title.slice(nextStart));
    return parts.join("");
  }

  activate() {
    if (this.ownerView?.affectsDocument) this.updateTitle();
    else this.clearTitleWatchers();
    this.attach();
    if (!this._meta.didInitialActivation) {
      // 首次激活：attach 的 tryMount 树遍历已完成 mounted 迁移与激活判定
      //（reason='mount'），不再补发 route 激活
      this._meta.didInitialActivation = true;
      return;
    }
    this.roots().forEach((root) => setRouteCurrentTree(root, true, "route"));
  }

  deactive(opts = {}) {
    this.clearTitleWatchers();
    if (!this._meta.didInitialActivation) return;
    const skipLayout = opts?.skipLayout ?? false;
    if (skipLayout && this.layoutDom && this.dom) {
      setRouteCurrentTree(this.dom, false, "route");
      // 只断开与父实例的连接（保留子树），不能用 detachInstance 因为
      // detachInstance 会清空 children 破坏子树，导致 reactivate 时遍历失败
      const inst = instanceOf(this.dom, false);
      if (inst?.parent) {
        inst.parent.children.delete(inst);
        inst.parent = null;
      }
      return;
    }
    this.roots().forEach((root) => {
      setRouteCurrentTree(root, false, "route");
      // 同上：软断开，保留子树
      const inst = instanceOf(root, false);
      if (inst?.parent) {
        inst.parent.children.delete(inst);
        inst.parent = null;
      }
    });
  }

  /** 销毁：释放内容实例与 meta，幂等。layout 外壳为视图所有，不在此处置。 */
  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    this.clearTitleWatchers();
    if (this.dom) disposeRuntimeSubtree(this.dom);
    detachInstance(this.instance);
    this.layoutEntry = null;
  }
}
