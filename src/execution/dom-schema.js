export const htmlElements = new Set(
  'div span p br hr b i u s em strong small sub sup mark label a button input textarea select option optgroup ul ol li dl dt dd table thead tbody tfoot tr th td caption colgroup col section article header footer main nav aside h1 h2 h3 h4 h5 h6 pre code blockquote figure figcaption picture canvas img audio video source track progress meter details summary fieldset legend form datalist output time abbr address cite q samp kbd var wbr'.split(
    ' '
  )
)
export const templateElements = new Set(
  'html head body title script style link template vrouter vslot'.split(' ')
)
export const templateAttributes = new Set(
  'ref vsrc routes prefix params vref vrefof vslot vbind vslot-inherit'.split(
    ' '
  )
)

// The same explicit surface defines host dispatch and guest descriptors.
export const domSchema = {
  read: 'nodeType nodeName tagName localName namespaceURI textContent nodeValue id className title value checked disabled selected type width height clientWidth clientHeight clientLeft clientTop offsetWidth offsetHeight offsetLeft offsetTop scrollWidth scrollHeight scrollTop scrollLeft naturalWidth naturalHeight complete isConnected'.split(
    ' '
  ),
  write:
    'textContent nodeValue id className title value checked disabled selected type width height scrollTop scrollLeft'.split(
      ' '
    ),
  relatives:
    'parentNode parentElement firstChild lastChild firstElementChild lastElementChild nextSibling previousSibling nextElementSibling previousElementSibling'.split(
      ' '
    ),
  canvasProperties:
    'fillStyle strokeStyle lineWidth lineCap lineJoin miterLimit lineDashOffset shadowBlur shadowColor shadowOffsetX shadowOffsetY globalAlpha globalCompositeOperation font textAlign textBaseline direction imageSmoothingEnabled imageSmoothingQuality filter fontKerning fontStretch fontVariantCaps letterSpacing wordSpacing textRendering'.split(
      ' '
    ),
  canvasMethods:
    'save restore reset beginPath closePath moveTo lineTo bezierCurveTo quadraticCurveTo arc arcTo ellipse rect roundRect fill stroke clip clearRect fillRect strokeRect fillText strokeText translate rotate scale transform setTransform resetTransform setLineDash getLineDash measureText isPointInPath isPointInStroke createLinearGradient createRadialGradient createConicGradient createPattern drawImage'.split(
      ' '
    ),
}
