/*
 * vget.js
 * Copyright (C) 2024 veypi <i@veypi.com>
 *
 * Distributed under terms of the MIT license.
 */
import templateLoader from './runtime/loader.js'

const vget = {
  FetchUI(url, runtime, ignoreScoped) {
    return templateLoader.fetchUI(url, runtime, ignoreScoped)
  },
  FetchFile(url) {
    return templateLoader.fetchFile(url)
  },
  LoadScript(dom, runtime) {
    return templateLoader.resourceLoader.loadScript(dom, runtime)
  },
  LoadLink(dom, runtime) {
    return templateLoader.resourceLoader.loadLink(dom, runtime)
  },
  ParseUI(text, runtime, url, ignoreScoped) {
    return templateLoader.parseUI(text, runtime, url, ignoreScoped)
  },
  getInstance() {
    return templateLoader
  },
  clearCache() {
    return templateLoader.clear()
  },
  addWrapper(wrapper) {
    return templateLoader.addWrapper(wrapper)
  },
}

export default vget
