/* 初始化所有环境变量
 * $router: 路由对象
 * $axios: axios 对象
 * $bus: 全局事件总线对象
 * route: { path: 'XXXX', name: 'XXXX', component: 'XXXX',
 * layout: 'XXXX', // layout 会自动解析layout/目录下同名组件到body内，视图外层,为空则不加载外层布局
 * meta: {auth: true, title: 'XXXX', ...},
 * description: 'XXXX'}
 * */

const routes = [
  { path: '/', component: '/page/index.html', name: 'home', layout: 'default', description: '首页' },
  { path: '*', component: '/page/404.html', name: '404', layout: 'default', description: '404' },
]

export default async ($env) => {
  $env.$router.addRoutes(routes)
  $env.$router.beforeEnter = async (to, from, next) => {
    if (to.meta && to.meta.auth) {
      // handle auth check
    } else {
      next();
    }
  };

  $env.$axios.interceptors.request.use(config => {
    // handle auth token
    return config;
  }, error => {
    return Promise.reject(error);
  });

  $env.$axios.interceptors.response.use(function(response) {
    return response?.data
  }, function(error) {
    let data = error.response ? error.response.data : error.response
    return Promise.reject(data?.message || data);
  });
}
