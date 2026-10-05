function CamelToKebabCase(str) {
  // 首先将字符串的第一个字符转换为小写，避免在首字符前加上'-'
  if (str.length === 0) return ''
  let firstChar = str.charAt(0).toLowerCase()

  // 对剩余部分应用原逻辑：找到每个大写字母，并替换为连字符加上该字母的小写形式
  let rest = str.slice(1).replace(/([A-Z])/g, function (match, p1) {
    return '-' + p1.toLowerCase()
  })

  return firstChar + rest
}

const outerClickList = []
document.addEventListener('click', (event) => {
  outerClickList.forEach((item) => {
    if (item?.dom instanceof Element && typeof item?.callback === 'function') {
      if (!item.dom.contains(event.target)) {
        item.callback(event)
      }
    }
  })
})
const AddClicker = (dom, typ, callback) => {
  if (typ === 'outer') {
    let idx = outerClickList.length
    outerClickList.push({ dom, callback })
    return () => {
      outerClickList[idx] = null
    }
  }
}

const EventsList = [
  // 窗口和框架事件
  'load',
  'unload',
  'beforeunload',
  'resize',
  'scroll',
  'scrollend',

  // 表单事件
  'submit',
  'reset',
  'input',
  'change',
  'focus',
  'blur',
  'focusin',
  'focusout',
  'beforeinput',

  // 键盘事件
  'keydown',
  'keypress',
  'keyup',

  // 鼠标事件
  'click',
  'dblclick',
  'contextmenu',
  'mousedown',
  'mouseup',
  'mousemove',
  'mouseover',
  'mouseout',
  'mouseenter',
  'mouseleave',
  'wheel',

  // 指针事件
  'pointerdown',
  'pointermove',
  'pointerup',
  'pointercancel',
  'pointerover',
  'pointerout',
  'pointerenter',
  'pointerleave',
  'gotpointercapture',
  'lostpointercapture',

  // 触摸事件
  'touchstart',
  'touchmove',
  'touchend',
  'touchcancel',

  // 拖拽事件
  'drag',
  'dragstart',
  'dragend',
  'dragover',
  'dragenter',
  'dragleave',
  'drop',

  // 剪贴板事件
  'copy',
  'cut',
  'paste',

  // 动画事件
  'animationstart',
  'animationend',
  'animationiteration',

  // 过渡事件
  'transitionend',
  'transitionrun',
  'transitionstart',
  'transitioncancel',

  // 文件操作事件
  'abort',
  'error',
  'loadstart',
  'progress',

  // 音视频事件
  'play',
  'pause',
  'ended',
  'volumechange',
  'timeupdate',
  'loadeddata',
  'waiting',
  'playing',

  // 网络状态事件
  'online',
  'offline',

  // 存储事件
  'storage',

  // 页面可见性事件
  'visibilitychange',
]

export function getPath(root, chain) {
  let cur = root
  for (const k of chain) {
    if (cur == null) return undefined
    cur = cur[k]
  }
  return cur
}

/**
 * 沿路径链向根对象写值；中间节点缺失时 no-op（不创建对象、不抛），
 */
export function setPath(root, chain, value) {
  if (!chain || chain.length === 0) return false
  let cur = root
  for (let i = 0; i < chain.length - 1; i++) {
    if (cur == null) return false
    cur = cur[chain[i]]
  }
  if (cur == null) return false
  cur[chain[chain.length - 1]] = value
  return true
}

function BindInputDomValue(dom, bind, watch, scope) {
  const element = typeof dom === 'string' ? document.querySelector(dom) : dom

  if (!element) {
    console.error('DOM元素未找到')
    return
  }
  const getValue = () => getPath(bind.root, bind.chain)
  const setValue = (v) => {
    setPath(bind.root, bind.chain, v)
  }
  const bindWatch = (target, callback) => {
    return watch(target, callback)
  }
  const bindEvent = (event, handler) => {
    if (scope?.addEventListener) {
      scope.addEventListener(element, event, handler)
    } else {
      element.addEventListener(event, handler)
    }
  }
  // 根据元素类型进行双向绑定
  const elementType = element.type || element.tagName.toLowerCase()
  switch (elementType) {
    // 文本输入类
    case 'text':
    case 'password':
    case 'email':
    case 'tel':
    case 'url':
    case 'search':
    case 'number':
    case 'range':
    case 'color':
    case 'date':
    case 'time':
    case 'datetime-local':
    case 'month':
    case 'week':
    case 'hidden':
    case 'textarea':
      bindWatch(getValue, (value) => {
        if (value === undefined) {
          element.value = ''
        } else {
          element.value = value
        }
      })
      bindEvent('input', function () {
        setValue(this.value)
      })
      break
    case 'checkbox':
      bindWatch(function () {
        element.checked = !!getValue()
      })
      bindEvent('change', function () {
        setValue(this.checked)
      })
      break
    // 单选框
    case 'radio':
      // 初始化
      bindWatch(() => {
        element.checked = element.value === getValue()
      })
      bindEvent('change', function () {
        if (this.checked) {
          setValue(this.value)
        }
      })
      break

    // 下拉选择框
    case 'select-one':
    case 'select-multiple':
      bindWatch(() => {
        let newValue = getValue()
        if (element.multiple) {
          const values = Array.isArray(newValue) ? newValue : []
          for (let i = 0; i < element.options.length; i++) {
            element.options[i].selected = values.includes(
              element.options[i].value
            )
          }
        } else {
          element.value = newValue || ''
        }
      })
      // 监听变化
      bindEvent('change', function () {
        if (this.multiple) {
          // 多选
          const selectedValues = []
          for (let i = 0; i < this.options.length; i++) {
            if (this.options[i].selected) {
              selectedValues.push(this.options[i].value)
            }
          }
          setValue(selectedValues)
        } else {
          // 单选
          setValue(this.value)
        }
      })
      break

    default:
      console.warn(
        `${elementType} not support v:bind  only for input element`,
        element
      )
      return false
  }
  return true
}

/**
 * 给 Promise 加超时：超时后 reject（调用方自行 catch 兜底）。
 * 用于 fetch / 动态 import / script 加载等网络操作，
 * 避免服务端挂起（accept 后不响应）导致组件永久卡在 vparsing。
 */
export function withTimeout(promise, ms, label = 'operation') {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timeout after ${ms}ms`))
    }, ms)
    promise.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      }
    )
  })
}

export default {
  CamelToKebabCase,
  EventsList,
  BindInputDomValue,
  AddClicker,
  withTimeout,
  getPath,
  setPath,
}
