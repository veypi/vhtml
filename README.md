# vhtml

[![Version](https://img.shields.io/npm/v/@veypi/vhtml?color=blue)](https://www.npmjs.com/package/@veypi/vhtml)
[![License](https://img.shields.io/badge/license-Apache%202.0-green)](LICENSE)

vhtml 是一个轻量级的响应式前端框架，提供了直观的数据绑定、组件化开发和路由功能。基于 HTML5 标准语法，无需复杂的编译过程，让开发更加简单高效。

## ✨ 核心特性

- 🚀 **轻量级**：体积小巧，性能优异
- 📝 **HTML5 标准**：基于原生 HTML 语法，学习成本低
- 🔄 **响应式数据**：自动数据绑定与视图更新
- 🧩 **组件化**：支持可复用的组件开发
- 🛣️ **内置路由**：客户端路由与页面管理
- 🎨 **插槽系统**：灵活的内容分发机制
- 📦 **无需构建**：直接在浏览器中运行

## 📦 安装

### CDN 引入

```html
<script src="https://vhtml.ai/assets/vhtml.min.js"></script>
```

## 🚀 快速开始

### 基础 HTML 结构

```html
<!DOCTYPE html>
<html>
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta
      name="description"
      content="vhtml 示例页面"
      details="展示 vhtml 基本功能的示例"
    />
    <title>vhtml 示例</title>
  </head>
  <style>
    body {
      font-family: Arial, sans-serif;
      padding: 20px;
    }
    .counter {
      text-align: center;
      margin: 20px 0;
    }
  </style>
  <body>
    <div class="counter">
      <h1>{{ title }}</h1>
      <p>计数器：{{ count }}</p>
      <button @click="increment">增加</button>
      <button @click="decrement">减少</button>
      <button @click="reset">重置</button>
    </div>

    <div v-if="count > 5">
      <p>计数器大于 5！</p>
    </div>

    <ul>
      <li v-for="(item, index) in items">
        {{ index + 1 }}. {{ item.name }} - {{ item.value }}
      </li>
    </ul>
  </body>

  <script setup>
    // 响应式数据定义
    title = "vhtml 计数器示例";
    count = 0;
    items = [
      { name: "项目一", value: "值1" },
      { name: "项目二", value: "值2" },
      { name: "项目三", value: "值3" },
    ];

    // 方法定义
    increment = () => {
      count++;
      items.push({ name: `新项目${count}`, value: `值${count}` });
    };

    decrement = () => {
      if (count > 0) {
        count--;
        items.pop();
      }
    };

    reset = () => {
      count = 0;
      items = [
        { name: "项目一", value: "值1" },
        { name: "项目二", value: "值2" },
        { name: "项目三", value: "值3" },
      ];
    };
  </script>

  <script>
    // 页面初始化后执行
    console.log("页面初始化完成，当前计数：", $data.count);

    // 监听数据变化
    $watch(() => {
      console.log("计数变化：", $data.count);
      if ($data.count >= 10) {
        $message.success("恭喜！计数达到 10");
      }
    });

    // DOM 操作示例
    const buttons = $node.querySelectorAll("button");
    buttons.forEach((btn) => {
      btn.addEventListener("mouseover", () => {
        btn.style.transform = "scale(1.05)";
      });
      btn.addEventListener("mouseout", () => {
        btn.style.transform = "scale(1)";
      });
    });
  </script>
</html>
```

## 📖 核心概念

### 1. 数据绑定

#### 文本插值

```html
<div>{{ message }}</div>
<div>{{ user.name }}</div>
<div>{{ items.length }} 个项目</div>
```

#### 属性绑定

```html
<a :href="url">链接</a>
<img :src="imageUrl" :alt="imageTitle" />
<div :class="{ active: isActive, disabled: !enabled }">动态类</div>
<div :style="{ color: textColor, fontSize: fontSize + 'px' }">动态样式</div>
```

#### 事件绑定

```html
<button @click="handleClick">点击</button>
<input @input="handleInput" @keyup.enter="submit" />
<div @mouseover="onHover" @mouseleave="onLeave">悬停区域</div>
```

#### 双向绑定

```html
<input v:value="username" />
<textarea v:value="description"></textarea>
<my-component v:data="formData"></my-component>
```

### 2. 条件渲染

```html
<div v-if="user.isLogin">欢迎回来，{{ user.name }}！</div>
<div v-else-if="user.isGuest">您好，访客！</div>
<div v-else>请登录</div>

<div v-show="showDetails">详细信息</div>
```

### 3. 列表渲染

```html
<!-- 基础循环 -->
<div v-for="item in items">{{ item.name }}</div>

<!-- 带索引的循环 -->
<div v-for="(item, index) in items">{{ index + 1 }}. {{ item.name }}</div>

<!-- 对象循环 -->
<div v-for="(value, key) in userInfo">{{ key }}: {{ value }}</div>

<!-- 嵌套循环 -->
<div v-for="category in categories">
  <h3>{{ category.name }}</h3>
  <div v-for="product in category.products">
    {{ product.name }} - ¥{{ product.price }}
  </div>
</div>
```

### 4. 组件开发

#### 创建组件 (`/ui/user/card.html`)

```html
<head>
  <meta
    name="description"
    content="用户卡片组件"
    details="显示用户信息的卡片组件"
  />
</head>
<style>
  body {
    border: 1px solid #ddd;
    border-radius: 8px;
    padding: 16px;
    margin: 8px;
    background: white;
    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
  }
  .avatar {
    width: 60px;
    height: 60px;
    border-radius: 50%;
    object-fit: cover;
  }
  .user-info {
    margin-left: 16px;
  }
</style>
<body>
  <div style="display: flex; align-items: center;">
    <img :src="avatar" :alt="name" class="avatar" />
    <div class="user-info">
      <h3>{{ name }}</h3>
      <p>{{ email }}</p>
      <p>{{ role }}</p>
      <button @click="viewProfile">查看详情</button>
    </div>
  </div>

  <vslot name="actions">
    <button>默认操作</button>
  </vslot>
</body>

<script setup>
  // 组件属性
  name = "用户名";
  email = "user@example.com";
  avatar = "/default-avatar.png";
  role = "普通用户";

  // 组件方法
  viewProfile = () => {
    $emit("profile_clicked", { name, email });
    $router.push(`/user/${name}`);
  };
</script>

<script>
  // 组件初始化
  console.log("用户卡片组件已加载：", $data.name);
</script>
```

#### 使用组件

```html
<body>
  <!-- 基础使用 -->
  <user-card
    :name="currentUser.name"
    :email="currentUser.email"
    :avatar="currentUser.avatar"
    @profile_clicked="handleProfileClick"
  >
    <!-- 自定义插槽内容 -->
    <div slot="actions">
      <button @click="editUser">编辑</button>
      <button @click="deleteUser">删除</button>
    </div>
  </user-card>

  <!-- 双向绑定 -->
  <user-form v:user="editingUser"></user-form>

  <!-- 循环渲染组件 -->
  <div v-for="user in users">
    <user-card :name="user.name" :email="user.email" :avatar="user.avatar">
    </user-card>
  </div>
</body>

<script setup>
  currentUser = {
    name: "张三",
    email: "zhangsan@example.com",
    avatar: "/avatars/zhangsan.jpg",
  };

  users = [
    { name: "李四", email: "lisi@example.com", avatar: "/avatars/lisi.jpg" },
    {
      name: "王五",
      email: "wangwu@example.com",
      avatar: "/avatars/wangwu.jpg",
    },
  ];

  handleProfileClick = (userData) => {
    console.log("用户点击了查看详情：", userData);
    $message.info(`正在查看 ${userData.name} 的详情`);
  };

  editUser = () => {
    $message.info("编辑用户功能");
  };

  deleteUser = () => {
    $message
      .confirm("确定要删除该用户吗？", {
        title: "删除确认",
        confirmText: "删除",
        cancelText: "取消",
      })
      .then(() => {
        $message.success("用户已删除");
      })
      .catch(() => {
        $message.info("已取消删除");
      });
  };
</script>
```

### 5. 路由管理

```html
<body>
  <!-- 路由链接 -->
  <nav>
    <a href="/home">首页</a>
    <a href="/about">关于</a>
    <a href="/user/123">用户详情</a>
  </nav>

  <!-- 路由视图 -->
  <vrouter></vrouter>
</body>

<script setup>
  // 路由跳转方法
  goToHome = () => {
    $router.push("/home");
  };

  goBack = () => {
    $router.back();
  };

  // 获取路由参数
  userId = $router.params.id; // 从 /user/:id 获取
  keyword = $router.query.q; // 从 ?q=keyword 获取
</script>
```

### 6. 数据请求

```javascript
// GET 请求
$axios
  .get("/api/users")
  .then((users) => {
    $data.users = users;
  })
  .catch((error) => {
    console.error("获取用户列表失败：", error);
    $message.error("加载失败，请重试");
  });

// POST 请求
$axios
  .post("/api/users", {
    name: $data.newUser.name,
    email: $data.newUser.email,
  })
  .then((result) => {
    $message.success("用户创建成功");
    $data.users.push(result);
  })
  .catch((error) => {
    $message.error("创建失败：" + error.message);
  });

// 带参数的请求
$axios
  .get("/api/search", {
    params: {
      keyword: $data.searchText,
      page: $data.currentPage,
    },
  })
  .then((result) => {
    $data.searchResults = result.items;
    $data.totalPages = result.totalPages;
  });
```

## 🔧 内置功能

### 消息提示

```javascript
// 基础消息
$message.info("信息提示");
$message.success("操作成功");
$message.warning("警告信息");
$message.error("错误信息");

// 确认对话框
$message
  .confirm("确定要执行此操作吗？", {
    title: "操作确认",
    confirmText: "确定",
    cancelText: "取消",
  })
  .then(() => {
    // 用户点击确定
  })
  .catch(() => {
    // 用户点击取消
  });

// 输入对话框
$message
  .input("请输入新名称：", {
    title: "重命名",
    inputValue: "默认值",
    confirmText: "确定",
    cancelText: "取消",
  })
  .then((value) => {
    console.log("用户输入：", value);
  });
```

### 数据监听

```javascript
// 监听数据变化
$watch(() => {
  // 访问需要监听的数据
  console.log("用户名变化：", $data.username);
  console.log("邮箱变化：", $data.email);

  // 可以执行相关逻辑
  if ($data.username && $data.email) {
    $data.isFormValid = true;
  }
});

// 监听特定条件
$watch(() => {
  if ($data.cart.items.length > 10) {
    $message.warning("购物车商品过多，建议及时结算");
  }
});
```

## 📋 最佳实践

### 1. 项目结构

```
├── ui/                 # 静态资源根目录
│   ├── assets          # 非组件静态资源目录
│   │   ├──common.css   # 全局公用样式
│   ├── layout/          # 布局文件目录
│   │   ├── default.html # 默认布局, 比如包含header,footer等公共部分
│   ├── page/           # 页面文件目录
│   │   ├── index.html
│   │   ├── 404.html
│   │   ├── **/**/*.html
│   │   └── ...
│   ├── **/**/*.html       # 其他组件页面文件,
│   ├── root.html       # vhtml 根页面，后端非资源请求默认返回该文件
│   ├── env.js          # 环境变量初始化
│   └── routes.js       # 路由配置文件

```

### 2. 命名规范

- **组件名称**：使用短横线分隔，如 `user-card`, `product-list`
- **事件名称**：使用蛇形命名，如 `item_selected`, `form_submitted`

### 3. 性能优化

- 合理使用 `v-show` vs `v-if`
- 避免在同一元素上使用多个指令
- 大列表使用虚拟滚动
- 组件懒加载

### 4. 错误处理

```javascript
// API 错误处理
$axios
  .get("/api/data")
  .then((data) => {
    $data.items = data;
  })
  .catch((error) => {
    console.error("API 错误：", error);
    $message.error("数据加载失败，请稍后重试");
    // 设置默认数据或错误状态
    $data.items = [];
    $data.hasError = true;
  });
```

## 🎯 高级功能

### 插槽高级用法

```html
<!-- 作用域插槽 -->
<vslot name="item" v="currentItem, currentIndex">
  <div>默认项目模板</div>
</vslot>
```

### 自定义指令

```html
<!-- DOM 引用 -->
<input vdom="searchInput" />

<script>
  // 通过 vdom 获取 DOM 引用
  $data.searchInput.focus();
</script>
```

## 🔗 链接

- [GitHub 仓库](https://github.com/veypi/vhtml)
- [NPM 包](https://www.npmjs.com/package/@veypi/vhtml)
- [问题反馈](https://github.com/veypi/vhtml/issues)

## 📄 许可证

[Apache License 2.0](LICENSE)

---

**vhtml** - 让前端开发更简单！ 🚀
