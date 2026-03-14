/*
 * vmessage.js
 * Copyright (C) 2025 veypi <i@veypi.com>
 *
 * Distributed under terms of the MIT license.
 */

const MESSAGE_STYLE_ID = 'vhtml-message-style'

const MESSAGE_STYLE = `
  .vmsg-container {
    position: fixed;
    top: 60px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 9999;
    width: min(300px, calc(100vw - 32px));
  }

  .vmsg-item {
    margin-bottom: 10px;
    padding: 15px;
    border-radius: 4px;
    box-shadow: 0 2px 12px 0 rgba(0, 0, 0, 0.1);
    transform: translateY(100%);
    opacity: 0;
    transition: all 0.3s ease;
    display: flex;
    align-items: flex-start;
  }

  .vmsg-item.show {
    transform: translateY(0);
    opacity: 1;
  }

  .vmsg-icon {
    margin-right: 10px;
    font-size: 16px;
    line-height: 1;
  }

  .vmsg-content {
    flex: 1;
    font-size: 14px;
    line-height: 1.4;
  }

  .vmsg-close {
    margin-left: 10px;
    cursor: pointer;
    font-size: 16px;
    opacity: 0.7;
    transition: opacity 0.2s;
  }

  .vmsg-close:hover {
    opacity: 1;
  }

  .vmsg-success {
    background-color: #f0f9eb;
    border: 1px solid #e1f3d8;
    color: var(--color-success, #67c23a);
  }

  .vmsg-warning {
    background-color: #fdf6ec;
    border: 1px solid #faecd8;
    color: #e6a23c;
  }

  .vmsg-error {
    background-color: #fef0f0;
    border: 1px solid #fde2e2;
    color: #f56c6c;
  }

  .vmsg-info {
    background-color: #edf2fc;
    border: 1px solid #ebeef5;
    color: #409eff;
  }

  .vmsg-overlay {
    position: fixed;
    inset: 0;
    background-color: rgba(0, 0, 0, 0.5);
    z-index: 10000;
    display: flex;
    justify-content: center;
    align-items: center;
    opacity: 0;
    transition: opacity 0.3s ease;
  }

  .vmsg-overlay.show {
    opacity: 1;
  }

  .vmsg-dialog {
    background: white;
    border-radius: 8px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.15);
    min-width: min(400px, calc(100vw - 32px));
    max-width: min(500px, calc(100vw - 32px));
    transform: scale(0.8);
    transition: transform 0.3s ease;
  }

  .vmsg-overlay.show .vmsg-dialog {
    transform: scale(1);
  }

  .vmsg-header {
    padding: 20px 20px 10px;
    display: flex;
    justify-content: space-between;
    align-items: center;
    border-bottom: 1px solid #eee;
  }

  .vmsg-title {
    font-size: 18px;
    font-weight: 500;
    margin: 0;
  }

  .vmsg-close-btn {
    cursor: pointer;
    font-size: 20px;
    color: #999;
    border: none;
    background: none;
    padding: 0;
    width: 20px;
    height: 20px;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .vmsg-close-btn:hover {
    color: #666;
  }

  .vmsg-body {
    padding: 20px;
  }

  .vmsg-prompt-content {
    margin-bottom: 20px;
    font-size: 14px;
    line-height: 1.5;
    color: #333;
  }

  .vmsg-input {
    width: 100%;
    padding: 10px 12px;
    border: 1px solid #dcdfe6;
    border-radius: 4px;
    font-size: 14px;
    box-sizing: border-box;
    transition: border-color 0.2s;
  }

  .vmsg-input:focus {
    outline: none;
    border-color: #409eff;
  }

  .vmsg-footer {
    padding: 15px 20px;
    text-align: right;
    border-top: 1px solid #eee;
  }

  .vmsg-btn {
    padding: 8px 16px;
    border: 1px solid #dcdfe6;
    border-radius: 4px;
    font-size: 14px;
    cursor: pointer;
    margin-left: 10px;
    transition: all 0.2s;
  }

  .vmsg-btn-cancel {
    background: white;
    color: #606266;
  }

  .vmsg-btn-cancel:hover {
    background: #f5f7fa;
    border-color: #c0c4cc;
  }

  .vmsg-btn-confirm {
    background: #409eff;
    color: white;
    border-color: #409eff;
  }

  .vmsg-btn-confirm:hover {
    background: #66b1ff;
    border-color: #66b1ff;
  }
`

class MessageRuntime {
  constructor() {
    this.container = null
    this.messageTimers = new WeakMap()
  }

  ensureReady() {
    if (typeof document === 'undefined') {
      return false
    }
    if (!document.head || !document.body) {
      return false
    }
    this.ensureStyle()
    this.ensureContainer()
    return true
  }

  ensureStyle() {
    if (document.getElementById(MESSAGE_STYLE_ID)) {
      return
    }
    const style = document.createElement('style')
    style.id = MESSAGE_STYLE_ID
    style.textContent = MESSAGE_STYLE
    document.head.appendChild(style)
  }

  ensureContainer() {
    if (this.container?.isConnected) {
      return this.container
    }
    this.container = document.createElement('div')
    this.container.className = 'vmsg-container'
    document.body.appendChild(this.container)
    return this.container
  }

  queue(task) {
    if (this.ensureReady()) {
      return task()
    }
    const run = () => {
      window.removeEventListener('DOMContentLoaded', run)
      task()
    }
    window.addEventListener('DOMContentLoaded', run, { once: true })
    return null
  }

  schedule(callback, delay) {
    return window.setTimeout(callback, delay)
  }

  trackTimers(node, ids) {
    if (!node || ids.length === 0) {
      return
    }
    this.messageTimers.set(node, ids)
  }

  clearTimers(node) {
    const timers = this.messageTimers.get(node)
    if (!timers) {
      return
    }
    timers.forEach((id) => window.clearTimeout(id))
    this.messageTimers.delete(node)
  }
}

class Message {
  constructor(runtime = new MessageRuntime()) {
    this.runtime = runtime
  }

  createMessage(type, content, options = {}) {
    return this.runtime.queue(() => {
      const {
        duration = 3000,
        showClose = true,
        onClose = null,
      } = options
      const container = this.runtime.ensureContainer()
      const messageItem = document.createElement('div')
      messageItem.className = `vmsg-item vmsg-${type}`

      const icons = {
        success: '✓',
        warning: '⚠',
        error: '✕',
        info: 'ℹ',
      }

      const icon = document.createElement('span')
      icon.className = 'vmsg-icon'
      icon.textContent = icons[type] || icons.info

      const contentEl = document.createElement('div')
      contentEl.className = 'vmsg-content'
      contentEl.textContent = content

      messageItem.appendChild(icon)
      messageItem.appendChild(contentEl)

      let closed = false
      const close = () => {
        if (closed) {
          return
        }
        closed = true
        this.removeMessage(messageItem)
        if (typeof onClose === 'function') {
          onClose()
        }
      }

      if (showClose) {
        const closeBtn = document.createElement('span')
        closeBtn.className = 'vmsg-close'
        closeBtn.innerHTML = '&times;'
        closeBtn.addEventListener('click', close)
        messageItem.appendChild(closeBtn)
      }

      container.appendChild(messageItem)

      const showTimer = this.runtime.schedule(() => {
        messageItem.classList.add('show')
      }, 10)
      const timers = [showTimer]
      if (duration > 0) {
        timers.push(this.runtime.schedule(close, duration))
      }
      this.runtime.trackTimers(messageItem, timers)
      return messageItem
    })
  }

  removeMessage(messageItem) {
    if (!messageItem || !messageItem.parentNode) {
      return
    }
    this.runtime.clearTimers(messageItem)
    messageItem.classList.remove('show')
    const removeTimer = this.runtime.schedule(() => {
      if (messageItem.parentNode) {
        messageItem.parentNode.removeChild(messageItem)
      }
    }, 300)
    this.runtime.trackTimers(messageItem, [removeTimer])
  }

  success(content, options = {}) {
    return this.createMessage('success', content, options)
  }

  warning(content, options = {}) {
    return this.createMessage('warning', content, options)
  }

  error(content, options = {}) {
    return this.createMessage('error', content, options)
  }

  info(content, options = {}) {
    return this.createMessage('info', content, options)
  }

  _prompt(content, options = {}) {
    return new Promise((resolve, reject) => {
      this.runtime.queue(() => {
        const {
          title = '提示',
          type = 'confirm',
          inputValue = '',
          confirmText = '确定',
          cancelText = '取消',
          onConfirm = null,
          onCancel = null,
        } = options

        const overlay = document.createElement('div')
        overlay.className = 'vmsg-overlay'

        const dialog = document.createElement('div')
        dialog.className = 'vmsg-dialog'

        const header = document.createElement('div')
        header.className = 'vmsg-header'

        const titleEl = document.createElement('h3')
        titleEl.className = 'vmsg-title'
        titleEl.textContent = title

        const closeBtn = document.createElement('button')
        closeBtn.className = 'vmsg-close-btn'
        closeBtn.innerHTML = '&times;'

        header.appendChild(titleEl)
        header.appendChild(closeBtn)

        const body = document.createElement('div')
        body.className = 'vmsg-body'

        const contentEl = document.createElement('div')
        contentEl.className = 'vmsg-prompt-content'
        contentEl.textContent = content
        body.appendChild(contentEl)

        let inputEl = null
        if (type === 'input') {
          inputEl = document.createElement('input')
          inputEl.className = 'vmsg-input'
          inputEl.type = 'text'
          inputEl.value = inputValue
          body.appendChild(inputEl)
        }

        const footer = document.createElement('div')
        footer.className = 'vmsg-footer'

        const cancelBtn = document.createElement('button')
        cancelBtn.className = 'vmsg-btn vmsg-btn-cancel'
        cancelBtn.textContent = cancelText

        const confirmBtn = document.createElement('button')
        confirmBtn.className = 'vmsg-btn vmsg-btn-confirm'
        confirmBtn.textContent = confirmText

        footer.appendChild(cancelBtn)
        footer.appendChild(confirmBtn)

        dialog.appendChild(header)
        dialog.appendChild(body)
        dialog.appendChild(footer)
        overlay.appendChild(dialog)
        document.body.appendChild(overlay)

        const cleanup = []
        let settled = false

        const finalize = (callback) => {
          if (settled) {
            return
          }
          settled = true
          overlay.classList.remove('show')
          cleanup.splice(0).forEach((fn) => fn())
          window.setTimeout(() => {
            overlay.remove()
            callback()
          }, 300)
        }

        const cancel = () => {
          finalize(() => {
            if (typeof onCancel === 'function') {
              onCancel()
            }
            reject(new Error('cancelled'))
          })
        }

        const confirm = () => {
          const value = inputEl ? inputEl.value : true
          finalize(() => {
            resolve(value)
            if (typeof onConfirm === 'function') {
              onConfirm(value)
            }
          })
        }

        const escHandler = (event) => {
          if (event.key === 'Escape') {
            cancel()
          }
        }

        document.addEventListener('keydown', escHandler)
        cleanup.push(() => document.removeEventListener('keydown', escHandler))

        closeBtn.addEventListener('click', cancel)
        cancelBtn.addEventListener('click', cancel)
        confirmBtn.addEventListener('click', confirm)
        overlay.addEventListener('click', (event) => {
          if (event.target === overlay) {
            cancel()
          }
        })

        const showTimer = this.runtime.schedule(() => {
          overlay.classList.add('show')
        }, 10)
        cleanup.push(() => window.clearTimeout(showTimer))

        if (inputEl) {
          const focusTimer = this.runtime.schedule(() => {
            inputEl.focus()
            inputEl.select()
          }, 300)
          cleanup.push(() => window.clearTimeout(focusTimer))
        }
      })
    })
  }

  confirm(content, options = {}) {
    return this._prompt(content, {
      ...options,
      type: 'confirm',
    })
  }

  prompt(message, content, options = {}) {
    return this._prompt(message, {
      ...options,
      type: 'input',
      inputValue: content,
    })
  }
}

const message = new Message()

export default message
export { Message, MessageRuntime }
