import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { parse } from 'acorn'
import { full } from 'acorn-walk'

const root = new URL('../', import.meta.url)

// Follow native ESM resolution, including the literal dynamic imports that
// load the sandbox and WASM. Node imports alone would silently resolve npm
// specifiers that a browser cannot load.
for (const sourceMode of [false, true]) {
  test(`browser module graph resolves without an import map (${sourceMode ? 'source' : 'dist'})`, () => {
    const seen = new Set()
    function visit(url) {
      if (seen.has(url.href)) return
      seen.add(url.href)
      const name = url.pathname.slice('/nested/vhtml/'.length)
      const built = new URL(`dist/${name}`, root)
      const file = sourceMode && name === 'vhtml.min.js'
        ? new URL('src/index.js', root)
        : existsSync(built) ? built : sourceMode ? new URL(`src/${name}`, root) : built
      assert(existsSync(file), `Missing browser module: ${url.href}`)
      const ast = parse(readFileSync(file, 'utf8'), { ecmaVersion: 'latest', sourceType: 'module' })
      full(ast, node => {
        if (!['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration', 'ImportExpression'].includes(node.type)) return
        if (node.source?.type !== 'Literal') return
        const specifier = node.source.value
        assert.match(specifier, /^(\.\.?\/|\/)/, `Bare or external dependency in ${url.href}: ${specifier}`)
        const dependency = new URL(specifier, url)
        assert(dependency.pathname.startsWith('/nested/vhtml/'), `Dependency escaped runtime mount: ${dependency.href}`)
        visit(dependency)
      })
    }
    visit(new URL('http://localhost/nested/vhtml/vhtml.min.js'))
    assert([...seen].some(url => url.includes('emscripten-module')), 'WASM lazy loader must be covered')
    if (sourceMode) assert(seen.has('http://localhost/nested/vhtml/vendor/acorn.js'))
  })
}
