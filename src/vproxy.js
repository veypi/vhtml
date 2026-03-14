/*
 * proxy.js
 * Copyright (C) 2024 veypi <i@veypi.com>
 *
 * Distributed under terms of the MIT license.
 */


/** @type {([boolean, ()=>void])[]} */
const callbackList = []
/** @type {number[]} */
const cacheUpdateList = []
let pending = false
const scheduleFrame = typeof requestAnimationFrame === 'function'
  ? requestAnimationFrame.bind(window)
  : (callback) => setTimeout(callback, 16)

const flushUpdates = () => {
  pending = false
  const list = new Set(cacheUpdateList.splice(0))
  let count = 0
  for (const index of list) {
    if (callbackList[index]) {
      callbackList[index]()
      count++
    }
  }
  return count
}

const scheduleUpdate = () => {
  if (!pending) {
    pending = true
    scheduleFrame(flushUpdates)
  }
}

function GenUniqueID() {
  const timestamp = performance.now().toString(36);
  const random = Math.random().toString(36).substring(2, 5);
  return `${timestamp}-${random}`;
}

function ForceUpdate() {
  for (let c of callbackList) {
    if (c) {
      c()
    }
  }
}

window.$vupdate = (id) => {
  if (typeof callbackList[id] === 'function') {
    callbackList[id]()
  }
}

function deepAccess(obj, seen = new Set()) {
  if (obj && typeof obj === 'object' && !seen.has(obj)) {
    seen.add(obj)
    for (let key in obj) {
      deepAccess(obj[key], seen)
    }
  }
  return obj
}

/** @type {number[]} */
var listen_tags = []
/**
* @param {()=>void} callback
* @returns number
*/
function Watch(target, callback, options) {
  let idx = callbackList.length
  const runTarget = () => {
    listen_tags.push(idx)
    try {
      const res = target()
      if (options && options.deep) {
        deepAccess(res)
      }
      return res
    } catch (e) {
      console.warn('running \n%s\n failed:', target, e)
      return undefined
    } finally {
      listen_tags.pop()
    }
  }
  if (typeof callback === 'function') {
    callbackList.push(() => {
      callback(runTarget())
    })
  } else {
    callbackList.push(runTarget)
  }
  const res = runTarget()
  if (typeof callback === 'function') {
    callback(res)
  }
  return idx
}

function Cancel(idx) {
  if (idx < 0 || idx >= callbackList.length) {
    return
  }
  callbackList[idx] = null
}

const isProxy = Symbol("isProxy")
const DataID = Symbol("DataID")
const DataBind = Symbol("bind")
const rootObj = Symbol("root")
const rootArg = Symbol("root arg")


function SetDataRoot(data, root) {
  data[rootObj] = root
  Object.keys(root).forEach(k => {
    if (k in data) {
    } else {
      data[k] = rootArg
    }
  })
}

function isProxyType(v) {
  if (!v || typeof v !== 'object') {
    return false
  }
  if (v instanceof Node || v instanceof Date || v instanceof RegExp || v instanceof Event) {
    return false
  }
  if (v.__noproxy) {
    return false
  }
  if (v.constructor !== Object && v.constructor !== Array) {
    return false
  }
  return true
}

// oldValue只集成值， 不继承事件
function copyBind(oldValue, newValue) {
  if (!oldValue || !oldValue[isProxy] || !isProxyType(newValue)) {
    return newValue
  }
  let binds = oldValue[DataBind]
  if (newValue[isProxy]) {
    // 新值也是代理对象，继承旧值的事件绑定, 使用新的代理对象
    if (newValue[DataID] === oldValue[DataID]) {
      return newValue
    }
    for (let k in binds) {
      if (newValue[DataBind][k]?.indexOf) {
        const currentBinds = newValue[DataBind][k]
        const bindSet = new Set(currentBinds)
        for (let i of binds[k]) {
          if (!bindSet.has(i)) {
            currentBinds.push(i)
            bindSet.add(i)
          }
        }
      } else {
        newValue[DataBind][k] = binds[k]
      }
    }
  } else {
    // 新值不是代理对象，继承值，使用旧的代理对象
    if (Array.isArray(newValue) && Array.isArray(oldValue)) {
      oldValue.length = 0
      for (let i = 0; i < newValue.length; i++) {
        oldValue.push(newValue[i])
      }
      return oldValue
    }
    Object.keys(oldValue).forEach(k => {
      if (!newValue.hasOwnProperty(k)) {
        delete oldValue[k]
      }
    })
    Object.keys(newValue).forEach(k => {
      if (oldValue[k]?.[isProxy]) {
        oldValue[k] = copyBind(oldValue[k], newValue[k])
      } else {
        oldValue[k] = newValue[k]
      }
    })
    return oldValue
  }
  for (let k in newValue) {
    if (k in oldValue && oldValue[k]?.[isProxy]) {
      newValue[k] = copyBind(oldValue[k], newValue[k])
    }
  }
  return newValue
}


let stopChecking = false
function Wrap(data, root = undefined) {
  const did = GenUniqueID()
  let isArray = false
  if (Object.prototype.toString.call(data) === '[object Array]') {
    isArray = true
  }
  if (root) {
    SetDataRoot(data, root)
  }
  data[DataID] = did
  const listeners = {}
  const handler = {
    /**
    * @param {Object} target
    * @param {string|symbol} key
    *
     * */
    get(target, key, receiver) {
      if (key === DataID) {
        return did
      } else if (key === isProxy) {
        return true
      } else if (key === DataBind) {
        return listeners
      }
      const value = Reflect.get(target, key, receiver)
      if (value === rootArg) {
        return target[rootObj][key]
      }
      if (typeof key === 'symbol' && stopChecking) {
        return value
      } else if (typeof value === 'function') {
        return value
      }
      let idx = -1
      if (listen_tags.length > 0) {
        let lkey = key
        idx = listen_tags[listen_tags.length - 1]
        if (isArray) {
          lkey = ''
        }
        if (!listeners.hasOwnProperty(lkey)) {
          listeners[lkey] = [idx]
        } else if (listeners[lkey].indexOf(idx) == -1) {
          listeners[lkey].push(idx)
        }
      }
      if (isProxyType(value) && !value[isProxy]) {
        let newValue = Wrap(value, undefined)
        Reflect.set(target, key, newValue, receiver)
        return newValue
      }
      return value;
    },
    set(target, key, newValue, receiver) {
      const oldValue = Reflect.get(target, key, receiver)
      if (oldValue === rootArg) {
        target[rootObj][key] = newValue
        return true
      }
      if (oldValue === newValue) {
        return true
      } else if (stopChecking) {
        return Reflect.set(target, key, newValue, receiver)
      }
      let result = true
      if (Array.isArray(newValue) && Array.isArray(oldValue)) {
        // stopChecking = true
        oldValue.length = 0
        for (let i = 0; i < newValue.length; i++) {
          oldValue.push(newValue[i])
        }
        // stopChecking = false
      } else if (oldValue && oldValue[isProxy] && isProxyType(newValue)) {
        // 监听对象只赋值可迭代属性
        newValue = copyBind(oldValue, newValue)
        result = Reflect.set(target, key, newValue, receiver);
      } else {
        result = Reflect.set(target, key, newValue, receiver);
      }
      if (result && listen_tags.length === 0) {
        let lkey = key
        if (isArray) {
          lkey = ''
        }
        if (listeners[lkey]) {
          let i = 0
          while (i < listeners[lkey].length) {
            let cb = listeners[lkey][i]
            if (!callbackList[cb]) {
              listeners[lkey].splice(i, 1);
            } else {
              i++
              cacheUpdateList.push(cb)
              scheduleUpdate()
            }
          }
        }
      }
      return result;
    },
    deleteProperty(target, key) {
      const result = Reflect.deleteProperty(target, key);
      if (result && listen_tags.length === 0) {
        let lkey = key
        if (isArray) {
          lkey = ''
        }
        if (listeners[lkey]) {
          let i = 0
          while (i < listeners[lkey].length) {
            let cb = listeners[lkey][i]
            if (!callbackList[cb]) {
              listeners[lkey].splice(i, 1);
            } else {
              i++
              cacheUpdateList.push(cb)
              scheduleUpdate()
            }
          }
        }
      }
      return result
    },
  };

  let res = new Proxy(data, handler);
  return res
}

const expose = {
  'console': console,
  'window': window,
  'prompt': prompt.bind(window),
  'alert': alert.bind(window),
  'confirm': confirm.bind(window),
  'RegExp': RegExp,
  'document': document,
  'Array': Array,
  'Object': Object,
  'Math': Math,
  'Date': Date,
  'JSON': JSON,
  'Symbol': Symbol,
  'Number': Number,
  'eval': eval,
  'isNaN': isNaN,
  'parseInt': parseInt,
  'parseFloat': parseFloat,
  'setTimeout': setTimeout.bind(window),
  'setInterval': setInterval.bind(window),
  'clearTimeout': clearTimeout.bind(window),
  'clearInterval': clearInterval.bind(window),
  'encodeURIComponent': encodeURIComponent,
  'btoa': btoa.bind(window),
  'fetch': fetch.bind(window),
  'TextDecoder': TextDecoder,
  'history': history,
  'requestAnimationFrame': requestAnimationFrame.bind(window),
  'getComputedStyle': getComputedStyle.bind(window),
}

function newProxy(data, env = {}, tmpenv = {}) {
  const runtimeEnv = env || {}
  const runtimeTmpEnv = tmpenv || {}
  const runtimeScoped = runtimeEnv?.$scoped || null
  const proxy = new Proxy(data, {
    // 拦截所有属性，防止到 Proxy 对象以外的作用域链查找。
    has(target, key) {
      return true;
    },
    get(target, key, receiver) {
      let v
      if (key === '$data') {
        v = data
      } else if (key === '$env') {
        v = runtimeEnv
      } else if (key === '$scoped') {
        v = runtimeScoped
      } else if (key in target) {
        v = Reflect.get(target, key, receiver);
      } else if (runtimeTmpEnv && key in runtimeTmpEnv) {
        v = runtimeTmpEnv[key]
      } else if (key in runtimeEnv) {
        v = runtimeEnv[key]
      } else if (runtimeScoped && key in runtimeScoped) {
        v = runtimeScoped[key]
      } else if (key in expose) {
        v = expose[key]
      } else if (key in window) {
        v = window[key]
      }
      return v
    },
    set(target, key, newValue, receiver) {
      // code global variable set will work on "data"
      return Reflect.set(target, key, newValue, receiver);
    }
  });
  return proxy
}
const runCache = new Map()
function compileSandboxCode(originCode, cache, compiler, options = {}) {
  let fn = cache.get(originCode)
  if (fn) {
    return fn
  }
  let code = originCode.trim()
  const cleanCode = code.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '').trim()
  const isStatement = /^(var|let|const|if|for|while|switch|try|throw|class|function|return|debugger)\b/.test(cleanCode)
  const isSingleLineExpression = code.indexOf('\n') === -1
  if (options.returnExpression !== false && !isStatement && isSingleLineExpression) {
    code = `return ${code}`
  }
  const wrappedCode = `
with (sandbox) {
${code}
}`
  try {
    fn = compiler(wrappedCode)
    cache.set(originCode, fn)
    return fn
  } catch (error) {
    console.warn(`${options.label || 'Run'} compile error:`, originCode, '\n', error)
    return null
  }
}

function toPreview(value, maxLength = 400) {
  if (typeof value !== 'string') {
    return ''
  }
  const text = value.trim()
  if (text.length <= maxLength) {
    return text
  }
  return `${text.slice(0, maxLength)}...`
}

function buildErrorContext(originCode, data, env, tmpenv, label, error) {
  return {
    label,
    code: toPreview(originCode),
    dataKeys: Object.keys(data || {}),
    envKeys: Object.keys(env || {}),
    tmpEnvKeys: Object.keys(tmpenv || {}),
    message: error?.message || String(error),
    stack: error?.stack || '',
  }
}

function logSandboxError(originCode, data, env, tmpenv, label, error) {
  console.error(`${label} error`, buildErrorContext(originCode, data, env, tmpenv, label, error))
}

function executeSandboxCode(fn, originCode, data, env, tmpenv, label) {
  if (!fn) {
    return undefined
  }
  try {
    return fn(newProxy(data, env, tmpenv))
  } catch (error) {
    logSandboxError(originCode, data, env, tmpenv, label, error)
  }
  return undefined
}

async function executeSandboxCodeAsync(fn, originCode, data, env, tmpenv, label) {
  if (!fn) {
    return undefined
  }
  try {
    return await fn(newProxy(data, env, tmpenv))
  } catch (error) {
    logSandboxError(originCode, data, env, tmpenv, label, error)
    throw error
  }
}

// 运行dom属性绑定等小代码语句
// for code snapshot
function Run(originCode, data, env, tmpenv) {
  const fn = compileSandboxCode(originCode, runCache, (code) => new Function('sandbox', code), { label: 'Run' })
  return executeSandboxCode(fn, originCode, data, env, tmpenv, 'Run')
}

const AsyncFunction = Object.getPrototypeOf(async function() { }).constructor

const asyncRunCache = new Map()
// 运行大段代码库
async function AsyncRun(originCode, data, env, tmpenv) {
  const fn = compileSandboxCode(originCode, asyncRunCache, (code) => new AsyncFunction('sandbox', code), {
    label: 'AsyncRun',
    returnExpression: true,
  })
  return await executeSandboxCodeAsync(fn, originCode, data, env, tmpenv, 'AsyncRun')
}

export default {
  Wrap, Watch, Cancel, ForceUpdate, SetDataRoot,
  DataID, GenUniqueID, Run, AsyncRun
}
