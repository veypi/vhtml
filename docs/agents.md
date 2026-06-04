---
name: vhtml-frontend
description: Use this guide when creating or modifying vhtml frontend code, including pages, reusable HTML components, layouts, routes, slots, bindings, scoped module env setup, router behavior, API integration, i18n setup and translation usage, and component communication. Read the full guide whenever a task involves vhtml-specific syntax or runtime concepts such as script setup, $data/$sys/$mod/$router, $t/$i18n, env.js, routes.js, vrouter, refs, lifecycle hooks, or real-DOM component composition.
---

# vhtml Frontend Guide

## What vhtml is

`vhtml` is a browser-only HTML component runtime.

- No SSR
- No hydration
- No virtual DOM
- Real DOM is the source of truth
- One `.html` file can be a full page or a reusable component
- `vrouter` is optional; without it, vhtml is just an HTML component framework

Use vhtml patterns, not Vue/React patterns.

## File Layout

Typical module layout:

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

## Component Mapping

Custom tags map to HTML files by kebab path:

```html
<user-card></user-card>       → /user/card.html
<agent-list></agent-list>     → /agent/list.html
```

## Component File Shape

Recommended structure:

```html
<!DOCTYPE html>
<html>
  <head>
    <meta name="description" content="Counter" />
    <title>Counter</title>
  </head>
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

`<script setup>` declaration rules:

- `a = xxx` or `save = () => {}` declares reactive state or public methods on `$data`. They are accessible from template bindings, other scripts, refs, and parent imperative calls.
- `const`, `let`, and `function` declare local helpers only. They stay private to setup and are NOT registered on `$data`.
- Do not abuse bare `=` for short-lived locals. Use `const` or `let`.

## Runtime Model

When an expression uses a bare identifier without an explicit prefix, resolution follows this fixed order:

```text
$data → $mod → $sys → expose → execArgs → window
```

Use explicit prefixes (`$data.xxx`, `$mod.xxx`, `$sys.xxx`) when the source matters for readability or to avoid shadowing.

### `$data`

Private state of the current component instance. Only bare assignments from `<script setup>` (e.g. `count = 0`, `save = () => {}`) and props are mapped into `$data`. `const`/`let`/`function` locals stay private and do not appear on `$data`.

### `$mod`

Module-scoped context, shared by all components under the same `scoped` prefix. Not inherited through parent components.

Default entries:

| key | description |
|-----|-------------|
| `scoped` | module path prefix, e.g. `/page` (root module is `""`) |
| `$bus` | module-level EventBus |
| `$i18n` | I18n instance |
| `$t(key, params)` | translation shorthand |
| `fetch(url, options)` | scoped fetch — relative URLs auto-prepend the scoped prefix |

Backend response headers prefixed `vhtml-` (e.g. `vhtml-debug`) are injected as custom keys on `$mod`.

### `$sys`

System variable pool, inherited via `Object.create(parent.$sys)`.

| key | description |
|-----|-------------|
| `$router` | proxy to the nearest ancestor `<vrouter>` |
| `$emit` | `$emit('event', ...args)` to emit custom events to the parent |
| `$message` | global toast / dialog API |

### `$router`

Nearest ancestor `<vrouter>` view, local to the current router subtree.

```js
$router.push('/path')
$router.push({ name: 'home', params: { id: 1 } })
$router.replace('/path')
$router.back()
$router.forward()
$router.go(-1)
$router.current      // { path, fullPath, params, query, ... }
$router.params
$router.query
```

## i18n

`$i18n` and `$t` live on `$mod`, so translations are module-scoped by default.

```html
<title>{{ $t('page.title') }}</title>
<button>{{ $t('common.save') }}</button>
```

`langs.json` shape:

```json
{
  "zh-CN": { "common.save": "保存" },
  "en-US": { "common.save": "Save" }
}
```

Load once per module in `env.js`:

```js
export default async ($mod) => {
  $mod.$i18n.load(await $mod.fetch('/langs.json').then(r => r.json()))
}
```

Useful APIs: `$t(key, { count, ...vars })`, `$i18n.setLocale(lang)`, `$i18n.getLocale()`, `$i18n.load(messages)`.

i18n key scanning via CLI:

```bash
v-i18n scan                    # scan, clean up, report missing keys
v-i18n add -json '{"zh-CN":{"k":"v"},"en-US":{"k":"v"}}'
```

## Script Types

| type | when it runs |
|------|-------------|
| `<script setup>` | once when instance is created |
| `<script>` | once after initial mount |
| `<script active>` | each time the instance becomes active (cached page re-entry) |
| `<script deactive>` | when the instance goes inactive but stays alive |
| `<script dispose>` | when the instance is destroyed (`v-if` removal, page unload) |

Script-only helpers:

- `$watch(() => expr, (val) => { ... })` — reactive effect, auto-cleaned on dispose
- `$node` — the current host DOM element

## Bindings

```html
<div>{{ title }}</div>                          <!-- text interpolation -->
<img :src="avatarUrl" :title="name" />          <!-- dynamic attributes -->
<div :class="{ active: isActive }"></div>       <!-- dynamic class -->
<div :style="{ color: 'red' }"></div>           <!-- dynamic style -->
<button @click="save()">Save</button>           <!-- event handler -->
<button @click.stop="remove(id)">Delete</button>
<input v:value="value" />                       <!-- two-way binding -->
<div v-show="loading">Loading...</div>          <!-- toggle display -->
<div v-if="loading">Loading...</div>            <!-- conditional -->
<div v-else>No data</div>
<div v-for="item in items">{{ item.name }}</div> <!-- list -->
<div v-for="(item, idx) in items">...</div>
<div v-for="item in items" v-if="item.active">{{ item.name }}</div>  <!-- v-for first, then v-if -->
<div vsrc="/local/card.html"></div>             <!-- static component -->
<div :vsrc="currentComponent"></div>            <!-- dynamic component -->
<div v-html="htmlContent"></div>                <!-- raw HTML -->

<!-- <template> unwraps its children; v-for on <template> enables multi-root lists -->
<template v-for="item in items">
  <div>{{ item.a }}</div>
  <div>{{ item.b }}</div>
</template>
```

- Always initialize list variables in `<script setup>`: `items = []`.
- `v-for` and `v-if` can coexist on the same node: `v-for` runs first to produce per-item clones, then `v-if` filters each clone.

## Refs and Parent-to-Child Calls

`ref="xxx"` is auto-collected into `$data.$refs.xxx`.

```html
<script setup>
  reloadChild = () => $refs.panel.$data.reload()
</script>
<child-panel ref="panel"></child-panel>
```

Host node public fields: `$data`, `$sys`, `$mod`. Prefer `props + $emit` for normal communication; use `$refs.xxx.$data` only for imperative parent calls.

## Slots

```html
<!-- caller -->
<card-shell>
  <div vslot="header">Header</div>   <!-- projected: uses caller runtime -->
  <div>Body</div>                    <!-- default slot -->
</card-shell>

<!-- card-shell.html -->
<body>
  <header><vslot name="header"><span>Default</span></vslot></header>
  <main><vslot></vslot></main>       <!-- fallback uses child runtime -->
</body>
```

Projected content runs in the caller's runtime (`$data`/`$sys`/`$mod`). Fallback content runs in the child's own runtime.

## `env.js`

Initializes the module context. Loaded once per `scoped` prefix. Use for module-wide services, i18n setup, and configuration:

```js
export default async ($mod, manager) => {
  // module config
  const config = await $mod.fetch('/config.json').then(r => r.json())
  $mod.config = config

  // i18n
  $mod.$i18n.load(await $mod.fetch('/langs.json').then(r => r.json()))
}
```

Do NOT use `env.js` for route guards, per-page state, or component-local data.

## `routes.js`

Belongs to a `<vrouter>` view. Loaded from the current scoped module unless `vrouter` provides an explicit `routes` path.

Supported export forms:

```js
// 1. array
export default [
  { path: '/', component: '/page/index.html', name: 'home' },
  { path: '/user/:id', component: '/page/user.html' },
  { path: '*', component: '/page/404.html' },
]

// 2. object
export default {
  routes: [...],
  beforeEnter: async (to, from, next) => { ... },
  afterEnter: (to, from) => { ... },
}

// 3. factory (recommended when $mod capabilities are needed)
export default ({ $mod, router }) => ({
  routes: [
    {
      path: '/',
      component: '/page/index.html',
      name: 'home',
      layout: 'default',
    },
    {
      path: '/admin',
      component: '/page/admin.html',
      layout: 'admin',
      meta: { auth: true },
      children: [
        { path: 'settings', component: '/page/admin_settings.html' },
      ],
    },
    {
      path: '/edit/:id',
      component: (path, params) => `/page/edit/${params.id}.html`,
      error_redirect: '/404',
    },
    { path: '*', component: '/page/404.html' },
  ],
  beforeEnter: async (to, from, next) => {
    if (!$mod.auth?.isLogin() && to.path !== '/login') {
      next('/login')
      return false
    }
  },
})
```

Route record fields:

| field | description |
|-------|-------------|
| `path` | required. supports `:param`, `:id?` (optional), `*rest` (wildcard), `*` (catch-all) |
| `component` | required. HTML path or function `(path, params) => url` |
| `layout` | layout name, resolved to `/layout/{name}.html` |
| `name` | named route for `$router.push({ name: 'home' })` |
| `meta` | arbitrary metadata |
| `children` | nested routes, child paths are relative to the parent |
| `cacheKey` | string (shared instance), `false` (no cache), default (path-based) |
| `error_redirect` | fallback when component fails to load |

Behavior notes:

- `beforeEnter` / `afterEnter` belong in `routes.js`, not `env.js`.
- `path: '*'` should be last, used for 404.
- Layouts should expose a default `<vslot>` for the router page outlet.

## `vrouter`

```html
<vrouter></vrouter>
<vrouter routes="/admin_routes.js"></vrouter>
```

- Without `routes`, defaults to current scoped `routes.js`.
- Multiple `<vrouter>` instances on the same page are allowed.
- Anchor clicks are intercepted: `<a href="/agents">Agents</a>`, with automatic `active` attribute when the path matches.

## Built-in Runtime APIs

```js
$message.info('Notice')
$message.success('Done')
$message.error('Failed')
$message.confirm('Delete?').then(() => { ... })
$message.prompt('Name', 'default').then(value => { ... })
```

## Full Example

```html
<!DOCTYPE html>
<html>
  <head><title>Home</title></head>
  <style>
    body { padding: 20px; }
    .card { border: 1px solid #ddd; padding: 16px; margin: 8px 0; }
  </style>
  <body>
    <h1>{{ $t('page.title') }}</h1>
    <input v:value="keyword" placeholder="Search" />
    <div v-if="loading">Loading...</div>
    <div v-else>
      <div v-for="item in filteredList" class="card">
        <h3>{{ item.name }}</h3>
        <button @click="remove(item.id)">Delete</button>
      </div>
    </div>
  </body>
  <script setup>
    keyword = ''
    list = []
    loading = true

    const fetchList = async () => {
      loading = true
      const res = await fetch('/api/list')
      list = await res.json()
      loading = false
    }

    remove = (id) => {
      list = list.filter(item => item.id !== id)
      $message.success('Deleted')
    }

    fetchList()
  </script>
</html>
```

## Writing Rules

- Prefer small, focused HTML components.
- Explicitly initialize all template variables in `<script setup>`.
- Use `$data` for local state, `$mod` for module-wide services, `$sys` for system capabilities.
- Put route config and guards in `routes.js`, not `env.js`.
- Avoid Vue/React terminology and patterns.


## Quick Checklist

Before writing code: local state → `$data`; module-wide service/config → `$mod`; system/runtime → `$sys`; route behavior → `routes.js`; router-local navigation → `$router`.
