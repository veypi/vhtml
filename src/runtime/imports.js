import { getModulePath } from './context.js'

function resolvePath(relativePath, currentPath) {
  if (relativePath.startsWith('/')) {
    return relativePath
  }
  const currentDir = currentPath.substring(0, currentPath.lastIndexOf('/'))
  const currentSegments = currentDir.split('/').filter((segment) => segment !== '')
  const relativeSegments = relativePath.split('/').filter((segment) => segment !== '')

  for (const segment of relativeSegments) {
    if (segment === '..') {
      if (currentSegments.length > 0) {
        currentSegments.pop()
      }
      continue
    }
    if (segment !== '.') {
      currentSegments.push(segment)
    }
  }
  return `/${currentSegments.join('/')}`
}

function normalizeSourcePath(src = '', scoped = '') {
  if (!src) {
    return scoped || '/'
  }
  if (src.startsWith('http') || !scoped || src.startsWith(scoped)) {
    return src
  }
  return `${scoped}${src}`
}

function toAbsoluteModuleUrl(url, scoped, src) {
  if (url.startsWith('@')) {
    url = url.slice(1)
  } else if (!url.startsWith('http')) {
    if (url.startsWith('/')) {
      url = scoped ? `${scoped}${url}` : url
    } else {
      url = resolvePath(url, src)
    }
  }
  if (!url.endsWith('.js')) {
    url += '.js'
  }
  if (!url.startsWith('http')) {
    url = `${window.location.origin}${url}`
  }
  return url
}

function parseImportBindings(bindingCode, rawStatement) {
  const binding = bindingCode.trim()
  if (/^\w+$/.test(binding)) {
    return binding
  }
  if (/^{[\w\s,]+}$/.test(binding)) {
    return binding.slice(1, -1).split(',').map((item) => item.trim()).filter(Boolean)
  }
  throw new Error(`unsupported import: ${rawStatement}`)
}

async function injectImportedModule(binding, module, target) {
  if (typeof binding === 'string') {
    target[binding] = module.default ?? module
    return
  }
  const defaultModule = module.default || {}
  binding.forEach((name) => {
    if (name in module) {
      target[name] = module[name]
    } else if (name in defaultModule) {
      target[name] = defaultModule[name]
    }
  })
}

export async function parseImports(code, data = {}, runtime = {}, src = '') {
  const scoped = getModulePath(runtime)
  const normalizedSrc = normalizeSourcePath(src, scoped)
  let codeCopy = code
  let match

  const awaitImportRegex = /await import\(['"]([^'"]+)['"]\)/gm
  while ((match = awaitImportRegex.exec(code)) !== null) {
    let url = match[1]
    if (!url.startsWith('http')) {
      url = resolvePath(url, normalizedSrc)
      url = `${window.location.origin}${url}`
    }
    codeCopy = codeCopy.replace(match[0], `await import('${url}')`)
  }

  const importRegex = /^[\s/]*import\s+([\w{},\s]+)\s+from\s+['"]([^'"]+)['"][;\s]*$/gm
  while ((match = importRegex.exec(code)) !== null) {
    codeCopy = codeCopy.replace(match[0], '')
    if (match[0].trim().startsWith('//')) {
      continue
    }
    try {
      const moduleUrl = toAbsoluteModuleUrl(match[2], scoped, normalizedSrc)
      const binding = parseImportBindings(match[1], match[0])
      const module = await import(moduleUrl)
      await injectImportedModule(binding, module, data)
    } catch (error) {
      console.error(`模块加载失败 (${match[0]}):`, error.message)
    }
  }
  return codeCopy.trim()
}

export default { parseImports }
