---
name: vhtml-frontend
description: Use this guide when creating or modifying vhtml frontend code, including pages, reusable HTML components, layouts, routes, slots, bindings, scoped module env setup, router behavior, API integration, i18n setup and translation usage, and component communication. Read the full guide whenever a task involves vhtml-specific syntax or runtime concepts such as script setup, $data/$env/$scoped/$router, $t/$i18n, env.js, routes.js, vrouter, refs, lifecycle hooks, or real-DOM component composition.
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
  env.js      # module-scoped setup
  routes.js   # router-view config
  layout/     # router layouts
  page/       # route pages
  local/      # reusable local components
```

## Component Mapping

Custom tags map to HTML files by kebab path:

```html
<user-card></user-card>   # /user/card.html
<agent-list></agent-list> # /agent/list.html in the current module
```

## Component File Shape

Recommended structure:

```html
<!DOCTYPE html>
<html>
<head>
  <meta name="description" content="Counter" details="Simple counter" />
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

## Runtime Model

### `$data`

Private state of the current component instance: variables from `<script setup>`, component methods, and props mapped into the instance.

### `$env`

Parent-to-child context chain, inherited through nesting; use it for local tree context such as `theme`, `mode`, `recordId`, not module-wide services:

```html
<script setup> $env.recordId = 'abc123' </script> # children can read recordId
```

### `$scoped`

Module-scoped context, shared by the same module scope and not inherited through parent components; use it for `$axios`, `$i18n`, `$t`, `$bus`, auth, and module config.

### `$router`

Nearest ancestor `vrouter` view; local to the current router subtree, not a module-level global, and only available inside a `vrouter`.

## i18n

`$i18n` and `$t` come from `$scoped`, so translations are module-scoped by default. Common resource layout at the current module root:

```txt
env.js
routes.js
langs.json
```

```html
<title>{{$t('agent.list_title')}}</title>
<button>{{$t('common.save')}}</button>
<div>{{ $t('agent.empty') }}</div>
```

Recommended `langs.json` shape:

```json
{
  "zh-CN": {
    "common.save": "保存"
  },
  "en-US": {
    "common.save": "Save"
  }
}
```

Load it once per module, usually in `env.js` or a top-level layout/page:

```js
export default async (scoped) => {
  scoped.$i18n.load(await (await fetch(`${scoped.scoped}/langs.json`)).json()) # loads this module's langs.json
}
```

Use translation keys in templates and scripts instead of hard-coded UI text. Useful APIs: `$t(key, vars)`, `$i18n.setLocale(lang)`, `$i18n.getLocale()`, `$i18n.load(messages)`.

For key scanning and cleanup, use `v-i18n`:

```bash
v-i18n scan --fix --removeUnused
```

## Script Types

- `<script setup>`: runs once when the instance is created; use it for state init, method definitions, refs, and local helpers.
- `<script>`: runs after initial mount; use it for one-time mounted logic.
- `<script active>`: runs each time the instance becomes active; useful for cached pages, refresh on re-entry, and tab-like views.
- `<script deactive>`: runs when the instance becomes inactive but is kept alive.
- `<script dispose>`: runs when the instance is really destroyed; `v-if` removal usually triggers it.
- Script-only helpers: `$watch(() => [a, b], () => {...})` for reactive effects, `$node` for the current host DOM node.

## Bindings

Common bindings:

```html
<div>{{ title }}</div>                           # text
<img :src="avatarUrl" :title="name" />          # dynamic attributes
<button @click="save">Save</button>             # events
<button @click.stop="removeItem(id)">Delete</button>
<input v:model="form.name" />                   # two-way binding
<div v-if="loading">Loading...</div>            # conditionals
<div v-else>No data</div>
<div v-for="item in items">{{ item.name }}</div> # loops
<div vsrc="/local/preview.html"></div>          # explicit component/page loading
```

Always initialize list variables in `<script setup>`, and do not mix `v-if` and `v-for` on the same node:

```html
<script setup> items = [] </script>
```

## Refs and Parent-to-Child Calls

```html
<script setup>
  panel = null
  reloadChild = () => panel.$data.reload()
</script>
<child-panel ref="panel"></child-panel>
```

`ref` binds a DOM node to a component variable. Stable public host fields are `refNode.$data`, `refNode.$env`, `refNode.$scoped`, and `refNode.$router`. Prefer `props + $emit` for normal communication; use `refNode.$data` only for imperative parent calls.

## Slots

```html
<card-shell>
  <div vslot="header">Header</div> # projected content uses parent context
  <div>Body</div>
</card-shell>
<body>
  <header><vslot name="header"></vslot></header> # child fallback uses child context
  <main><vslot></vslot></main>
</body>
```

Projected content runs in parent context, fallback content runs in child context, and router outlet is not a generic slot concept.

## `env.js`

`env.js` initializes the current module context:

```js
export default async (scoped, manager) => {
  scoped.$axios.interceptors.request.use((config) => {
    config.headers.Authorization = `Bearer ${scoped.token}`
    return config
  })

  scoped.$axios.interceptors.response.use(
    (response) => response.data,
    (error) => Promise.reject(error?.response?.data || error)
  )
}
```

Use it for module services, module config, i18n setup, and axios setup; do not use it for route guards, per-page state, component-local data, or local router behavior.

## `routes.js`

`routes.js` belongs to a router view, not module bootstrap. It is resolved from the current module root unless `vrouter` provides an explicit `routes` path. Supported forms:

```js
export default [...]                         # array
export default { routes: [...], beforeEnter, afterEnter } # object
```

Recommended:

```js
export default ({ $scoped, router }) => ({
  routes: [
    { path: '/', component: '/page/index.html', name: 'home', layout: 'default' },
    { path: '/login', component: '/page/login.html', name: 'login' },
  ],
  beforeEnter: async (to, from, next) => {
    if (!$scoped.auth?.isLogin() && to.path !== '/login') {
      next('/login')
      return false
    }
  },
})
```

Use it for routes and route-level hooks. Do not put router config in `env.js`.

## `vrouter`

`vrouter` is a special component. Without it, the page is just a normal HTML component tree. With it, vhtml loads routes from its configured `routes` path or the current module's `routes.js`, renders pages into its own outlet, may use layouts, and may cache pages with `active/deactive`.

Example:

```html
<vrouter></vrouter>
<vrouter routes="./sidebar_routes.js"></vrouter>
```

Multiple `vrouter` instances are allowed.

Navigation inside a router subtree should use anchors or `$router.push()`:

```html
<a href="/agents">Agents</a> # router intercepts the click and adds active when the path matches
```

```js
$router.push('/agents')
```

## Built-in Runtime APIs

Common helpers:

- `$message.info('Saved')`
- `$message.success('Done')`
- `$message.error('Failed')`
- `$message.confirm('Delete?').then(...)`
- `$message.prompt('Name', 'default').then(...)`

## Writing Rules

Prefer small focused HTML components, explicit initialization in `<script setup>`, `$data` for local state, `$env` for parent-child context, `$scoped` for module services, and `routes.js` for router behavior.

Avoid Vue/React terminology, assuming a virtual DOM exists, putting module services into `$env`, putting router config into `env.js`, relying on undeclared variables, and mixing `v-if` with `v-for` on the same node.

## Quick Checklist

Before writing code: local state -> `$data`; parent-child context -> `$env`; module-wide service/config -> `$scoped`; route behavior -> `routes.js`; router-local state -> `$router`; normal page with nested components -> do not introduce router concepts.
