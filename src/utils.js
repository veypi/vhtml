

function CamelToKebabCase(str) {
  // 首先将字符串的第一个字符转换为小写，避免在首字符前加上'-'
  if (str.length === 0) return '';
  let firstChar = str.charAt(0).toLowerCase();

  // 对剩余部分应用原逻辑：找到每个大写字母，并替换为连字符加上该字母的小写形式
  let rest = str.slice(1).replace(/([A-Z])/g, function(match, p1) {
    return '-' + p1.toLowerCase();
  });

  return firstChar + rest;
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
  'visibilitychange'
];

/**
 * 不能作为 v: 表达式根标识符的名字：JS 字面量与保留字。
 * 旧 Proxy 求值对这类名字是 warn 放弃（findLastAccess 返回空），
 * 静态链解析必须保持同等拒绝，避免静默绑到 data['true'] 等键。
 */
const RESERVED_HEADS = new Set([
  // 字面量
  'true', 'false', 'null', 'undefined', 'NaN', 'Infinity',
  // 关键字/未来保留字（表达式位置非法）
  'var', 'let', 'const', 'function', 'class', 'if', 'else', 'for', 'while',
  'do', 'switch', 'case', 'break', 'continue', 'return', 'throw', 'new',
  'delete', 'typeof', 'instanceof', 'in', 'of', 'void', 'yield', 'await',
  'this', 'super', 'import', 'export', 'extends', 'default', 'with',
  'enum', 'static', 'implements', 'interface', 'package', 'private',
  'protected', 'public', 'debugger', 'arguments', 'eval', 'get', 'set',
])

/**
 * 静态解析 v: 双向绑定表达式为路径链（纯函数，无副作用）。
 * 支持形态：a.b.c / a['b.c'] / a["b.c"] / list[0].name
 * 返回值：路径链数组；无法静态解析（变量键、函数、运算等）返回 null，
 * 调用方回退到 findLastAccess 的 Proxy 求值（旧语义，行为不变）。
 */
export function parseAccessChain(code) {
  const s = (code || '').trim()
  if (!s) return null
  const chain = []
  const ident = /^[A-Za-z_$][A-Za-z0-9_$]*/
  const head = ident.exec(s)
  if (!head || RESERVED_HEADS.has(head[0])) return null
  chain.push(head[0])
  let i = head[0].length
  while (i < s.length) {
    const rest = s.slice(i)
    if (rest.startsWith('.')) {
      const m = ident.exec(rest.slice(1))
      if (!m) return null
      if (m[0] === '__proto__') return null // 原型链键：仅静态链，不再落入 getPath/setPath
      chain.push(m[0])
      i += 1 + m[0].length
    } else if (rest.startsWith('[')) {
      // 字符串字面量键（含点号，如 settings['app.name']）或数字索引
      if (rest[1] === "'" || rest[1] === '"') {
        const quote = rest[1]
        let j = 2
        let str = ''
        while (j < rest.length) {
          const ch = rest[j]
          // 遇 \ 不静态解析（JS 转义表与手写解析器不一致），回退旧 new Function 求值语义
          if (ch === '\\') return null
          if (ch === quote) break
          str += ch
          j++
        }
        if (j >= rest.length || rest[j + 1] !== ']') return null
        if (str === '__proto__') return null
        chain.push(str)
        i += j + 2
      } else {
        const m = /^\d+/.exec(rest.slice(1))
        if (!m) return null
        chain.push(Number(m[0]))
        i += 1 + m[0].length
        if (s[i] !== ']') return null
        i++
      }
    } else {
      return null
    }
  }
  return chain
}

/**
 * 沿路径链从根对象取值；任一中间节点缺失返回 undefined（不抛）。
 */
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
 * 与旧语义（args.data 缺失即 warn 放弃）对齐。
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
  const element = typeof dom === 'string' ? document.querySelector(dom) : dom;

  if (!element) {
    console.error('DOM元素未找到');
    return;
  }
  // bind = { root, chain }（惰性路径链，对象整体替换后依然有效）
  //     或 { data, key }（复杂表达式 fallback：旧语义，绑定解析时刻的对象）
  const getValue = () => bind.chain ? getPath(bind.root, bind.chain) : bind.data[bind.key]
  const setValue = (v) => {
    if (bind.chain) { setPath(bind.root, bind.chain, v) } else { bind.data[bind.key] = v }
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
  const elementType = element.type || element.tagName.toLowerCase();
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
      bindEvent('input', function() {
        setValue(this.value);
      });
      break;
    case 'checkbox':
      bindWatch(function() {
        element.checked = !!getValue();
      });
      bindEvent('change', function() {
        setValue(this.checked);
      });
      break;
    // 单选框
    case 'radio':
      // 初始化
      bindWatch(() => {
        element.checked = element.value === getValue();
      })
      bindEvent('change', function() {
        if (this.checked) {
          setValue(this.value);
        }
      });
      break;

    // 下拉选择框
    case 'select-one':
    case 'select-multiple':
      bindWatch(() => {
        let newValue = getValue()
        if (element.multiple) {
          const values = Array.isArray(newValue) ? newValue : [];
          for (let i = 0; i < element.options.length; i++) {
            element.options[i].selected = values.includes(element.options[i].value);
          }
        } else {
          element.value = newValue || '';
        }
      });
      // 监听变化
      bindEvent('change', function() {
        if (this.multiple) {
          // 多选
          const selectedValues = [];
          for (let i = 0; i < this.options.length; i++) {
            if (this.options[i].selected) {
              selectedValues.push(this.options[i].value);
            }
          }
          setValue(selectedValues);
        } else {
          // 单选
          setValue(this.value);
        }
      });
      break;

    default:
      console.warn(`${elementType} not support v:bind  only for input element`, element);
      return false
  }
  return true
}

function SetAttr(dom, key, value) {
  if (typeof value === 'function') {
    value = value()
  }
  // 属性名映射表
  const propertyMap = {
    'htmlfor': 'htmlFor',
    'readonly': 'readOnly',
    'maxlength': 'maxLength',
    'minlength': 'minLength',
    'cellspacing': 'cellSpacing',
    'cellpadding': 'cellPadding',
    'rowspan': 'rowSpan',
    'colspan': 'colSpan',
    'tabindex': 'tabIndex',
    'usemap': 'useMap',
    'frameborder': 'frameBorder',
    'contenteditable': 'contentEditable',
    'spellcheck': 'spellcheck',
    'autocapitalize': 'autocapitalize',
  };

  // 需要使用 DOM 属性设置的属性
  const domProperties = new Set([
    'value', 'checked', 'selected', 'disabled', 'readOnly',
    'maxLength', 'minLength', 'htmlFor',
    'tabIndex', 'scrollTop', 'scrollLeft', 'scrollWidth', 'scrollHeight',
    'clientWidth', 'clientHeight', 'offsetWidth', 'offsetHeight',
    'style', 'dataset'
  ]);

  // 布尔属性
  const booleanAttributes = new Set([
    'checked', 'selected', 'disabled', 'readonly', 'required',
    'hidden', 'autofocus', 'multiple', 'novalidate'
  ]);

  // 转换属性名
  const lowerKey = key.toLowerCase();
  const mappedKey = propertyMap[lowerKey] || key;



  // 设置属性的策略：
  if (domProperties.has(mappedKey)) {
    // DOM 属性
    if (value === undefined) {
      dom[mappedKey] = ''
    } else {
      dom[mappedKey] = value;
    }
  } else if (booleanAttributes.has(lowerKey)) {
    // 布尔属性
    if (value) {
      dom.setAttribute(lowerKey, '');
    } else {
      dom.removeAttribute(lowerKey);
    }
  } else {
    // 其他属性使用 setAttribute
    if (value === undefined) {
      dom.removeAttribute(key);
    } else {
      dom.setAttribute(key, value);
    }
  }
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
      (v) => { clearTimeout(timer); resolve(v) },
      (e) => { clearTimeout(timer); reject(e) }
    )
  })
}

export default { CamelToKebabCase, EventsList, BindInputDomValue, SetAttr, AddClicker, withTimeout, parseAccessChain, getPath, setPath }
