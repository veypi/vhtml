import * as css from '../vendor/css-tree.js'

export const HTML_NS = 'http://www.w3.org/1999/xhtml'
export const SVG_NS = 'http://www.w3.org/2000/svg'
export const XLINK_NS = 'http://www.w3.org/1999/xlink'
export const XML_NS = 'http://www.w3.org/XML/1998/namespace'
export const XMLNS_NS = 'http://www.w3.org/2000/xmlns/'
// No scripting, embedded documents or SMIL mutations of URL attributes.
export const svgElements = new Set(
  'svg g defs symbol use path rect circle ellipse line polyline polygon text tspan textPath title desc image clipPath mask pattern linearGradient radialGradient stop marker filter feBlend feColorMatrix feComponentTransfer feComposite feConvolveMatrix feDiffuseLighting feDisplacementMap feDistantLight feDropShadow feFlood feFuncA feFuncB feFuncG feFuncR feGaussianBlur feMerge feMergeNode feMorphology feOffset fePointLight feSpecularLighting feSpotLight feTile feTurbulence'.split(
    ' '
  )
)
const names =
  'id class style xmlns xmlns:xlink xml:space x y x1 y1 x2 y2 dx dy z cx cy r rx ry d points width height viewBox preserveAspectRatio transform opacity fill fill-opacity fill-rule stroke stroke-width stroke-linecap stroke-linejoin stroke-miterlimit stroke-dasharray stroke-dashoffset stroke-opacity clip-path clip-rule mask filter marker-start marker-mid marker-end vector-effect paint-order color color-interpolation color-interpolation-filters visibility display pointer-events cursor font-family font-size font-weight font-style text-anchor dominant-baseline alignment-baseline text-decoration letter-spacing word-spacing textLength lengthAdjust rotate startOffset method spacing href xlink:href baseProfile version focusable tabindex role gradientUnits gradientTransform spreadMethod offset stop-color stop-opacity fx fy fr clipPathUnits maskUnits maskContentUnits patternUnits patternContentUnits patternTransform markerWidth markerHeight refX refY orient markerUnits filterUnits primitiveUnits in in2 result mode type values operator k1 k2 k3 k4 stdDeviation edgeMode kernelMatrix kernelUnitLength order divisor bias targetX targetY preserveAlpha scale xChannelSelector yChannelSelector surfaceScale diffuseConstant specularConstant specularExponent limitingConeAngle azimuth elevation pointsAtX pointsAtY pointsAtZ baseFrequency numOctaves seed stitchTiles flood-color flood-opacity lighting-color'.split(
    ' '
  )
export const svgAttributes = new Map(
  names.map((name) => [name.toLowerCase(), name])
)
export const svgPaintAttributes = new Set(
  'fill stroke clip-path mask filter marker-start marker-mid marker-end cursor'.split(
    ' '
  )
)

export function createSVGPolicy() {
  const prefix = `vhtml-svg-${Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('')}-`
  const encode = (id) =>
    String(id).startsWith(prefix)
      ? String(id)
      : prefix +
        [...new TextEncoder().encode(String(id))]
          .map((byte) => byte.toString(16).padStart(2, '0'))
          .join('')
  const decode = (id) =>
    id.startsWith(prefix)
      ? new TextDecoder().decode(
          Uint8Array.from(id.slice(prefix.length).match(/../g) || [], (byte) =>
            parseInt(byte, 16)
          )
        )
      : id
  function fragment(value) {
    value = String(value).trim()
    if (!/^#[^\s]*$/.test(value))
      throw new Error('SVG references must stay inside this module')
    let id
    try {
      id = decodeURIComponent(value.slice(1))
    } catch (_) {
      throw new Error('Invalid SVG reference')
    }
    return '#' + encode(id)
  }
  return {
    id: encode,
    originalId: decode,
    fragment,
    attribute(name) {
      const normalized = svgAttributes.get(String(name).toLowerCase())
      if (normalized) return normalized
      if (/^(?:data-|aria-)[a-z0-9_-]+$/.test(name)) return name
      throw new Error(`SVG attribute ${name} is unavailable`)
    },
    value(name, value) {
      value = String(value)
      if (name === 'id') return encode(value)
      if (svgPaintAttributes.has(name)) {
        const ast = css.parse(value, { context: 'value' })
        css.walk(ast, (node) => {
          if (node.type === 'Raw')
            throw new Error('Unsupported SVG paint value')
          if (node.type === 'Url') node.value = fragment(node.value)
        })
        return css.generate(ast)
      }
      if (
        (name === 'xmlns' && value !== SVG_NS) ||
        (name === 'xmlns:xlink' && value !== XLINK_NS)
      )
        throw new Error('Unsupported SVG namespace')
      return value
    },
    selector(source) {
      if (!String(source).includes('#')) return String(source)
      const ast = css.parse(String(source), { context: 'selectorList' })
      css.walk(ast, {
        enter(node) {
          if (node.type !== 'IdSelector') return
          const original = css.generate(node)
          const replacement = css.parse(
            `:is(${original},#${encode(node.name)})`,
            { context: 'selector' }
          ).children.first
          Object.assign(node, replacement)
          return css.walk.skip
        },
      })
      return css.generate(ast)
    },
  }
}
