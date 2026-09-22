---
name: vhtml
description: Develop and troubleshoot pages and components with the browser-only vhtml framework. Use for vhtml templates, reactive state and list identity, lifecycle and resource cleanup, routing, module context, i18n, or rendering performance. Explains framework usage and its boundaries for application authors.
---

# vhtml Frontend Guide

`vhtml` is a browser-only HTML component runtime: no SSR, no hydration, no virtual DOM — the real DOM is the source of truth. One `.html` file is a full page or a reusable component. `vrouter` is optional. Use vhtml patterns, not Vue/React patterns.

## File Layout

```txt
ui/
  root.html   # app entry
  env.js      # module-scoped setup (optional)
  routes.js   # router-view config (optional)
  langs.json  # i18n translations
  layout/     # router layouts
  page/       # route pages
  local/      # reusable local components
```

## Components

Custom tags map to HTML files by kebab path:

```html
<user-card></user-card>       → /user/card.html
<agent-list></agent-list>     → /agent/list.html
```

Component file shape:

```html
<!DOCTYPE html>
<html>
  <head><title>Counter</title></head>
  <style>
    body { display: flex; gap: 12px; align-items: center; }
  </style>
  <body>
    <button @click="count--">-</button>
    <span>{{ count }}</span>
    <button @click="count++">+</button>
  </body>
  <script setup>
    count = 0
  </script>
</html>
```

A component file must be a **complete HTML document** (`<!DOCTYPE html>` + `html/head/body`, with `<script setup>` inside or after `<body>`). A bare fragment starting with `<template>` / `<style>` / `<script>` is parsed by DOMParser rules that strand those tags in `<head>`: setup never runs and the component renders blank — and the loader then reports a misleading `Failed to load external script: <module-dir>/` 404. That error pointing at a package directory URL is the telltale sign of this mistake.

### Styles

Component styles are automatically scoped to the component's DOM subtree; `@keyframes` names are isolated per component.

```css
.title { ... }          /* matches only elements compiled by this component */
body { ... }            /* the component host node itself (body / :root → host) */
body .title { ... }     /* ALL descendant elements, scope attribute not required — style piercing */
```

With a `body` / `:root` prefix, descendant selectors are no longer scope-restricted — they also reach runtime-created elements (`document.createElement`, third-party library DOM), which plain selectors don't match.

Nested rule blocks are scoped recursively: `@media`, `@supports`, and `@container` (size and style queries) — selectors and `@keyframes` references inside them get the same scope treatment. Other at-rules (`@font-face`, `@import`, …) pass through untouched.

### Props

Attributes on a component tag map to the child's `$data` keys (auto camelCase ↔ kebab-case):

```html
<user-card name="Tom" :age="userAge" v:score="score" disabled></user-card>
```

| form | behavior |
| ---- | -------- |
| `name="Tom"` | static value, assigned once |
| `:age="userAge"` | one-way binding from parent |
| `v:score="score"` | two-way binding |
| `disabled` (bare) | boolean `true` when the key exists in child `$data` |

`v:` two-way bindings support nested paths (`v:value="user.nickname"`, `v:value="settings['app.name']"`).
The binding resolves as a **lazy path chain**: every read/write walks the path from the root
data, so after an intermediate object is replaced wholesale (e.g. `user = await fetch()`) the
binding follows the new object. Complex expressions (variable keys, function calls, operators)
fall back to evaluation-time reference semantics (legacy behavior).

### `$data` Declaration Rules (`<script setup>`)

- Bare assignment (`count = 0`, `save = () => {}`) and ESM imports register on `$data` — public, accessible from template bindings, refs, and parent imperative calls.
- `const` / `let` / `var` / `function` stay private to setup.
- Do not use bare `=` for short-lived locals; use `const` or `let`.

## Runtime Model

Bare identifier resolution order:

```text
$data → own data keys → $mod keys → $sys keys → builtins (framework globals, v-for iteration vars) → window
```

Use explicit prefixes (`$data.xxx`, `$mod.xxx`, `$sys.xxx`) when the source matters or to avoid shadowing.

### `$mod`

Module-scoped context shared by all components under the same `scoped` prefix. Not inherited through parent components.

| key | description |
| ----- | ------------- |
| `scoped` | module path prefix, e.g. `/page` (root module is `""`) |
| `$bus` | module-level EventBus |
| `$i18n` | I18n instance |
| `$t(key, params)` | translation shorthand |
| `fetch(url, options)` | scoped fetch — relative and `/`-prefixed URLs auto-prepend `scoped` |
| `restrictedFetch` | replaces `fetch` in `unsafe` mode — throws on http(s) URLs and cross-scoped paths |
| `define(key, value, opts?)` | define a module entry — see below |

Backend response headers prefixed `vhtml-` (e.g. `vhtml-debug`) are injected as custom keys on `$mod`.

**Local entries and shared (global) entries:** each module has its own `$mod` entries; on top of that there is a per-page shared layer that every module reads and writes:

- Read: a local entry wins; if the key exists only in the shared layer, `$mod.key` returns the shared value (reactive — shared updates propagate to readers in any module).
- Write by assignment `$mod.x = y`: local entry present → writes the local entry; only a shared entry exists → writes through to the shared entry (visible to every module); neither exists → creates a local private entry. Assignment is always legal and equals `define` without opts.
- `$mod.define(key, value, opts?)` = explicit **local** write: never touches the shared layer, so it can shadow a shared same-name entry (that is its purpose vs assignment). `manager.define(key, value, opts?)` (the second `env.js` argument) = explicit **shared** write. Both accept `{ get, set, writable, configurable, enumerable }`; defaults are all `true` (repeated define = overwrite, last wins). Readonly = `{ writable: false, configurable: false }` — later assignment or re-define throws a TypeError. Accessor options are supported: getters re-evaluate reactively, setters notify watchers.
- Built-in keys (`scoped`, `$bus`, `$i18n`, `$t`, `fetch`, `restrictedFetch`, `define`) are readonly — assigning or redefining them throws.
- Define shared entries inside an `env.js`: components start compiling only after env.js finishes, so templates never read a shared entry before it exists. Defining a shared entry later still works, but already-rendered templates that read-missed the key will not re-evaluate — a dev warning is logged.
- `__vhtml_dev.defines` lists every define: `{ name, target: '<scope>|$globals', opts }`.

### `$sys`

System variable pool, inherited from ancestor components via prototype chain.

| key | description |
| ----- | ------------- |
| `$router` | proxy to the nearest ancestor `<vrouter>` |
| `$emit(name, ...args)` | emit custom event to the parent's `@name` handler |

`$emit` event names must not collide with native DOM event names (`change`, `input`, `click`, ...): a parent's `@name` would attach as a native DOM listener and never receive the custom payload. This **throws** (fail-fast). Always pick non-built-in names.

### `$router`

Nearest ancestor `<vrouter>` view, local to the current router subtree.

| API | description |
| --- | --- |
| `push(to, data?)` / `replace(to, data?)` | navigate; `data: { params, query, hash }` |
| `back()` / `forward()` / `go(n)` | history navigation |
| `current` | `{ path, fullPath, params, query, hash, meta, layout }` |
| `params` / `query` | shortcuts to `current.params` / `current.query` |
| `setQuery(patch, opts?)` / `setParams(patch, opts?)` | merge/replace then navigate; `opts: { mode: 'replace' \| 'push', merge }` |
| `onChange(fn)` | subscribe to route changes, returns unsubscribe function |
| `title` | resolved view title: instance name from route `nav.instances` matched by params (preferred) else the page's `<title>`; also written to the vrouter host element's `__title` property. Browser-history views sync it to `document.title`; virtual (memory) views never touch `document.title` |
| `onTitleChange(fn)` | subscribe to resolved-title changes, returns unsubscribe function |
| `addRoute(route)` / `addRoutes(routes)` / `resetRoutes()` | runtime route management |
| `cachedPages()` | cached-page list for tab/page-management UIs: `{ key, title, path, fullPath, isActive, active(), del() }` |
| `dropPage(key)` | destroy a cached page by cacheKey (dropping the active page remounts it ≈ refresh); returns `false` while the page is mid-mount |

Navigation is transactional: the target page is prepared first and switched in atomically; a new navigation supersedes one still in flight. Two idempotence rules: navigating to the **already-current destination**, or repeating the **target of an in-flight navigation**, is a no-op — so URL-sync patterns (`setParams`/`setQuery` inside a setup watcher) are safe even when they fire during the page's own first build. `current.params`/`current.query` already hold the target values before the page starts building, so setup can read its own route params on first run. Anchors without `href` (pure `@click` buttons) are not registered with the router and receive no `href`/`active`; an empty-string target is not a valid navigation (never resolves to the current path).

## URL Prefix Rules

Relative URLs inside a component (template and scripts) are auto-prefixed with `$mod.scoped`:

| scenario | behavior |
| -------- | -------- |
| Script `fetch('data/x.json')` | auto-prefixed (bare `fetch` handled same as `$mod.fetch`) |
| Script `fetch('/abs/x.json')` | **also prefixed** — never prepend `$mod.scoped` yourself (double prefix → 404) |
| Template `<img src="x.png">`, `:src` binding | auto-prefixed |
| **Runtime-created elements** (`document.createElement('img')`, third-party library / engine DOM) | **NOT prefixed** — use full path: `$mod.scoped + '/x.png'` or full URL |
| `http://`, `https://`, `//`, `@/`, `blob:`, `data:` | passthrough, no prefix — `data:` is an inline non-network resource (img src, `fetch(dataURL)`); prefixing would turn it into a package-relative 404 request |

Rules:

1. Inside component code, always write **relative paths** for fetch; the runtime handles prefixing.
2. For images / media / iframe src passed to engines or third-party libraries, build absolute paths with `$mod.scoped`.
3. Bare `fetch()` in the browser console has no prefix — check the network panel for actual URLs; don't infer component behavior from console fetches.

`@/path` strips `@` and bypasses **all** prefixes (scoped, router, component). `javascript:` / `vbscript:` / `data:text/html` URLs are replaced with `about:blank`.

## ESM Import in `<script setup>`

Static imports are supported; relative paths resolve against the component's own URL:

```html
<script setup>
  import PPT from './ppt.js'   // resolves to <component-dir>/ppt.js
  ready = false
  init = async (opts) => { const p = new PPT($refs.host, opts) }
</script>
```

- Imported bindings register on `$data` (public, template-accessible).
- `/xxx` paths get `scoped` prepended; `@/xxx` strips `@`; `.js` is auto-appended.
- `.min.js` and `http://` imports are rejected with a warning — load external libraries via `<script>` tags instead.
- `await import('path')` dynamic imports are supported.
- In `unsafe` mode, all import statements are stripped.
- `unsafe` mode is a **fat-finger guard, not a security boundary**: it blocks common escape tricks, but a determined script can still break out. Never rely on it for real isolation — treat it as protection against accidental mistakes only.

## Bindings

```html
<div>{{ title }}</div>                               <!-- text interpolation -->
<img :src="avatarUrl" :title="name" />               <!-- dynamic attribute (auto URL prefix) -->
<div :class="{ active: isActive }"></div>            <!-- string / object / array all supported -->
<div :style="{ color: 'red' }"></div>
<button @click="save()">Save</button>
<button @click.stop.prevent="remove(id)">Delete</button>
<input v:value="value" />                            <!-- two-way binding -->
<div v-show="loading">Loading...</div>
<div v-if="a">A</div>
<div v-else-if="b">B</div>
<div v-else>C</div>
<div v-for="item in items">{{ item.name }}</div>
<div v-for="(item, idx) in items">...</div>
<template v-for="item in items">                     <!-- multi-root list -->
  <div>{{ item.a }}</div>
  <div>{{ item.b }}</div>
</template>
<div vsrc="/local/card.html"></div>                  <!-- static component -->
<div :vsrc="currentComponent"></div>                 <!-- dynamic component -->
<div v-html="htmlContent"></div>                     <!-- raw HTML, <div> only -->
<div no-vhtml>{{ raw }}</div>                        <!-- skip compilation -->
```

- Text interpolation: function values are auto-invoked, object values are auto-`JSON.stringify`-ed.
- Event modifiers: `.stop`, `.prevent`, `.self`, `.delay[500ms|1s]`; key aliases: `space`, `esc`, `up`, `down`, `left`, `right`, `del`, `ins` (e.g. `@keyup.esc="close()"`).
- Special events: `@outerclick` (click outside the element).
- `v-for` and `v-if` can coexist on the same node: `v-for` clones first, then `v-if` filters each clone.
- All conditions in a `v-if` / `v-else-if` chain are evaluated to select a branch; only the selected body is cloned and compiled. Removed branch effects are canceled immediately, including pending dirty work. Keep condition expressions safe for every state; do not rely on an earlier condition to short-circuit later conditions.
- `v-for` has **no `:key` attribute** — item identity is tracked automatically (objects by reference, primitives by position). A `:key` on a v-for node compiles as a plain inert attribute; delete it.
- Preserve item references when updating lists whose input or component state should survive; see [list identity](#v-for-item-identity-no-key) for replacement and function-source rules.
- Always initialize list variables in `<script setup>`: `items = []`.

### Template whitespace and binding updates

Text and interpolation whitespace is preserved, including code indentation. Ordinary template comments are removed before cloning; keep a required boundary with `<!-- vhtml:keep boundary -->`. Empty `v-if` branches contain only structural comment anchors.

`v-whitespace="compact"` explicitly opts a template subtree into removing whitespace-only text nodes containing line breaks. Single-line spaces between inline elements and NBSP remain. `pre/code/textarea/script/style`, inline styles that preserve whitespace, and `v-whitespace="preserve"` subtrees are protected. If a CSS class preserves whitespace, mark that subtree `v-whitespace="preserve"`; the template normalizer does not inspect external stylesheets. `no-vhtml`, foreign namespaces, and dynamic `v-html` contents are excluded from this normalization.

Text, class and style bindings compare normalized output before writing DOM. Class bindings preserve static classes; style bindings support property removal, CSS variables, priorities and string/object switching. These comparisons are automatic; application code does not need its own cache of the last rendered string or style.

## Script Types

Lifecycle contract (v0.11): every hook's guarantee is **context-independent** — identical whether the component is a routed page (built in detached staging, committed atomically) or dynamically inserted (`v-if`/`v-for`, built in place).

Instance state machine: `setup → building → mounted → disposed`, with an `active` boolean layered on `mounted`:

```
active ⟺ mounted ∧ connected ∧ route-branch current ∧ document visible
```

| type | when it runs | guarantees | forbidden |
| ------ | ------------- | ---------- | --------- |
| `<script setup>` | once at instance creation, before DOM compilation | `$data` ready; target route params snapshot readable | accessing DOM structure / `$refs` / connection state |
| `<script>` | once at the mounted transition: own subtree compiled AND host connected to the document | `$node.isConnected === true`; own template compiled | assuming activation (use `active` for that) |
| `<script active>` | on every activation: first mount, cached route re-entry, tab visible again | connected + current route + visible; `$reason`: `'mount' \| 'route' \| 'visibility'` | — |
| `<script deactive>` | on leaving the active state: route cached, tab hidden; also fired before `dispose` when disposed while active (`$reason: 'dispose'`) | paired with every active period | — |
| `<script dispose>` | when the instance is destroyed (`v-if` removal, page unload) | watchers/timers/cleanups are being collected | — |

Rules of the contract:

- **No cross-instance ordering guarantee.** Child components mount asynchronously (`parseRef` is not awaited); hooks of different instances fire in each instance's own readiness order. Within one instance, `<script>` always runs before the first `active`.
- **Call order, not completion.** `<script>` → `active` guarantees invocation order only; an `await` inside a script does not block the tree.
- **Aborted navigation = zero script side effects.** During route staging, pages/layouts build detached; scripts never run on the detached tree. If the navigation is aborted, the build product is discarded with no plain/active script ever having executed (setup already ran — its *external* side effects like fetches are not rolled back; framework-managed resources like watchers are collected via dispose).
- **`$refs` is a weak guarantee.** A slow async child may not be mounted when the parent's `<script>` runs; guard `$refs.x` access.
- Any state can transition straight to `disposed`; `dispose` is idempotent and reentrant-safe; a throwing cleanup is logged to the error registry without blocking the rest; `addCleanup` on a disposed scope runs immediately.

Helpers available in all script types:

- `$node` — the current host DOM element.
- `$watch(() => expr, (val) => { ... })` — reactive watcher, auto-cleaned on dispose. In `<script setup>` the first evaluation runs after props are bound, so it already sees the incoming prop values; in other script types it starts immediately.
- `$scope` — instance-owned cleanup and tasks: `addCleanup(fn)`, `removeCleanup(fn)`, `addEventListener(target, event, fn, options)`, `setTimeout/clearTimeout`, `setInterval/clearInterval`, `requestAnimationFrame/cancelAnimationFrame`. rAF receives the browser timestamp. One-shot tasks leave the pending collection before calling user code; cancel/dispose suppress queued callbacks and release their captures. Register observers or external subscriptions with `addCleanup(() => observer.disconnect())` / `addCleanup(unsubscribe)`. Late cleanup registration after dispose executes immediately; late task registration returns `null`.

```html
<script>
  const observer = new ResizeObserver(() => { /* measure as needed */ })
  observer.observe($node)
  $scope.addCleanup(() => observer.disconnect())
  $scope.requestAnimationFrame(time => { /* one owned frame */ })
</script>
```

Only tasks registered through `$scope` are owned automatically; bare/native timers and rAF still need explicit cleanup. Removing DOM alone cannot cancel a timer, disconnect an observer or unsubscribe an external service. Register the corresponding release function with `$scope.addCleanup`; already-owned resources do not need duplicate cleanup in `<script dispose>`. A manually released resource should have an idempotent cleanup, or its cleanup can be unregistered with `removeCleanup(fn)`.

**Scope isolation:** each script block is its own scope — `const` / `let` / `function` declared in one block are **not** visible in any other block of the same file. Cross-block state must go through `$data` (bare assignment in setup) or a module singleton (`$mod.define` or an imported JS module).

### Choosing visibility and lifetime

| mechanism | what stays alive | application guidance |
| --- | --- | --- |
| `v-if="open"` | when false, the branch DOM, component instances and owned resources are disposed | use for an expensive view that can be recreated; its local state resets on the next mount |
| `v-show="open"` / CSS hiding | DOM, component state, watchers and tasks remain | use when retaining the mounted view is intentional; hiding alone does not save this work |
| cached route becomes inactive | component state and subscriptions remain; `deactive` runs | stop visible-only animation/polling in `deactive`, restart in `active`; dispose is the final release |

For a disposable child, a parent condition such as `<heavy-panel v-if="panelOpen"></heavy-panel>` is enough; the child does not need its own visibility observer. Framework activation covers route state and document visibility, not arbitrary CSS hiding or a custom host's minimized state. A host that preserves hidden views should pass visibility explicitly and let those views stop their display work. Neither deactivation nor CSS hiding automatically freezes reactive subscriptions or cancels all `$scope` tasks.

### Disposal Contract

- **Who removes DOM owns the dispose**: before externally removing an element that hosts vhtml content (instances / bindings), call `disposeNode(el)` (exported from `vhtml/component-instance.js`). It cleans the whole subtree and is idempotent (returns `false` when there was nothing to clean).
- The framework handles disposal at all its own removal points (`v-for` / `v-if` / `:vsrc` / `v-html` / page destroy). An external `el.remove()` without `disposeNode` is still cleaned up automatically, but logs a dev warning (`disposed via observer fallback`) — treat that warning as a bug in the removing code and switch to `disposeNode`. The warning only fires for DOM created from vhtml templates; foreign DOM (e.g. elements owned by third-party libraries) is cleaned up silently.
- Route-cached pages survive DOM removal via the instance field `keepOnDetach` (managed by the router).

## Refs and Parent-to-Child Calls

`ref="xxx"` is collected into `$data.$refs.xxx`:

```html
<script setup>
  reloadChild = () => $refs.panel.$data.reload()
</script>
<child-panel ref="panel"></child-panel>
```

Host nodes expose `$data`, `$sys`, `$mod`. Prefer `props + $emit` for normal communication; use `$refs.xxx.$data` only for imperative parent-to-child calls.

## Slots

```html
<!-- caller -->
<card-shell>
  <div vslot="header">Header</div>   <!-- projected: caller runtime -->
  <div>Body</div>                    <!-- default slot -->
</card-shell>

<!-- card-shell.html -->
<body>
  <header><vslot name="header"><span>Default</span></vslot></header>
  <main><vslot></vslot></main>       <!-- fallback: child runtime -->
</body>
```

Projected content runs in the caller's runtime (`$data`/`$sys`/`$mod`); fallback content runs in the child's own runtime. `<vslot>` supports `:name` for dynamic slot names. `<vslot vbind="a, b">` exposes the outlet component's `$data` keys `a`/`b` to the projected content (kept in sync on change).

## `env.js`

Loaded once per `scoped` prefix. Use for module-wide services, i18n, config:

```js
export default async ($mod, manager) => {
  $mod.define('config', await $mod.fetch('/config.json').then(r => r.json()))
  $mod.$i18n.load(await $mod.fetch('/langs.json').then(r => r.json()))

  await manager.loadModule('/shared')          // preload a sub-module and wait for its env.js
  manager.addAlias('uikit', '/lib/ui-kit')     // <uikit-button> → /lib/ui-kit/button.html
  manager.define('$auth', authService)         // global entry: every module reads it as $mod.$auth
}
```

- `manager.loadModule(subPath)` — preload a sub-module's `env.js`; `/`-prefixed = absolute, otherwise relative to the current scoped.
- `manager.addAlias(prefix, baseUrl, isGlobal)` — register a component path alias. `prefix` must be letters only (it matches the tag's first `-`-segment); `baseUrl` must start with `/` or `https://`. Non-global aliases only register while an `env.js` is loading; aliases resolve only in non-root modules (`scoped` ≠ `''`).
- `$mod.define(key, value, opts?)` / `manager.define(key, value, opts?)` — module-local vs shared entries (semantics see the `$mod` section).

## Cache & refresh

`templateLoader` (from the vhtml runtime) keeps per-URL template descriptors and per-module contexts. A module that changed on disk can be invalidated at runtime without a full page reload:

```js
import { templateLoader } from '/vhtml/src/loader.js'   // or: window.$vhtml.templateLoader

templateLoader.clearScoped('/skills/local/mypkg')   // drop caches whose URL/scoped starts with the prefix
templateLoader.clear()                              // drop everything (login / user switch)
```

- `clearScoped(prefix)` purges: template descriptors + in-flight fetches under the prefix, injected `<style vref>` nodes under the prefix, and module contexts/aliases registered for matching scopes (`prefix` exactly, or `prefix/…`; `/a` never collides with `/a2`). An absolute-URL prefix targets that origin; a file-level prefix (`…/x.html`) also matches descriptor-level keys (`…/x`); an empty prefix matches everything. `clearScoped(prefix, { keepLive: true })` narrows the purge to descriptors + in-flight fetches + the import epoch, preserving module contexts and `<style vref>` nodes — use it for scopes with live holders (e.g. the root module, where long-lived layout instances registered services like `$os` on the root context and live pages own the style nodes; a full purge breaks services and unstyles the whole app). Styles survive correctly because the dedup key is content-addressed (`vref::cssText`): changed CSS injects a fresh node that wins by order, unchanged CSS dedup-hits; the only residue is a rule deleted from the new CSS still lingering in the old node. Don't use `keepLive` for scopes whose page tree is fully disposed (skill reload) — those need the context drop so `env.js` re-runs and reloads langs/config.
- Prefer the instance ref (`window.$vhtml.templateLoader`) when the host page runs the bundled build — a direct `/vhtml/src/loader.js` import creates a second, independent loader instance in production.
- `scopeOf(url, runtime)` returns the module root (`descriptor.scoped`) of a cached descriptor, or null. Dual-key lookup: the fetch initiator's module path (vrouter host) and the bare path are both tried — the page's own runtime `scoped` (response-header module root) usually differs from the fetch key formula, and a single-key reverse lookup misses silently (file-level fallback then leaks sibling components/styles). Reload flows use it to widen a page refresh to its whole module scope: `clearScoped(scopeOf(pageHtml, viewRuntime) ?? pageHtml)`.
- Semantics = **invalidation, not HMR**: instances and router-cached pages that are already alive keep running the old code; everything loaded afterwards builds from fresh sources. `reload` = `clearScoped` + revisit the route (page cache rebuild).
- Not purged, by design: `compile.js` / `source-cache.js` entries (content-addressed — a changed file naturally misses and recompiles) and head `<script>`/`<link>` nodes (URL-addressed; the browser already caches them by URL).
- In-flight fetches started before the clear are guarded by a cache epoch: their results are discarded instead of being written back into the purged cache.
- Template fetches are sent with `cache: 'no-cache'`: they revalidate against the server (etag/Last-Modified) instead of being served by the browser's HTTP cache. Without this, a cleared descriptor rebuilds from a stale HTTP-cached body — the HTTP cache is a second layer under the descriptor cache, and clearing only the top layer leaves reloads serving old files. `no-cache` revalidates; the etag turns unchanged files into cheap 304s.
- ES module imports (script-setup static `import`, dynamic `await import()`, `env.js`, `routes.js`) ride the browser's native module map, which caches by full URL and exposes no eviction API. `clearScoped`/`clear` therefore also bump an import epoch: afterwards, same-origin import URLs gain a `?__ve={epoch}` query, so they re-enter the module map as fresh entries and re-fetch from the server. External http(s) (CDN) and `blob:`/`data:` URLs are never busted. Across epochs the same file coexists as two module instances (live old pages keep the old one) — consistent with invalidation semantics, not HMR. Note the fix level of your running tab: a tab that loaded the framework before this feature existed needs one full page refresh to pick it up. Coverage boundary: busting applies only at the framework's four import points — transitive native imports inside a busted module (e.g. `import './fsops.js'` within a re-fetched `page_fs.js?__ve=2`) resolve to a clean URL because relative resolution drops the base URL's query, so already-loaded dependency modules stay stale in the module map; changing such a transitive dependency still requires a full page refresh.

Do NOT use `env.js` for route guards, per-page state, or component-local data.

## `routes.js`

Belongs to a `<vrouter>` view. Loaded from the current scoped module unless `vrouter` provides an explicit `routes` path.

```js
// 1. array
export default [
  { path: '/', component: '/page/index.html' },
  { path: '*', component: '/page/404.html' },
]

// 2. factory (recommended when $mod capabilities are needed)
export default ({ $mod, router }) => ({
  path_prefix: '/panel',        // default: $mod.scoped
  component_prefix: '',         // default: ''
  routes: [
    { path: '/', component: '/page/index.html', layout: 'default' },
    { path: '/user/:id', component: '/page/user.html', meta: { auth: true } },
    {
      path: '/admin',
      component: '/page/admin.html',
      layout: 'admin',
      children: [{ path: 'settings', component: '/page/admin_settings.html' }],
    },
    {
      path: '/edit/:id',
      component: (path, params) => `/page/edit/${params.id}.html`,
      redirect: '/login',                          // string | { path, params, query, hash } | (matchedRoute) => target
      error_redirect: '/404',                      // string | (matchedRoute, error) => target
    },
    { path: '*', component: '/page/404.html' },
  ],
  beforeEnter: async (to, from, next) => {
    if (!$mod.auth?.isLogin() && to.path !== '/login') {
      next('/login')
      return false
    }
  },
  afterEnter: (to, from) => { ... },
})
```

Route record fields:

| field | description |
| ------- | ------------- |
| `path` | required. `:param`, `:param?`, `*rest`, `*` (catch-all, keep last for 404) |
| `component` | required. HTML path or `(path, params) => url`; `params` includes fixed `:params` values plus matched route params |
| `layout` | layout name → `/layout/{name}.html`; layouts should expose a default `<vslot>` for the page outlet |
| `redirect` | string, `{ path, params, query, hash }`, or `(matchedRoute) => target` |
| `error_redirect` | fallback when the component fails to load (when unset: an in-app navigation failure keeps the current page and records the error; an initial-mount failure commits a visible error-box page instead of white-screening the app) |
| `meta` | arbitrary metadata, exposed on `$router.current.meta` |
| `nav` | navigation metadata for launcher-style trees: `{ name, icon, keywords, instances }`. `instances` (async fn returning `[{ params, name, ... }]`) is also the vrouter **instance-title source**: on commit the view resolves it and matches items by route params — a hit overrides the page `<title>` (static `nav.name` category labels never do) |
| `children` | nested routes; child paths relative to parent; children inherit parent layout/meta |
| `cacheKey` | `false` (no cache) · string (shared instance) · `(matchedRoute) => key` · default: path-based, query/hash excluded (query changes update router state, page DOM kept) |

`beforeEnter` / `afterEnter` belong in `routes.js`, not `env.js`.

## `vrouter`

```html
<vrouter></vrouter>
<vrouter history="memory" initial="/list"></vrouter>
<vrouter history="memory" prefix="/panel" initial="/list"></vrouter>
<vrouter history="panelA"></vrouter>
<vrouter routes="/admin_routes.js"></vrouter>
<vrouter :routes="routes"></vrouter>
<vrouter :routes="{ routes, path_prefix: '/panel', component_prefix: '/panel-ui', beforeEnter }"></vrouter>
<vrouter :routes="routes" :params="{ app_id: appId }"></vrouter>
```

- Without `routes`, loads the current scoped `routes.js`. `routes` may be a module URL, or `:routes` may bind an array / route-module object directly.
- `:params` injects fixed values into `$router.params`, guard `to.params`, and `component(path, params)` functions; matched path params override same-key fixed params.
- `history`: default = browser routing (`window.location` + `window.history`); `"memory"` = isolated virtual history starting at `initial`; any other value resolves a named history registered via `registerRouterHistory(name, history)`.
- Multiple `<vrouter>` instances per page are allowed.
- Navigation prefix priority: `$router.prefix` > initiating component `$mod.router_prefix` > the router's own route space (`path_prefix`, default = `$mod.scoped` of the module owning the `<vrouter>`). Relative navigation lands in the space of the router you navigate in, never in the initiating component's module scope: a library component mounted elsewhere (e.g. a sidebar from `/v`) pushing `/keys` inside a host router at root resolves to `/keys`, not `/v/keys`.
- Route registration prefixes come from route-module `path_prefix` / `component_prefix`, not from `prefix`. Setting `prefix` without a matching `path_prefix` puts navigation and the route table in different spaces, so nothing matches.
- `@/path` bypasses router normalization and resolves to `/path`; `http(s)://` links are not intercepted.
- `<a>` is intercepted only when compiled under a RouterView runtime, with automatic `active` attribute on path match.
- Virtual routers inject bare `location` / `history` into `$sys`; outside a virtual router those names fall through to `window`. Virtual histories do not update `document.title` (their resolved `title` only lands on the host element's `__title`).
- Debug logging: `localStorage.debug`.

## `$bus`

Module-level EventBus with wildcards:

```js
const off = $mod.$bus.on('user.updated', fn)   // returns unsubscribe function
$mod.$bus.on('user.*', fn)                     // * = exactly one token
$mod.$bus.on('order.>', fn)                    // > = zero or more trailing tokens (must be last)
$mod.$bus.emit('user.updated', payload)
$mod.$bus.emit('@.global.event', data)         // @. prefix: broadcast to other modules only, not local
$mod.$bus.once('ready', fn)
$mod.$bus.emitLocal('evt', data)               // local only, never broadcasts
$mod.$bus.off('evt', fn)
```

## i18n

`$i18n` and `$t` live on `$mod` — translations are module-scoped by default.

```html
<title>{{ $t('page.title') }}</title>
<button>{{ $t('common.save') }}</button>
```

`langs.json`:

```json
{ "zh-CN": { "common.save": "保存" }, "en-US": { "common.save": "Save" } }
```

| API | description |
| --- | --- |
| `$t(key, { count, ...vars })` | translate; `{{var}}` interpolation, `.zero` / `.one` / `.other` plural forms |
| `$i18n.setLocale(lang)` / `getLocale()` | current locale, shared across modules in the page |
| `$i18n.load(messages, merge = true)` | load translations; `merge: false` replaces |
| `$i18n.d(date, opts?)` | `Intl.DateTimeFormat` |
| `$i18n.n(num, opts?)` | `Intl.NumberFormat` |
| `$i18n.c(num, currency, opts?)` | currency formatting |
| `$i18n.rtf(value, unit, opts?)` | relative time ("3 days ago") |
| `$i18n.has(key, locale?)` / `getLocales()` | key existence / loaded locale list |

Key scanning via CLI:

```bash
vhtml i18n scan                    # scan, clean up, report missing keys
vhtml i18n add -json '{"zh-CN":{"k":"v"},"en-US":{"k":"v"}}'
```

### Reserved keys (`_` prefix)

Keys starting with `_` (`_err.40100`, `_theme.dark`) are maintained manually in langs.json: scan skips them for missing/unused checks, `--autoremove` never deletes them. Use for dynamic keys referenced via concatenation, variables, or function args (not exact string literals).

Caution: `scan` detects references by static `$t('key')` literal matching — keys used via concatenation or variables look unused. Treat the unreferenced report as a lead only: before any `--autoremove` deletion, text-search the sources for dynamic references (or keep such keys under the `_` prefix, which autoremove never touches).

## Web Components: No Interop

vhtml does **not** special-case native Web Components. A tag containing `-` is always an internal vhtml component, loaded and compiled by vhtml.

To embed a third-party WC, keep it **outside vhtml's compilation scope** and handle it yourself: a `no-vhtml` region (compilation skipped — set attributes / append children from a setup script or via `v-html` content), or plain manual DOM (`document.createElement` + `customElements` registration in your own code).

## Tooling: `vhtml check`

Static template check for AI-written-UI workflows. Every candidate expression in the template is compiled for verification only — nothing is executed, zero side effects. Requires Node.js; when Node is unavailable the command fails explicitly (exit `2`), never a silent pass.

```bash
vhtml check [path...]            # default "."; skips node_modules/dist/.git, collects *.html
vhtml check --json               # findings as a JSON array (agent consumption)
```

**Input scope:** `*.html` templates only — `.js` files are not supported inputs (JS comments are not masked, so a `<tag>`-shaped literal inside a comment is reported as a structure finding). Config/env JS is covered indirectly via the `<script>` blocks of HTML files.

**Exit codes (stable contract):** `0` = no findings; `1` = findings (E or W); `2` = tool failure (e.g. Node.js missing) — explicit error, never silent pass.

**Output (text):** `<file>:<line>:<col> [E|W] <kind>: <message>`; JSON: `[{file,line,col,severity,kind,message}]`.

**Kinds:** `syntax` (interpolation `{{ }}`, `:bind`, `@handler`, `v-if/else-if/show/html` RHS, `v-for` RHS, inline `<script>` blocks), `vfor` (malformed LHS/RHS), `directive` (unknown `v-` attr — catches `v-fo` typos; bare `@evt` without handler), `vslot-pair`, `structure` (tag balance; legal tag omissions like `li`/`p` are accepted), `io`.

**Ability boundary (do not over-promise):** syntax and structure only — no semantic validation, no undefined-identifier detection (undefined names warn once at runtime). Modifier-only handlers (`@click.stop`) are legal. Files containing Go-template syntax (`{{.`) are skipped wholesale (server-templated sources; only the rendered output can be checked).

## Reactivity Contract & Pitfalls

Nested plain objects and arrays are reactive — no manual wrapping is needed in component data. Updates are batched: multiple writes within the same task collapse into one refresh. Keep watch getters and binding expressions free of writes: mutations made during dependency collection do not notify subscribers.

**Change gate**: a watcher callback fires only when the value actually changed (`Object.is` comparison). Pass `{ equality: null }` to `$watch` for an always-run subscription. A getter returning a fresh array/object on every evaluation passes this gate each time; return a scalar or stable reference when that expresses the dependency you need. `v-for` additionally compares the collected keys, order and values before updating rows.

Dependencies follow the latest evaluation: switching `flag ? a : b` unsubscribes from the unused branch. Cancel is idempotent and immediately unlinks dependencies, pending work and retained callbacks/values; no further source mutation is needed to release an effect. Callbacks and equality comparators do not collect dependencies, including inside a nested watch.

**Shared identity**: within one runtime, aliases of the same ordinary raw object resolve to the same reactive object. Updating it through any reactive path notifies readers through the other paths, including other components. A raw object and its reactive wrapper are still different references; retaining a raw reference does not make writes through it reactive. Iteration locals and slot bindings have their own parent lookup context, while explicitly shared data remains shared.

**Pure-replacement writes**: assignment replaces a value without deep merging. Reassigning the same object preserves identity; allocating another object creates a new identity even if its fields or business `id` match. Replacing an array while retaining its member objects keeps those objects' identities. Function-source list merging is a separate rendering behavior described below.

**Array mutators**: all standard mutators (`push / pop / splice / shift / unshift / sort / reverse / copyWithin / fill`) are safe on reactive arrays; their notifications collapse into one refresh. In-place mutation keeps v-for row identity.

### v-for item identity (no `:key`)

v-for tracks items automatically; there is no `:key` attribute (it compiles as a plain inert attribute — delete it):

| list content | identity | update behavior |
| ------------ | -------- | --------------- |
| ordinary objects in a reactive array/object | object reference, including the same raw object reused in a new array | field mutations patch the existing row; inserting/removing other items preserves this row; a newly allocated replacement rebuilds it even if the business `id` is equal |
| fresh raw objects returned by a function source (e.g. `v-for="tr in tracks()"`) | array position | same shape (equal top-level key set) → merged in place, DOM kept · shape change → entry destroyed & rebuilt; returning existing reactive items instead preserves their object identity |
| primitive items (string/number) | array position | value changes patch in place, DOM kept |
| the same object twice in one list | separate occurrences sharing one record | both rows render and receive shared field updates; repeated occurrences can reuse by position, so do not use them to represent independent editable records |

Structural edits (insert / remove / reorder): either in-place mutators (`splice` / `unshift` / `sort`) or copy-then-assign (`slice()` / spread + assign back) — both are safe; kept items retain identity, so their DOM is preserved and physically re-ordered.

For example, inside a component:

```html
<script setup>
  rows = [{ id: 'a', text: 'First message' }]
  prepend = page => { rows = [...page, ...rows] }
  appendChunk = (id, chunk) => {
    const row = rows.find(item => item.id === id) // read through reactive data
    if (row) row.text += chunk
  }
</script>
```

The existing row survives `prepend`, and `appendChunk` updates its text in place. Mapping every retained item to `{ ...item }` creates new entities in a reactive list and discards row-local state. When a server snapshot represents existing entities, the application can match its business IDs and update those existing reactive objects; the framework does not perform that matching. No application-maintained proxy cache or internal identity field is needed for ordinary lists.

### Large-list boundaries

An equivalent list result skips row reconciliation and DOM writes, but collecting and comparing the list is still O(n). An ordinary `v-for` mounts every included row; it does not automatically virtualize, paginate, unload bodies or limit application caches. Filter out unwanted data before rendering when those rows should not exist. Long histories still need an explicit application rendering window and a cache policy; vhtml currently has no built-in virtual-list directive or helper. Offscreen rows removed by such a window lose their local component state, so keep any state that must survive on the retained data model.

### Other rules

1. Mutating a nested object through a held **raw reference** (`const msg = {...}` then `msg.text = x`) bypasses reactivity — no update. Always write through the reactive path: `d.list[i].text = x`.
2. Streaming can update an existing nested reactive field, as in `rows[i].text += chunk`. Keep retained records stable and avoid rebuilding or cloning the entire history for each chunk; append-only immutable records are not a framework requirement.
3. Write from event handlers, watch callbacks, timers or rAF callbacks; keep watch getters and binding expressions read-only. A watch callback may write reactive data but must not create a feedback loop.
4. A runaway feedback loop (a callback writing its own dependency every round) aborts after 10 rounds in one refresh, throwing an error — check `window.__vhtml_dev.cascadeErrors` for the effect chain.
5. Errors are exposed, never silent: template compilation failures throw; a component that fails to mount renders a visible red `[vhtml] ... failed` placeholder instead of blank space; every compile/expression/mount error is recorded in `window.__vhtml_dev.errors` (newest last) with code preview and component location. Undefined identifiers read inside sandboxed code warn once per name (spelling check). Router page-load failure: in-app navigation keeps the current page and records the error; initial mount (no current page) commits a visible `[Load Error]` box page instead of rejecting the whole mount (white screen = visual silence) — route-level `error_redirect` overrides both.
6. Only plain objects and arrays are proxied — `Node` / `Date` / `RegExp` / `Event` and class instances are already excluded. To keep a plain object raw (a static structure or an object handed to a third-party library), set `__noproxy: true` before exposing it as reactive data. Reads inside that raw object are not tracked; use this only when its internal changes do not need reactive bindings.

## Example

```html
<!DOCTYPE html>
<html>
  <head><title>Home</title></head>
  <style>.card { border: 1px solid #ddd; padding: 16px; margin: 8px 0; }</style>
  <body>
    <h1>{{ $t('page.title') }}</h1>
    <input v:value="keyword" placeholder="Search" />
    <div v-if="loading">Loading...</div>
    <div v-else>
      <div v-for="item in list" class="card">
        <h3>{{ item.name }}</h3>
        <button @click="remove(item.id)">Delete</button>
      </div>
    </div>
  </body>
  <script setup>
    keyword = ''
    list = []
    loading = true

    const load = async () => {
      const res = await fetch('/api/list')   // auto-prefixed with scoped
      list = await res.json()
      loading = false
    }

    remove = (id) => {
      list = list.filter(item => item.id !== id)
      console.log('Deleted')
    }

    load()
  </script>
</html>
```
