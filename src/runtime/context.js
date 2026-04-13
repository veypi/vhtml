import EventBus from '../vbus.js'
import axios from '../axios.min.js'
import I18n from '../i18n.js'
import vmessage from '../vmessage.js'
import vproxy from '../vproxy.js'

export function getModuleContext(source = null) {
  if (!source || typeof source !== 'object') {
    return null
  }
  return source.$mod || source
}

export function getModulePath(source = null) {
  const mod = getModuleContext(source)
  return mod?.scoped || ''
}

export function getBaseURL(source = null) {
  const mod = getModuleContext(source)
  return mod?.baseURL || window.location.origin
}

export function createModuleContext(scoped, baseURL, sharedLocale, initial = {}) {
  const mod = {
    ...initial,
    scoped,
    baseURL,
    origin: window.location.origin,
    $bus: new EventBus(),
    $i18n: new I18n(sharedLocale),
  }
  mod.$t = (key, params = {}) => mod.$i18n.t(key, params)
  return mod
}

export function createSystemContext(parent = null, initial = {}) {
  const sys = Object.create(parent || null)
  if (!Object.prototype.hasOwnProperty.call(sys, '$message')) {
    sys.$message = vmessage
  }
  if (initial && typeof initial === 'object') {
    Object.assign(sys, initial)
  }
  return sys
}

export function createCtxContext(parent = null, initial = {}) {
  const seed = initial && typeof initial === 'object' ? { ...initial } : {}
  return vproxy.Wrap(seed, parent || undefined)
}

export function createRuntimeContext(parent = null, mod = null, initialSys = {}, initialCtx = {}) {
  const parentSys = parent?.$sys || null
  const parentCtx = parent?.$ctx || null
  const runtime = {
    $sys: createSystemContext(parentSys, initialSys),
    $ctx: createCtxContext(parentCtx, initialCtx),
    $mod: mod || parent?.$mod || null,
  }
  return runtime
}

export function createModuleHttpClient(baseURL) {
  return axios.create({ baseURL })
}
