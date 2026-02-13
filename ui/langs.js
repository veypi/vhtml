/*
 * i18n.js
 * Copyright (C) 2026 veypi <i@veypi.com>
 *
 * Distributed under terms of the MIT license.
 */

export default {
  "zh-CN": {
    // 通用
    common: {
      docs: "文档",
      examples: "示例",
      ecosystem: "生态",
      about: "关于",
      home: "首页",
      github: "GitHub",
      copyright: "vhtml © 2025 | {github}",
      back: "返回",
      loading: "加载中...",
    },

    // 首页
    home: {
      title: "vhtml - 轻量级响应式前端框架",
      subtitle: "轻量级响应式前端框架，基于原生 HTML5 语法，无需复杂编译",
      quickStart: "快速开始",
      viewExamples: "查看示例",
      features: "核心特性",
      syntax: "简洁的语法",
      featureList: {
        lightweight: {
          title: "轻量快速",
          desc: "压缩后仅 96KB，无依赖，加载迅速，性能优异"
        },
        native: {
          title: "原生语法",
          desc: "基于标准 HTML5，学习成本低，无需掌握复杂的构建工具"
        },
        reactive: {
          title: "响应式绑定",
          desc: "自动数据绑定，状态变化自动更新视图，开发更高效"
        },
        component: {
          title: "组件化开发",
          desc: "支持组件封装、属性传递、事件通信，代码复用更简单"
        },
        router: {
          title: "客户端路由",
          desc: "内置路由系统，支持动态路由、路由守卫，SPA 开发无压力"
        },
        ready: {
          title: "开箱即用",
          desc: "集成 Axios、FontAwesome、ECharts，无需额外配置"
        }
      },
      codeComments: {
        dataBinding: "数据绑定",
        condition: "条件渲染",
        list: "列表渲染",
        event: "事件绑定"
      }
    },

    // 文档页
    docs: {
      title: "文档 - vhtml",
      sidebar: {
        guide: "指南",
        basics: "基础",
        advanced: "进阶"
      },
      sections: {
        intro: "介绍",
        quickstart: "快速开始",
        structure: "目录结构",
        template: "模板语法",
        data: "响应式数据",
        events: "事件处理",
        components: "组件",
        router: "路由",
        api: "API 调用",
        slots: "插槽"
      },
      content: {
        intro: {
          title: "介绍",
          desc: "vhtml 是一个轻量级响应式前端框架，采用原生 HTML5 语法，无需复杂的构建工具即可快速开发 Web 应用。",
          features: "特性",
          featureList: {
            lightweight: "轻量 - 压缩后仅 96KB，无外部依赖",
            simple: "简单 - 基于标准 HTML5，学习成本低",
            reactive: "响应式 - 自动数据绑定，状态驱动视图",
            component: "组件化 - 支持组件封装和复用",
            router: "路由 - 内置客户端路由系统"
          },
          browser: "浏览器支持",
          browserDesc: "vhtml 支持所有现代浏览器，包括 Chrome、Firefox、Safari、Edge 等。"
        },
        quickstart: {
          title: "快速开始",
          install: "安装",
          npmInstall: "通过 npm 安装：",
          cdn: "或直接通过 CDN 引入：",
          firstPage: "创建第一个页面",
          createIndex: "创建 index.html："
        },
        structure: {
          title: "目录结构",
          desc: "推荐的 vhtml 项目目录结构："
        },
        template: {
          title: "模板语法",
          textInterpolation: "文本插值",
          attrBinding: "属性绑定",
          dynamicAttr: "动态属性",
          twoWay: "双向绑定",
          condition: "条件渲染",
          list: "列表渲染"
        },
        data: {
          title: "响应式数据",
          declare: "声明数据",
          declareDesc: "在 <script setup> 中使用 = 直接赋值声明响应式数据：",
          access: "访问数据",
          accessDesc: "在模板中直接使用变量名：",
          inScript: "在 script 中访问",
          inScriptDesc: "使用 $data 访问和修改："
        },
        events: {
          title: "事件处理",
          listen: "监听事件",
          handler: "事件处理函数",
          custom: "触发自定义事件",
          customDesc: "向父组件触发事件："
        },
        components: {
          title: "组件",
          create: "创建组件",
          createDesc: "在 /ui/components/ 目录下创建 HTML 文件：",
          usage: "使用组件",
          usageDesc: "路径 /ui/components/my-button.html 对应标签 <components-my-button>："
        },
        router: {
          title: "路由",
          config: "配置路由",
          configDesc: "在 /ui/routes.js 中配置：",
          nav: "导航",
          linkNav: "链接导航",
          progNav: "编程导航"
        },
        api: {
          title: "API 调用",
          desc: "vhtml 内置 $axios 用于 HTTP 请求：",
          get: "GET 请求",
          post: "POST 请求",
          error: "获取失败",
          success: "创建成功"
        },
        slots: {
          title: "插槽",
          default: "默认插槽",
          componentSide: "组件内",
          usageSide: "使用时",
          named: "命名插槽"
        }
      }
    },

    // 示例页
    examples: {
      title: "示例 - vhtml",
      subtitle: "vhtml 功能演示与代码示例",
      demoList: {
        counter: "计数器",
        twoWay: "双向数据绑定",
        condition: "条件渲染",
        list: "列表渲染",
        tabs: "Tab 切换",
        preview: "组件预览"
      },
      counter: {
        code: "代码"
      },
      twoWay: {
        placeholder: "输入内容...",
        youEntered: "你输入了："
      },
      condition: {
        hideContent: "隐藏内容",
        showContent: "显示内容",
        contentText: "🎉 这是条件渲染的内容！"
      },
      list: {
        placeholder: "添加待办事项...",
        add: "添加",
        delete: "删除",
        defaultTodos: {
          learn: "学习 vhtml",
          create: "创建项目",
          publish: "发布应用"
        }
      },
      tabs: {
        home: "首页",
        profile: "个人",
        settings: "设置",
        homeContent: "🏠 这是首页内容",
        profileContent: "👤 这是个人资料内容",
        settingsContent: "⚙️ 这是设置内容"
      }
    },

    // 生态页
    ecosystem: {
      title: "生态 - vhtml",
      subtitle: "探索 vhtml 的周边工具、组件库和社区资源",
      core: {
        cli: {
          title: "vhtml CLI",
          desc: "官方命令行工具，快速创建项目、生成组件、构建部署"
        },
        ui: {
          title: "vhtml UI",
          desc: "官方组件库，提供丰富的基础组件和业务组件"
        },
        router: {
          title: "vhtml Router",
          desc: "增强版路由插件，支持嵌套路由、路由守卫、懒加载"
        },
        charts: {
          title: "vhtml Charts",
          desc: "基于 ECharts 的图表组件库，轻松创建数据可视化"
        },
        form: {
          title: "vhtml Form",
          desc: "表单解决方案，包含表单验证、动态表单、表单生成器"
        },
        i18n: {
          title: "vhtml i18n",
          desc: "国际化插件，支持多语言切换、语言包管理"
        }
      },
      community: {
        title: "社区资源",
        awesome: {
          title: "Awesome vhtml",
          desc: "精选的 vhtml 资源列表，包含教程、工具、项目案例",
          tag: "资源合集"
        },
        devtools: {
          title: "vhtml DevTools",
          desc: "浏览器开发者工具扩展，用于调试 vhtml 应用",
          tag: "开发工具"
        },
        tutorial: {
          title: "vhtml 实战教程",
          desc: "从入门到精通的完整教程系列，包含视频和文档",
          tag: "教程"
        },
        templates: {
          title: "vhtml Templates",
          desc: "官方项目模板集合，包含后台管理、移动端、官网等",
          tag: "模板"
        }
      }
    },

    // 关于页
    about: {
      title: "关于 - vhtml",
      subtitle: "了解框架的版本、开发者和开源信息",
      project: {
        title: "项目介绍",
        p1: "vhtml 是一个由 veypi 开发的轻量级响应式前端框架。项目始于 2024 年，旨在提供一个简单、高效、无需复杂构建工具的前端开发解决方案。",
        p2: "vhtml 采用原生 HTML5 语法，开发者无需学习复杂的构建流程和新的模板语法，即可快速构建现代化的 Web 应用。"
      },
      version: {
        title: "版本信息",
        current: "当前版本",
        size: "压缩体积",
        firstRelease: "首次发布",
        license: "开源协议"
      },
      developer: {
        title: "开发者",
        name: "veypi",
        desc: "vhtml 框架作者，热爱开源，专注于前端工具链开发",
        email: "邮箱"
      },
      links: {
        title: "相关链接",
        npm: {
          title: "NPM 包",
          desc: "@veypi/vhtml"
        },
        github: {
          title: "GitHub 仓库",
          desc: "github.com/veypi/vhtml"
        },
        changelog: {
          title: "更新日志",
          desc: "查看版本更新历史"
        },
        issues: {
          title: "问题反馈",
          desc: "提交 Bug 或功能建议"
        }
      },
      license: {
        title: "开源协议",
        desc: "vhtml 采用 MIT 协议开源，你可以自由使用、修改和分发。",
        text: `MIT License

Copyright (c) 2024-2025 veypi

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.`
      }
    },

    // 预览页
    preview: {
      title: "组件预览",
      subtitle: "实时编辑代码并预览效果",
      componentTitle: "预览组件",
      previewTitle: "预览",
      reset: "重置",
      emptyState: "暂无内容，请在左侧编辑代码",
      mode: {
        split: "左右分栏",
        switch: "切换模式"
      },
      examples: {
        basic: "基础示例",
        form: "表单示例",
        card: "卡片示例"
      },
      showCode: "显示代码",
      showPreview: "显示预览"
    },

    // 404页
    notFound: {
      title: "404 - 页面未找到",
      code: "404",
      titleText: "页面未找到",
      message: "抱歉，您访问的页面不存在或已被移除",
      backHome: "返回首页",
      backPrev: "返回上一页"
    },

    // 语言切换
    lang: {
      zh: "中文",
      en: "English",
      switch: "切换语言"
    }
  },

  "en-US": {
    // Common
    common: {
      docs: "Docs",
      examples: "Examples",
      ecosystem: "Ecosystem",
      about: "About",
      home: "Home",
      github: "GitHub",
      copyright: "vhtml © 2025 | {github}",
      back: "Back",
      loading: "Loading...",
    },

    // Preview
    preview: {
      title: "Component Preview",
      subtitle: "Edit code in real-time and preview the results",
      componentTitle: "Preview Component",
      previewTitle: "Preview",
      reset: "Reset",
      emptyState: "No content yet, please edit code on the left",
      mode: {
        split: "Split View",
        switch: "Switch Mode"
      },
      examples: {
        basic: "Basic Example",
        form: "Form Example",
        card: "Card Example"
      },
      showCode: "Show Code",
      showPreview: "Show Preview"
    },

    // Home
    home: {
      title: "vhtml - Lightweight Reactive Frontend Framework",
      subtitle: "Lightweight reactive frontend framework based on native HTML5 syntax, no complex compilation required",
      quickStart: "Quick Start",
      viewExamples: "View Examples",
      features: "Core Features",
      syntax: "Clean Syntax",
      featureList: {
        lightweight: {
          title: "Lightweight & Fast",
          desc: "Only 96KB compressed, no dependencies, fast loading, excellent performance"
        },
        native: {
          title: "Native Syntax",
          desc: "Based on standard HTML5, low learning curve, no complex build tools needed"
        },
        reactive: {
          title: "Reactive Binding",
          desc: "Automatic data binding, view updates when state changes, more efficient development"
        },
        component: {
          title: "Component-based",
          desc: "Support component encapsulation, props passing, event communication, easier code reuse"
        },
        router: {
          title: "Client-side Routing",
          desc: "Built-in routing system, supports dynamic routes, route guards, SPA development made easy"
        },
        ready: {
          title: "Ready to Use",
          desc: "Integrated Axios, FontAwesome, ECharts, no extra configuration needed"
        }
      },
      codeComments: {
        dataBinding: "Data binding",
        condition: "Conditional rendering",
        list: "List rendering",
        event: "Event binding"
      }
    },

    // Docs
    docs: {
      title: "Docs - vhtml",
      sidebar: {
        guide: "Guide",
        basics: "Basics",
        advanced: "Advanced"
      },
      sections: {
        intro: "Introduction",
        quickstart: "Quick Start",
        structure: "Directory Structure",
        template: "Template Syntax",
        data: "Reactive Data",
        events: "Event Handling",
        components: "Components",
        router: "Router",
        api: "API Calls",
        slots: "Slots"
      },
      content: {
        intro: {
          title: "Introduction",
          desc: "vhtml is a lightweight reactive frontend framework using native HTML5 syntax, enabling rapid Web application development without complex build tools.",
          features: "Features",
          featureList: {
            lightweight: "Lightweight - Only 96KB compressed, no external dependencies",
            simple: "Simple - Based on standard HTML5, low learning curve",
            reactive: "Reactive - Automatic data binding, state-driven views",
            component: "Component-based - Support component encapsulation and reuse",
            router: "Router - Built-in client-side routing system"
          },
          browser: "Browser Support",
          browserDesc: "vhtml supports all modern browsers including Chrome, Firefox, Safari, Edge, etc."
        },
        quickstart: {
          title: "Quick Start",
          install: "Installation",
          npmInstall: "Install via npm:",
          cdn: "Or include via CDN:",
          firstPage: "Create Your First Page",
          createIndex: "Create index.html:"
        },
        structure: {
          title: "Directory Structure",
          desc: "Recommended vhtml project directory structure:"
        },
        template: {
          title: "Template Syntax",
          textInterpolation: "Text Interpolation",
          attrBinding: "Attribute Binding",
          dynamicAttr: "Dynamic Attribute",
          twoWay: "Two-way Binding",
          condition: "Conditional Rendering",
          list: "List Rendering"
        },
        data: {
          title: "Reactive Data",
          declare: "Declaring Data",
          declareDesc: "Use = assignment to declare reactive data in <script setup>:",
          access: "Accessing Data",
          accessDesc: "Use variable names directly in templates:",
          inScript: "Access in Script",
          inScriptDesc: "Use $data to access and modify:"
        },
        events: {
          title: "Event Handling",
          listen: "Listening to Events",
          handler: "Event Handlers",
          custom: "Emitting Custom Events",
          customDesc: "Emit events to parent components:"
        },
        components: {
          title: "Components",
          create: "Creating Components",
          createDesc: "Create HTML files in /ui/components/ directory:",
          usage: "Using Components",
          usageDesc: "Path /ui/components/my-button.html maps to tag <components-my-button>:"
        },
        router: {
          title: "Router",
          config: "Configuring Routes",
          configDesc: "Configure in /ui/routes.js:",
          nav: "Navigation",
          linkNav: "Link Navigation",
          progNav: "Programmatic Navigation"
        },
        api: {
          title: "API Calls",
          desc: "vhtml has built-in $axios for HTTP requests:",
          get: "GET Request",
          post: "POST Request",
          error: "Failed to fetch",
          success: "Created successfully"
        },
        slots: {
          title: "Slots",
          default: "Default Slot",
          componentSide: "Inside Component",
          usageSide: "When Using",
          named: "Named Slot"
        }
      }
    },

    // Examples
    examples: {
      title: "Examples - vhtml",
      subtitle: "vhtml feature demos and code examples",
      demoList: {
        counter: "Counter",
        twoWay: "Two-way Data Binding",
        condition: "Conditional Rendering",
        list: "List Rendering",
        tabs: "Tab Switching",
        preview: "Component Preview"
      },
      counter: {
        code: "Code"
      },
      twoWay: {
        placeholder: "Enter content...",
        youEntered: "You entered:"
      },
      condition: {
        hideContent: "Hide",
        showContent: "Show",
        contentText: "🎉 This is conditionally rendered content!"
      },
      list: {
        placeholder: "Add todo item...",
        add: "Add",
        delete: "Delete",
        defaultTodos: {
          learn: "Learn vhtml",
          create: "Create project",
          publish: "Publish app"
        }
      },
      tabs: {
        home: "Home",
        profile: "Profile",
        settings: "Settings",
        homeContent: "🏠 This is home content",
        profileContent: "👤 This is profile content",
        settingsContent: "⚙️ This is settings content"
      }
    },

    // Ecosystem
    ecosystem: {
      title: "Ecosystem - vhtml",
      subtitle: "Explore vhtml tools, component libraries and community resources",
      core: {
        cli: {
          title: "vhtml CLI",
          desc: "Official CLI tool for quick project creation, component generation, and deployment"
        },
        ui: {
          title: "vhtml UI",
          desc: "Official component library with rich basic and business components"
        },
        router: {
          title: "vhtml Router",
          desc: "Enhanced routing plugin with nested routes, route guards, and lazy loading"
        },
        charts: {
          title: "vhtml Charts",
          desc: "Chart component library based on ECharts for easy data visualization"
        },
        form: {
          title: "vhtml Form",
          desc: "Form solution with validation, dynamic forms, and form builder"
        },
        i18n: {
          title: "vhtml i18n",
          desc: "Internationalization plugin with multi-language switching and locale management"
        }
      },
      community: {
        title: "Community Resources",
        awesome: {
          title: "Awesome vhtml",
          desc: "Curated list of vhtml resources including tutorials, tools, and project examples",
          tag: "Collection"
        },
        devtools: {
          title: "vhtml DevTools",
          desc: "Browser developer tools extension for debugging vhtml applications",
          tag: "Dev Tool"
        },
        tutorial: {
          title: "vhtml Tutorials",
          desc: "Complete tutorial series from beginner to advanced, with videos and docs",
          tag: "Tutorial"
        },
        templates: {
          title: "vhtml Templates",
          desc: "Official project templates including admin, mobile, and landing pages",
          tag: "Template"
        }
      }
    },

    // About
    about: {
      title: "About - vhtml",
      subtitle: "Learn about framework version, developer, and open source info",
      project: {
        title: "Project Introduction",
        p1: "vhtml is a lightweight reactive frontend framework developed by veypi. Started in 2024, it aims to provide a simple, efficient frontend development solution without complex build tools.",
        p2: "vhtml uses native HTML5 syntax, allowing developers to build modern Web applications without learning complex build processes or new template syntax."
      },
      version: {
        title: "Version Info",
        current: "Current Version",
        size: "Compressed Size",
        firstRelease: "First Release",
        license: "License"
      },
      developer: {
        title: "Developer",
        name: "veypi",
        desc: "Author of vhtml framework, open source enthusiast, focused on frontend tooling",
        email: "Email"
      },
      links: {
        title: "Related Links",
        npm: {
          title: "NPM Package",
          desc: "@veypi/vhtml"
        },
        github: {
          title: "GitHub Repository",
          desc: "github.com/veypi/vhtml"
        },
        changelog: {
          title: "Changelog",
          desc: "View version history"
        },
        issues: {
          title: "Issue Feedback",
          desc: "Submit bugs or feature requests"
        }
      },
      license: {
        title: "Open Source License",
        desc: "vhtml is open sourced under MIT license. You are free to use, modify, and distribute it.",
        text: `MIT License

Copyright (c) 2024-2025 veypi

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.`
      }
    },

    // 404
    notFound: {
      title: "404 - Page Not Found",
      code: "404",
      titleText: "Page Not Found",
      message: "Sorry, the page you visited does not exist or has been removed",
      backHome: "Back to Home",
      backPrev: "Back to Previous"
    },

    // Language switch
    lang: {
      zh: "中文",
      en: "English",
      switch: "Switch Language"
    }
  }
}
