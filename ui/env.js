
/* 初始化所有环境变量
 * $router: 路由对象
 * $axios: axios 对象
 * $bus: 全局事件总线对象
 * $global: 全局变量对象
 * */
import langs from './langs.js'
export default async ($env) => {
  $env.$i18n.load(langs)
}
