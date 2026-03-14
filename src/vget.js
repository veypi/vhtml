/*
 * vget.js
 * Copyright (C) 2024 veypi <i@veypi.com>
 *
 * Distributed under terms of the MIT license.
 */
import templateLoader from './runtime/loader.js'
import moduleEnvManager from './runtime/env.js'

const vget = {
  FetchUI(url, env, ignoreScoped) {
    return templateLoader.fetchUI(url, env, ignoreScoped)
  },
  FetchFile(url) {
    return templateLoader.fetchFile(url)
  },
  LoadScript(dom, env) {
    return templateLoader.resourceLoader.loadScript(dom, env)
  },
  LoadLink(dom, env) {
    return templateLoader.resourceLoader.loadLink(dom, env)
  },
  ParseUI(text, env, url, ignoreScoped) {
    return templateLoader.parseUI(text, env, url, ignoreScoped)
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
