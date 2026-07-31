---
name: vhtml
description: vhtml browser-only HTML component framework user manual — components, script setup, bindings, props, URL prefix rules, ESM import, slots, refs, env.js, routes.js, vrouter, $data/$sys/$mod/$router, $t/$i18n, $bus, $message, lifecycle scripts. Read this guide whenever a task involves vhtml pages, components, routing, i18n, or module-scoped concepts.
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

### Styles

Component styles are automatically scoped to the component's DOM subtree; `@keyframes` names are isolated per component.

```css
.title { ... }          /* matches only elements compiled by this component (scope-attributed) */
body { ... }            /* the component host node itself (body / :root → host) */
body .title { ... }     /* ALL descendant elements, scope attribute not required — style piercing */
```

With a `body` / `:root` prefix, descendant selectors are no longer scope-restricted — they also match runtime-created elements (`document.createElement`, third-party library DOM) that carry no scope attribute. Plain selectors only match component-compiled elements.

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

Backend response headers prefixed `vhtml-` (e.g. `vhtml-debug`) are injected as custom keys on `$mod`.

### `$sys`

System variable pool, inherited from ancestor components via prototype chain.

| key | description |
| ----- | ------------- |
| `$router` | proxy to the nearest ancestor `<vrouter>` |
| `$emit(name, ...args)` | emit custom event to the parent's `@name` handler |
| `$message` | global toast / dialog API |

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
| `addRoute(route)` / `addRoutes(routes)` / `resetRoutes()` | runtime route management |

## URL Prefix Rules

Relative URLs inside a component (template and scripts) are auto-prefixed with `$mod.scoped`:

| scenario | behavior |
| -------- | -------- |
| Script `fetch('data/x.json')` | auto-prefixed (bare `fetch` handled same as `$mod.fetch`) |
| Script `fetch('/abs/x.json')` | **also prefixed** — never prepend `$mod.scoped` yourself (double prefix → 404) |
| Template `<img src="x.png">`, `:src` binding | auto-prefixed |
| **Runtime-created elements** (`document.createElement('img')`, third-party library / engine DOM) | **NOT prefixed** — use full path: `$mod.scoped + '/x.png'` or full URL |
| `http://`, `https://`, `//`, `@/` | passthrough, no prefix |

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
<div :key='item.id' v-for="item in items">{{ item.name }}</div>
<div :key='idx' v-for="(item, idx) in items">...</div>
<template :key='item.id' v-for="item in items">      <!-- multi-root list -->
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
- Special events: `@mounted` (node inserted into DOM), `@outerclick` (click outside the element).
- `v-for` and `v-if` can coexist on the same node: `v-for` clones first, then `v-if` filters each clone.
- Always initialize list variables in `<script setup>`: `items = []`.

## Script Types

| type | when it runs |
| ------ | ------------- |
| `<script setup>` | once at instance creation, before DOM compilation |
| `<script>` | once after DOM compilation, before first activation |
| `<script active>` | on entering live-in-page state: mount, cached route re-entry, browser tab visible again. Handler receives `$reason`: `'mount' \| 'route' \| 'visibility'` |
| `<script deactive>` | on leaving live-in-page state but staying alive: route cached, tab hidden; also fired before `dispose` when disposed while active (`$reason: 'dispose'`) |
| `<script dispose>` | when the instance is destroyed (`v-if` removal, page unload) |

Helpers available in all script types:

- `$node` — the current host DOM element.
- `$watch(() => expr, (val) => { ... })` — reactive effect, auto-cleaned on dispose. In `<script setup>` registration is deferred ~50ms until the scope is ready; in other scripts it registers immediately.

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

Projected content runs in the caller's runtime (`$data`/`$sys`/`$mod`); fallback content runs in the child's own runtime. `<vslot>` supports `:name` for dynamic slot names.

## `env.js`

Loaded once per `scoped` prefix. Use for module-wide services, i18n, config:

```js
export default async ($mod, manager) => {
  $mod.config = await $mod.fetch('/config.json').then(r => r.json())
  $mod.$i18n.load(await $mod.fetch('/langs.json').then(r => r.json()))

  await manager.loadModule('/shared')          // preload a sub-module and wait for its env.js
  manager.addAlias('ui-kit', '/lib/ui-kit')    // <ui-kit-button> → /lib/ui-kit/button.html
}
```

- `manager.loadModule(subPath)` — preload a sub-module's `env.js`; `/`-prefixed = absolute, otherwise relative to the current scoped.
- `manager.addAlias(prefix, baseUrl, isGlobal)` — register a component path alias; `baseUrl` must start with `/` or `https://`.

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
| `error_redirect` | fallback when the component fails to load |
| `meta` | arbitrary metadata, exposed on `$router.current.meta` |
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
- Navigation prefix priority: `$router.router_prefix` > initiating component `$mod.router_prefix` > initiating component `$mod.scoped`.
- Route registration prefixes come from route-module `path_prefix` / `component_prefix`, not from `prefix`.
- `@/path` bypasses router normalization and resolves to `/path`; `http(s)://` links are not intercepted.
- `<a>` is intercepted only when compiled under a RouterView runtime, with automatic `active` attribute on path match.
- Virtual routers inject bare `location` / `history` into `$sys`; outside a virtual router those names fall through to `window`. Virtual histories do not update `document.title`.
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

## `$message`

```js
$message.info('Notice')
$message.success('Done')
$message.warning('Careful')
$message.error('Failed')
$message.confirm('Delete?').then(() => { ... })
$message.prompt('Name', 'default').then(value => { ... })
```

Toast options: `{ duration = 3000, showClose, onClose }` (`duration: 0` = no auto-close). Dialog options: `{ title, confirmText, cancelText }`.

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
v-i18n scan                    # scan, clean up, report missing keys
v-i18n add -json '{"zh-CN":{"k":"v"},"en-US":{"k":"v"}}'
```

## Reactivity Contract & Pitfalls

vhtml reactivity = Proxy dep-tracking + rAF-batched flush. Nested objects are wrapped **lazily, only when read through a proxy**; writes during a watcher's evaluation are **never notified** (feedback-loop guard). These produce one silent dead-zone you must avoid:

| pattern | result |
| ------- | ------ |
| `:key` = **index** + replace list items with **new objects** | **DOM freezes silently** (data updates, DOM never does — no warning). v-for reuses the cached item and its in-place data update happens inside watcher evaluation, so all downstream notifications are suppressed. |
| `:key` = stable identity (id) | cached items stay; mutate their fields via the proxy path to update |
| unkeyed list | cache key = item `DataID`; wholesale replacement destroys & rebuilds items (works, costs more) |
| mutate nested object through held **raw reference** (`msg.text = x` after `const msg = {...}`) | **bypasses the proxy set trap — no update** (same as Vue's toRaw hazard). Always write via the proxy path: `d.list[i].text = x` |
| top-level scalar `$data` prop written from timers/rAF | always re-renders dependents — use for animations/streaming content |

Rules:

1. `:key` must be a stable identity key; never use array indexes when list items are replaced wholesale.
2. For streaming/animation (typewriter, count-up): drive from top-level scalar `$data` props, not nested object fields; lists should be append-only immutable records.
3. Writes from within a reactive evaluation (watchers, binding expressions) do not notify — do state mutations from event handlers, timers, or rAF callbacks.

## Debug

`localStorage.debug = 1` enables verbose logs (router navigation, module loading). Warnings and errors always print regardless.

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
      <div :key='item.id' v-for="item in list" class="card">
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
      $message.success('Deleted')
    }

    load()
  </script>
</html>
```
