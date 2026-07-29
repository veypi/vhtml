/*
 * vbus.js
 * Copyright (C) 2025 veypi <i@veypi.com>
 *
 * Distributed under terms of the MIT license.
 */


function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// 事件名是否含通配符（* 或 >），含则进入 pattern 订阅表
function isWildcardTopic(eventName) {
  return typeof eventName === 'string' && (eventName.includes('*') || eventName.includes('>'))
}

// NATS topic 通配规则：
//   * 匹配恰好一个 token（aa.*.bb 匹配 aa.x.bb，不匹配 aa.x.y.bb）
//   > 匹配零或多个尾部 token 且必须在末尾（aa.> 匹配 aa、aa.b、aa.b.c；单独 > 匹配所有）
// * 或 > 作为非完整 token 出现时按字面字符处理
function topicToRegExp(topic) {
  const tokens = topic.split('.')
  let bodyTokens = tokens
  let suffix = ''
  if (tokens[tokens.length - 1] === '>') {
    bodyTokens = tokens.slice(0, -1)
    suffix = bodyTokens.length > 0 ? '(?:\\..*)?' : '.*'
  }
  const body = bodyTokens
    .map(token => (token === '*' ? '[^.]+' : escapeRegExp(token)))
    .join('\\.')
  return new RegExp(`^${body}${suffix}$`)
}

class EventBus {
  constructor(broadcast = null) {
    // 存储事件监听器的对象
    this.events = {};
    // 通配订阅表：[{ topic, regex, callback, context }]
    this.patterns = [];
    this.broadcast = typeof broadcast === 'function' ? broadcast : null;
  }

  /**
   * 订阅事件
   * @param {string} eventName - 事件名称，支持 NATS 通配：aaa.*.ccc（单段）、aaa.>（多段后缀）
   * @param {Function} callback - 回调函数
   * @param {Object} context - 执行上下文（可选）
   * @returns {Function} 取消订阅的函数
   */
  on(eventName, callback, context = null) {
    if (typeof callback !== 'function') {
      throw new Error('回调函数必须是一个函数');
    }

    if (isWildcardTopic(eventName)) {
      this.patterns.push({ topic: eventName, regex: topicToRegExp(eventName), callback, context });
      return () => this.off(eventName, callback, context);
    }

    if (!this.events[eventName]) {
      this.events[eventName] = [];
    }

    const listener = { callback, context };
    this.events[eventName].push(listener);

    // 返回取消订阅的函数
    return () => this.off(eventName, callback, context);
  }

  /**
   * 一次性事件监听
   * @param {string} eventName - 事件名称
   * @param {Function} callback - 回调函数
   * @param {Object} context - 执行上下文（可选）
   * @returns {Function} 取消订阅的函数
   */
  once(eventName, callback, context = null) {
    const onceWrapper = (...args) => {
      this.off(eventName, onceWrapper, context);
      callback.apply(context, args);
    };

    return this.on(eventName, onceWrapper, context);
  }

  /**
   * 取消事件订阅
   * @param {string} eventName - 事件名称（通配订阅传订阅时的原始 pattern）
   * @param {Function} callback - 要移除的回调函数（可选）
   * @param {Object} context - 执行上下文（可选）
   */
  off(eventName, callback = null, context = null) {
    if (isWildcardTopic(eventName)) {
      if (!callback) {
        this.patterns = this.patterns.filter(l => l.topic !== eventName);
        return;
      }
      this.patterns = this.patterns.filter(l => {
        return !(l.topic === eventName && l.callback === callback && l.context === context);
      });
      return;
    }

    if (!this.events[eventName]) {
      return;
    }

    // 如果没有指定回调函数，移除该事件的所有监听器
    if (!callback) {
      delete this.events[eventName];
      return;
    }

    // 移除特定的监听器
    this.events[eventName] = this.events[eventName].filter(listener => {
      return !(listener.callback === callback && listener.context === context);
    });

    // 如果该事件没有监听器了，删除该事件
    if (this.events[eventName].length === 0) {
      delete this.events[eventName];
    }
  }

  /**
   * 触发事件
   * @param {string} eventName - 事件名称
   * @param {...any} args - 传递给回调函数的参数
   */
  emitLocal(eventName, ...args) {
    // 复制监听器数组，避免在执行过程中修改原数组导致的问题
    const listeners = this.events[eventName] ? [...this.events[eventName]] : [];
    for (const l of this.patterns) {
      if (l.regex.test(eventName)) listeners.push(l);
    }

    listeners.forEach(listener => {
      try {
        listener.callback.apply(listener.context, args);
      } catch (error) {
        console.error(`事件 "${eventName}" 的监听器执行出错:`, error);
      }
    });
  }

  /**
   * 触发事件。
   * 事件名以 '@.' 开头时，去掉前缀后跨模块广播（仅其他模块收到，本地不触发）。
   * 普通事件名仅触发本地监听器。
   * @param {string} eventName - 事件名称，'@.xxx' 表示跨模块广播 xxx
   * @param {...any} args - 传递给回调函数的参数
   */
  emit(eventName, ...args) {
    if (typeof eventName === 'string' && eventName.startsWith('@.')) {
      const realName = eventName.slice(2)
      if (!realName) return
      this.broadcast?.(realName, args, this)
      return
    }
    this.emitLocal(eventName, ...args)
  }

  /**
   * 获取事件的监听器数量
   * @param {string} eventName - 事件名称（普通事件名返回精确订阅数 + 匹配到的通配订阅数；
   *   传 pattern 则返回该 pattern 的订阅数）
   * @returns {number} 监听器数量
   */
  listenerCount(eventName) {
    if (isWildcardTopic(eventName)) {
      return this.patterns.filter(l => l.topic === eventName).length;
    }
    const exact = this.events[eventName] ? this.events[eventName].length : 0;
    return exact + this.patterns.reduce((n, l) => n + (l.regex.test(eventName) ? 1 : 0), 0);
  }

  /**
   * 获取所有事件名称（含通配订阅的 pattern）
   * @returns {string[]} 事件名称数组
   */
  eventNames() {
    return [...Object.keys(this.events), ...new Set(this.patterns.map(l => l.topic))];
  }

  /**
   * 移除所有事件监听器
   */
  removeAllListeners() {
    this.events = {};
    this.patterns = [];
  }

  /**
   * 检查是否有某个事件的监听器
   * @param {string} eventName - 事件名称
   * @returns {boolean} 是否有监听器
   */
  hasListeners(eventName) {
    return this.listenerCount(eventName) > 0;
  }
}

export default EventBus;
