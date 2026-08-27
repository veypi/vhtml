/* { path: 'XXXX', name: 'XXXX', component: 'XXXX',
* layout: 'XXXX', // layout 会自动解析 layout/ 目录下同名组件到 body 内，为空则不加载外层布局
* meta: {auth: true, title: 'XXXX', ...}}
* */

const routes = [
  // 首页
  { path: '/', component: '/page/index.html', name: 'home' },

  // 404 页面
  { path: '*', component: '/page/404.html', name: '404' },
]

export default routes
