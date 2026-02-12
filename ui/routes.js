/* { path: 'XXXX', name: 'XXXX', component: 'XXXX',
* layout: 'XXXX', // layout 会自动解析layout/目录下同名组件到body内，视图外层,为空则不加载外层布局
* meta: {auth: true, title: 'XXXX', ...},
* description: 'XXXX'}
* */

const routes = [
  { path: '/', component: '/page/index.html', name: 'home', layout: '', description: '' },
  { path: '*', component: '/page/404.html', name: '404', layout: '', description: '404' },
]

export default routes
