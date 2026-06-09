# vhtml

[![Version](https://img.shields.io/npm/v/@veypi/vhtml?color=blue)](https://www.npmjs.com/package/@veypi/vhtml)
[![License](https://img.shields.io/badge/license-Apache%202.0-green)](LICENSE)

vhtml 是一个轻量级的浏览器端响应式前端框架，基于 HTML5 标准语法，提供数据绑定、组件化开发和路由功能。

## 核心特性

- **轻量级**：体积小巧，性能优异
- **HTML5 标准**：基于原生 HTML 语法，无需编译
- **响应式数据**：自动数据绑定与视图更新
- **组件化**：支持可复用的 `.html` 组件
- **内置路由**：客户端路由与页面管理
- **插槽系统**：灵活的内容分发

## 安装

```html
<script type="module">
  import VHTML from "https://ivect.ai/vhtml/vhtml.min.js"
  window.$vhtml = new VHTML(document.body, '/')
</script>
```

## 快速开始

```html
<!DOCTYPE html>
<html>
  <head>
    <meta charset="UTF-8" />
    <title>vhtml 示例</title>
  </head>
  <style>
    body { font-family: Arial, sans-serif; padding: 20px; text-align: center; }
  </style>
  <body>
    <h1>{{ title }}</h1>
    <p>计数器：{{ count }}</p>
    <button @click="increment">+</button>
    <button @click="decrement">-</button>

    <div v-if="count > 5">
      <p>计数器大于 5！</p>
    </div>

    <ul>
      <li v-for="item in items">{{ item }}</li>
    </ul>
  </body>
  <script setup>
    title = "vhtml 计数器"
    count = 0
    items = ["苹果", "香蕉", "橘子"]

    increment = () => count++
    decrement = () => count--
  </script>
</html>
```

## 核心概念

### 运行时变量池

表达式解析优先级：

```text
$data → $mod → $sys → expose → execArgs → window
```

- **`$data`**：组件实例私有状态，来自 `<script setup>` 的裸赋值和 props
- **`$mod`**：模块级上下文，同 scoped 下所有组件共享。包含 `scoped`、`$bus`、`$i18n`、`$t`、`fetch`
- **`$sys`**：系统变量池。包含 `$router`、`$emit`、`$message`

### 数据绑定

```html
<div>{{ message }}</div>                         <!-- 文本插值 -->
<a :href="url">链接</a>                          <!-- 属性绑定 -->
<div :class="{ active: isActive }"></div>         <!-- 动态 class -->
<button @click="handleClick">点击</button>         <!-- 事件绑定 -->
<button @click.stop="remove(id)">删除</button>
<input v:value="username" />                      <!-- 双向绑定 -->
<textarea v:value="description"></textarea>
```

### 条件与列表

```html
<div v-if="user.isLogin">欢迎，{{ user.name }}！</div>
<div v-else-if="user.isGuest">您好，访客！</div>
<div v-else>请登录</div>
<div v-show="showDetails">详细信息</div>

<div v-for="item in items">{{ item.name }}</div>
<div v-for="(item, idx) in items">{{ idx }}. {{ item.name }}</div>
<div v-for="item in items" v-if="item.active">{{ item.name }}</div>  <!-- v-for 先执行 -->
```

### 组件

```html
<!-- ui/user/card.html -->
<head><title>用户卡片</title></head>
<style>
  body { border: 1px solid #ddd; border-radius: 8px; padding: 16px; }
</style>
<body>
  <img :src="avatar" :alt="name" />
  <h3>{{ name }}</h3>
  <p>{{ email }}</p>
  <vslot name="actions"><button>默认操作</button></vslot>
</body>
<script setup>
  name = "用户名"
  email = "user@example.com"
  avatar = "/default-avatar.png"

  viewProfile = () => $emit("profile_clicked", { name, email })
</script>
```

使用组件：

```html
<body>
  <user-card
    :name="currentUser.name"
    :email="currentUser.email"
    @profile_clicked="handleProfileClick"
  >
    <div vslot="actions">
      <button @click="editUser">编辑</button>
    </div>
  </user-card>

  <div v-for="user in users">
    <user-card :name="user.name" :email="user.email" :avatar="user.avatar"></user-card>
  </div>
</body>
<script setup>
  currentUser = { name: "张三", email: "zhangsan@example.com" }
  users = [
    { name: "李四", email: "lisi@example.com" },
    { name: "王五", email: "wangwu@example.com" },
  ]

  handleProfileClick = (userData) => $message.info(`正在查看 ${userData.name}`)
</script>
```

### 路由

```html
<nav>
  <a href="/home">首页</a>
  <a href="/about">关于</a>
  <a href="/user/123">用户详情</a>
</nav>
<vrouter></vrouter>

<script setup>
  goToHome = () => $router.push("/home")
  goBack = () => $router.back()
  userId = $router.params.id
</script>
```

### 数据请求

```js
// 使用 $mod.fetch，相对路径自动加 scoped 前缀
const users = await $mod.fetch('/api/users').then(r => r.json())

// POST 请求
const result = await $mod.fetch('/api/users', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: '新用户' }),
}).then(r => r.json())
```

### 消息通知

```js
$message.info("信息提示")
$message.success("操作成功")
$message.warning("警告信息")
$message.error("错误信息")

$message.confirm("确定删除？", {
  title: "删除确认",
  confirmText: "确定",
  cancelText: "取消",
}).then(() => $message.success("已删除"))

$message.prompt("请输入新名称：", "默认值").then(value => console.log(value))
```

## 项目结构

```
ui/
  root.html       # 应用入口
  env.js          # 模块级配置（可选）
  routes.js       # 路由配置
  langs.json      # i18n 翻译
  layout/         # 布局组件
  page/           # 页面组件
  local/          # 可复用组件
```

## 链接

- [GitHub 仓库](https://github.com/veypi/vhtml)
- [NPM 包](https://www.npmjs.com/package/@veypi/vhtml)
- [问题反馈](https://github.com/veypi/vhtml/issues)

## 许可证

[Apache License 2.0](LICENSE)
