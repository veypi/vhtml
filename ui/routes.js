/* { path: 'XXXX', name: 'XXXX', component: 'XXXX',
* layout: 'XXXX', // layout 会自动解析layout/目录下同名组件到body内，视图外层,为空则不加载外层布局
* error_redirect: 'XXXX', // component 对应 HTML 加载失败时跳转到该路由，可为字符串、路由对象或函数
* meta: {auth: true, title: 'XXXX', ...},
* description: 'XXXX'}
* */

const routes = [
  // 首页
  { path: '/', component: '/page/index.html', name: 'home', layout: 'default', description: 'vhtml - 轻量级响应式前端框架' },

  // 文档页面
  { path: '/docs', component: '/page/docs.html', name: 'docs', layout: 'default', description: '文档 - 使用指南与API参考' },

  // 示例页面
  { path: '/examples', component: '/page/examples.html', name: 'examples', layout: 'default', description: '示例 - 功能演示与代码案例' },

  // 运行时冒烟页
  { path: '/runtime-smoke', component: '/page/runtime_smoke.html', name: 'runtime-smoke', layout: 'default', description: '运行时冒烟验证页' },
  { path: '/runtime-smoke/cache/:name', component: '/page/runtime_cache_probe.html', name: 'runtime-smoke-cache', layout: 'default', cacheKey: 'runtime-smoke-cache', description: '运行时缓存页验证' },

  // 生态页面
  { path: '/ecosystem', component: '/page/ecosystem.html', name: 'ecosystem', layout: 'default', description: '生态 - 工具与资源' },

  // 关于页面
  { path: '/about', component: '/page/about.html', name: 'about', layout: 'default', description: '关于 - 版本与开发者信息' },

  // 404页面
  { path: '*', component: '/page/404.html', name: '404', layout: 'default', description: '页面未找到' },
]

export default routes
