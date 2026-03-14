import EventBus from '../vbus.js'
import axios from '../axios.min.js'
import I18n from '../i18n.js'
import vmessage from '../vmessage.js'

export function createEnvContext(parent = null, initial = {}) {
  const env = Object.create(parent || null)
  if (initial && typeof initial === 'object') {
    Object.assign(env, initial)
  }
  return env
}

export function cloneOwnEnv(env = null) {
  if (!env || typeof env !== 'object') {
    return {}
  }
  return Object.assign({}, env)
}

export function applyScopedAliases(target, scoped) {
  if (!target || !scoped) {
    return target
  }
  target.scoped = scoped.scoped || ''
  target.$scoped = scoped
  target.$axios = scoped.$axios
  target.$i18n = scoped.$i18n
  target.$message = scoped.$message
  target.$bus = scoped.$bus
  target.$t = scoped.$t
  target.$module = scoped.$module
  return target
}

export function createScopedContext(scoped, baseURL, sharedLocale, initial = {}) {
  const scopedContext = {
    ...initial,
    scoped,
    $bus: new EventBus(),
    $axios: axios.create({ baseURL }),
    $i18n: new I18n(sharedLocale),
    $message: vmessage,
    $emit: null,
    $module: {
      scoped,
      origin: window.location.origin,
      baseURL,
    },
  }
  scopedContext.$t = (key, params = {}) => scopedContext.$i18n.t(key, params)
  return scopedContext
}
