/*
 * reactive.js — 响应式系统
 * Copyright (C) 2024 veypi <i@veypi.com>
 *
 * 基于 Proxy 的依赖追踪，批量异步更新（rAF）。
 */

const callbackList = []
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

export function GenUniqueID() {
  const timestamp = performance.now().toString(36)
  const random = Math.random().toString(36).substring(2, 5)
  return `${timestamp}-${random}`
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

const listen_tags = []

/**
 * @param {()=>void} callback
 * @returns number
 */
export function Watch(target, callback, options) {
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
    callbackList.push(() => callback(runTarget()))
  } else {
    callbackList.push(runTarget)
  }
  const res = runTarget()
  if (typeof callback === 'function') {
    callback(res)
  }
  return idx
}

export function Cancel(idx) {
  if (idx < 0 || idx >= callbackList.length) return
  callbackList[idx] = null
}

const isProxy = Symbol("isProxy")
export const DataID = Symbol("DataID")
const DataBind = Symbol("bind")
const rootObj = Symbol("root")

export function IsWrapped(data) {
  return Boolean(data && typeof data === 'object' && data[isProxy])
}

export function EnsureWrap(data, root = undefined) {
  if (!data || typeof data !== 'object') return data
  if (IsWrapped(data)) {
    if (root) SetDataRoot(data, root)
    return data
  }
  return Wrap(data, root)
}

export function SetDataRoot(data, root) {
  data[rootObj] = root
}

function isProxyType(v) {
  if (!v || typeof v !== 'object') return false
  if (v instanceof Node || v instanceof Date || v instanceof RegExp || v instanceof Event) return false
  if (v.__noproxy) return false
  if (v.constructor !== Object && v.constructor !== Array) return false
  return true
}

function copyBind(oldValue, newValue) {
  if (!oldValue || !oldValue[isProxy] || !isProxyType(newValue)) {
    return newValue
  }
  let binds = oldValue[DataBind]
  if (newValue[isProxy]) {
    if (newValue[DataID] === oldValue[DataID]) return newValue
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
    if (Array.isArray(newValue) && Array.isArray(oldValue)) {
      oldValue.length = 0
      for (let i = 0; i < newValue.length; i++) {
        oldValue.push(newValue[i])
      }
      return oldValue
    }
    Object.keys(oldValue).forEach(k => {
      if (!newValue.hasOwnProperty(k)) delete oldValue[k]
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

export function Wrap(data, root = undefined) {
  const did = GenUniqueID()
  const isArray = Array.isArray(data)
  if (root) SetDataRoot(data, root)
  data[DataID] = did
  const listeners = {}
  const handler = {
    get(target, key, receiver) {
      if (key === DataID) return did
      else if (key === isProxy) return true
      else if (key === DataBind) return listeners
      const hasLocalKey = Reflect.has(target, key)
      const value = Reflect.get(target, key, receiver)
      if (!hasLocalKey && target[rootObj] && key in target[rootObj]) {
        return target[rootObj][key]
      }
      if (typeof key === 'symbol' && stopChecking) return value
      else if (typeof value === 'function') return value
      let idx = -1
      if (listen_tags.length > 0) {
        let lkey = key
        idx = listen_tags[listen_tags.length - 1]
        if (isArray) lkey = ''
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
      return value
    },
    set(target, key, newValue, receiver) {
      const oldValue = Reflect.get(target, key, receiver)
      if (oldValue === newValue) return true
      else if (stopChecking) return Reflect.set(target, key, newValue, receiver)
      let result = true
      if (Array.isArray(newValue) && Array.isArray(oldValue)) {
        oldValue.length = 0
        for (let i = 0; i < newValue.length; i++) {
          oldValue.push(newValue[i])
        }
      } else if (oldValue && oldValue[isProxy] && isProxyType(newValue)) {
        newValue = copyBind(oldValue, newValue)
        result = Reflect.set(target, key, newValue, receiver)
      } else {
        result = Reflect.set(target, key, newValue, receiver)
      }
      if (result && listen_tags.length === 0) {
        let lkey = key
        if (isArray) lkey = ''
        if (listeners[lkey]) {
          let i = 0
          while (i < listeners[lkey].length) {
            let cb = listeners[lkey][i]
            if (!callbackList[cb]) {
              listeners[lkey].splice(i, 1)
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
    has(target, key) {
      if (Reflect.has(target, key)) return true
      return Boolean(target[rootObj] && key in target[rootObj])
    },
    deleteProperty(target, key) {
      const result = Reflect.deleteProperty(target, key)
      if (result && listen_tags.length === 0) {
        let lkey = key
        if (isArray) lkey = ''
        if (listeners[lkey]) {
          let i = 0
          while (i < listeners[lkey].length) {
            let cb = listeners[lkey][i]
            if (!callbackList[cb]) {
              listeners[lkey].splice(i, 1)
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
  }
  return new Proxy(data, handler)
}
