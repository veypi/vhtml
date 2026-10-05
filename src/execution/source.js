import { parse, parseExpressionAt } from 'acorn'
import { full } from 'acorn-walk'

const syntax = {
  ecmaVersion: 'latest',
  sourceType: 'module',
  allowAwaitOutsideFunction: true,
  allowReturnOutsideFunction: true,
}
const sources = new Map(),
  expressions = new Map()
function remember(cache, key, value) {
  if (cache.size >= 512) cache.delete(cache.keys().next().value)
  cache.set(key, value)
  return value
}

/** Parse code without executing it. Static dependencies and dynamic import use one loader. */
export function prepareSource(code, filename, { setup = false } = {}) {
  const key = JSON.stringify([code, filename, setup])
  if (sources.has(key)) return sources.get(key)
  const input = setup ? expressionBody(code) : code
  const ast = parse(input, syntax)
  const imports = []
  const dependencies = []
  const edits = []
  for (const node of ast.body) {
    if (node.type === 'ImportDeclaration') {
      dependencies.push(node.source.value)
      if (setup) {
        imports.push({
          source: node.source.value,
          bindings: node.specifiers.map((spec) => ({
            local: spec.local.name,
            imported:
              spec.type === 'ImportDefaultSpecifier'
                ? 'default'
                : spec.type === 'ImportNamespaceSpecifier'
                  ? '*'
                  : (spec.imported.name ?? spec.imported.value),
          })),
        })
        edits.push({ start: node.start, end: node.end, text: '' })
      }
    } else if (node.source && /^Export/.test(node.type)) {
      dependencies.push(node.source.value)
    }
  }
  full(ast, (node) => {
    if (node.type !== 'ImportExpression') return
    if (node.options)
      throw new SyntaxError('Import attributes are not supported')
    // Replace only the keyword and append the referrer. Nested expressions retain their own edits.
    edits.push({
      start: node.start,
      end: node.source.start,
      text: '__vhtmlImport(',
    })
    edits.push({
      start: node.source.end,
      end: node.end,
      text: `,${JSON.stringify(filename)})`,
    })
  })
  edits.sort((a, b) => b.start - a.start)
  let source = input
  for (const edit of edits)
    source = source.slice(0, edit.start) + edit.text + source.slice(edit.end)
  return remember(sources, key, { source, imports, dependencies })
}

export function expressionBody(code) {
  if (expressions.has(code)) return expressions.get(code)
  try {
    const node = parseExpressionAt(code, 0, { ...syntax, preserveParens: true })
    const tail = code.slice(node.end)
    // Parse the suffix instead of removing comments with a regular expression.
    if (
      parse(tail, syntax).body.every((node) => node.type === 'EmptyStatement')
    )
      return remember(
        expressions,
        code,
        `return (\n${code.slice(0, node.end)}\n)`
      )
  } catch (_) {}
  parse(code, syntax)
  return remember(expressions, code, code)
}

// Writable bindings are static property paths. No code is executed to infer a target.
export function parseAccessChain(code) {
  try {
    let node = parseExpressionAt(code, 0, syntax)
    if (code.slice(node.end).trim()) return null
    const chain = []
    while (node.type === 'MemberExpression' && !node.optional) {
      const key = node.computed
        ? node.property.type === 'Literal'
          ? node.property.value
          : null
        : node.property.name
      if (!['string', 'number'].includes(typeof key) || key === '__proto__')
        return null
      chain.unshift(key)
      node = node.object
    }
    if (
      node.type !== 'Identifier' ||
      ['__proto__', 'undefined', 'NaN', 'Infinity'].includes(node.name)
    )
      return null
    return [node.name, ...chain]
  } catch (_) {
    return null
  }
}
