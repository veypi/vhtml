import { isRouterNavigableHref } from './url.js'

export class NavigationRuntime {
  #listeners = new Set()
  #loaded = false
  #handleBodyClick = null
  #handlePopstate = null

  onChange(listener) {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  notify(payload) {
    for (const listener of this.#listeners) {
      listener(payload)
    }
  }

  init() {
    if (this.#loaded) {
      return
    }
    this.#loaded = true
    this.#handleBodyClick = (event) => {
      const linkElement = event.target.closest('a')
      if (!linkElement) {
        return
      }
      const href = linkElement.getAttribute('href')
      if (!isRouterNavigableHref(href)) {
        return
      }
      event.preventDefault()
      if (linkElement.hasAttribute('reload')) {
        window.location.href = href
      } else {
        this.push(href)
      }
    }
    this.#handlePopstate = () => {
      this.notify({ type: 'popstate', url: window.location.href })
    }
    document.body.addEventListener('click', this.#handleBodyClick, true)
    window.addEventListener('popstate', this.#handlePopstate)
  }

  push(to) {
    this.notify({ type: 'push', to })
  }

  replace(to) {
    this.notify({ type: 'replace', to })
  }

  go(n) {
    history.go(n)
  }

  back() {
    history.back()
  }

  forward() {
    history.forward()
  }
}

export default NavigationRuntime
