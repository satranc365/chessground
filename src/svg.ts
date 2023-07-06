import { State } from './state.js';
import { key2pos } from './util.js';
import { Drawable, DrawShape, DrawShapePiece, DrawBrush, DrawBrushes, DrawModifiers } from './draw.js';
import { SyncableShape, Hash, syncShapes } from './sync.js';
import * as cg from './types.js';

export function createElement(tagName: string): SVGElement {
  return document.createElementNS('http://www.w3.org/2000/svg', tagName);
}

type CustomBrushes = Map<string, DrawBrush>; // by hash

type ArrowDests = Map<cg.Key, number>; // how many arrows land on a square

export function renderSvg(state: State, svg: SVGElement, customSvg: SVGElement): void {
  const d = state.drawable,
    curD = d.current,
    cur = curD && curD.mouseSq ? (curD as DrawShape) : undefined,
    arrowDests: ArrowDests = new Map(),
    bounds = state.dom.bounds(),
    nonPieceAutoShapes = d.autoShapes.filter(autoShape => !autoShape.piece);

  for (const s of d.shapes.concat(nonPieceAutoShapes).concat(cur ? [cur] : [])) {
    if (s.dest) arrowDests.set(s.dest, (arrowDests.get(s.dest) || 0) + 1);
  }

  const shapes: SyncableShape[] = d.shapes.concat(nonPieceAutoShapes).map((s: DrawShape) => {
    return {
      shape: s,
      current: false,
      hash: shapeHash(s, arrowDests, false, bounds),
    };
  });
  if (cur)
    shapes.push({
      shape: cur,
      current: true,
      hash: shapeHash(cur, arrowDests, true, bounds),
    });

  const fullHash = shapes.map(sc => sc.hash).join(';');
  if (fullHash === state.drawable.prevSvgHash) return;
  state.drawable.prevSvgHash = fullHash;

  /*
    -- DOM hierarchy --
    <svg class="cg-shapes">      (<= svg)
      <defs>
        ...(for brushes)...
      </defs>
      <g>
        ...(for arrows and circles)...
      </g>
    </svg>
    <svg class="cg-custom-svgs"> (<= customSvg)
      <g>
        ...(for custom svgs)...
      </g>
    </svg>
  */

  const defsEl = svg.querySelector('defs') as SVGElement;
  const shapesEl = svg.querySelector('g') as SVGElement;
  const customSvgsEl = customSvg.querySelector('g') as SVGElement;

  syncDefs(d, shapes, defsEl);
  syncShapes(
    shapes.filter(s => !s.shape.customSvg),
    shapesEl,
    shape => renderShape(state, shape, d.brushes, arrowDests, bounds)
  );
  syncShapes(
    shapes.filter(s => s.shape.customSvg),
    customSvgsEl,
    shape => renderShape(state, shape, d.brushes, arrowDests, bounds)
  );
}

// append only. Don't try to update/remove.
function syncDefs(d: Drawable, shapes: SyncableShape[], defsEl: SVGElement) {
  const brushes: CustomBrushes = new Map();
  let brush: DrawBrush;
  for (const s of shapes) {
    if (s.shape.dest) {
      brush = d.brushes[s.shape.brush];
      if (s.shape.modifiers) brush = makeCustomBrush(brush, s.shape.modifiers);
      if (s.shape.modifiers?.hilite) brushes.set('hilite', { key: 'hilite', color: 'white', opacity: 1, lineWidth: 1 });
      brushes.set(brush.key, brush);
    }
  }
  const keysInDom = new Set();
  let el: SVGElement | undefined = defsEl.firstChild as SVGElement;
  while (el) {
    keysInDom.add(el.getAttribute('cgKey'));
    el = el.nextSibling as SVGElement | undefined;
  }
  for (const [key, brush] of brushes.entries()) {
    if (!keysInDom.has(key)) {
      defsEl.appendChild(renderMarker(brush));
      defsEl.appendChild(renderLinearOpacityGradient(brush));
    }
  }
}

function shapeHash(
  { orig, dest, brush, piece, modifiers, customSvg }: DrawShape,
  arrowDests: ArrowDests,
  current: boolean,
  bounds: DOMRectReadOnly
): Hash {
  return [
    bounds.width,
    bounds.height,
    current,
    orig,
    dest,
    brush,
    dest && (arrowDests.get(dest) || 0) > 1,
    piece && pieceHash(piece),
    modifiers && modifiersHash(modifiers),
    customSvg && customSvgHash(customSvg),
  ]
    .filter(x => x)
    .join(',');
}

function pieceHash(piece: DrawShapePiece): Hash {
  return [piece.color, piece.role, piece.scale].filter(x => x).join(',');
}

function modifiersHash(m: DrawModifiers): Hash {
  return [m.lineWidth, m.hilite].filter(x => x).join(',');
}

function customSvgHash(s: string): Hash {
  // Rolling hash with base 31 (cf. https://stackoverflow.com/questions/7616461/generate-a-hash-from-string-in-javascript)
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) >>> 0;
  }
  return 'custom-' + h.toString();
}

function renderShape(
  state: State,
  { shape, current, hash }: SyncableShape,
  brushes: DrawBrushes,
  arrowDests: ArrowDests,
  bounds: DOMRectReadOnly
): SVGElement {
  let el: SVGElement;
  const orig = orient(key2pos(shape.orig), state.orientation);

  if (shape.customSvg) {
    el = renderCustomSvg(shape.customSvg, orig, bounds);
  } else {
    if (shape.dest && shape.dest !== shape.orig) {
      let brush: DrawBrush = brushes[shape.brush];
      if (shape.modifiers) brush = makeCustomBrush(brush, shape.modifiers);
      el = renderRectangleArrow(
        brush,
        orig,
        orient(key2pos(shape.dest), state.orientation),
        current,
        (arrowDests.get(shape.dest) || 0) > 1,
        bounds,
        shape.modifiers?.hilite
      );
    } else el = renderSquare(brushes[shape.brush], orig, current, bounds);
  }
  el.setAttribute('cgHash', hash);
  return el;
}

function renderCustomSvg(customSvg: string, pos: cg.Pos, bounds: DOMRectReadOnly): SVGElement {
  const [x, y] = pos2user(pos, bounds);

  // Translate to top-left of `orig` square
  const g = setAttributes(createElement('g'), { transform: `translate(${x},${y})` });

  // Give 100x100 coordinate system to the user for `orig` square
  const svg = setAttributes(createElement('svg'), { width: 1, height: 1, viewBox: '0 0 100 100' });

  g.appendChild(svg);
  svg.innerHTML = customSvg;
  return g;
}

function renderSquare(brush: DrawBrush, pos: cg.Pos, current: boolean, bounds: DOMRectReadOnly): SVGElement {
  const o = pos2user(pos, bounds);
  return setAttributes(createElement('rect'), {
    stroke: brush.color,
    'stroke-width': 4 / 64,
    'clip-path': 'inset(0)',
    fill: 'none',
    opacity: opacity(brush, current),
    width: 1,
    height: 1,
    x: o[0] - 0.5,
    y: o[1] - 0.5,
  });
}

/*
 * Repo arrows
 *

function renderArrow(
  brush: DrawBrush,
  orig: cg.Pos,
  dest: cg.Pos,
  current: boolean,
  shorten: boolean,
  bounds: DOMRectReadOnly,
  hilited = false
): SVGElement {
  function renderInner(isHilite: boolean) {
    const m = arrowMargin(shorten && !current),
      a = pos2user(orig, bounds),
      b = pos2user(dest, bounds),
      dx = b[0] - a[0],
      dy = b[1] - a[1],
      angle = Math.atan2(dy, dx),
      xo = Math.cos(angle) * m,
      yo = Math.sin(angle) * m;
    return setAttributes(createElement('line'), {
      stroke: isHilite ? 'white' : brush.color,
      'stroke-width': lineWidth(brush, current) + (isHilite ? 0.04 : 0),
      'stroke-linecap': 'round',
      'marker-end': `url(#arrowhead-${isHilite ? 'hilite' : brush.key})`,
      opacity: isHilite ? 1 : opacity(brush, current),
      x1: a[0],
      y1: a[1],
      x2: b[0] - xo,
      y2: b[1] - yo,
    });
  }
  const el = hilited ? createElement('g') : renderInner(false);
  if (hilited) [true, false].map(h => el.appendChild(renderInner(h)));
  return el;
}

function renderMarker(brush: DrawBrush): SVGElement {
  const marker = setAttributes(createElement('marker'), {
    id: 'arrowhead-' + brush.key,
    orient: 'auto',
    markerWidth: 4,
    markerHeight: 8,
    refX: brush.key === 'hilite' ? 1.86 : 2.05,
    refY: 2,
  });
  marker.appendChild(
    setAttributes(createElement('path'), {
      d: 'M0,0 V4 L3,2 Z',
      fill: brush.color,
    })
  );
  marker.setAttribute('cgKey', brush.key);
  return marker;
}

*/

/*
 * New arrows
 */

function renderRectangleArrow(
  brush: DrawBrush,
  orig: cg.Pos,
  dest: cg.Pos,
  current: boolean,
  shorten: boolean,
  bounds: DOMRectReadOnly,
  hilited = false
): SVGElement {
  function renderInner(isHilite: boolean) {
    const m = arrowMargin(shorten && !current),
      a = pos2user(orig, bounds),
      b = pos2user(dest, bounds),
      dx = b[0] - a[0],
      dy = b[1] - a[1],
      angle = Math.atan2(dy, dx),
      xo = Math.cos(angle) * m,
      yo = Math.sin(angle) * m,
      height = lineWidth(brush, current) / 3 + (isHilite ? 0.04 : 0),
      width = Math.sqrt(dx * dx + dy * dy) - m;

    const group = setAttributes(createElement('g'), {});
    const arrowRect = setAttributes(createElement('rect'), {
      stroke: 'none',
      'stroke-linejoin': 'round',
      mask: 'url(#markerLinearOpacityGradientMask)',
      fill: isHilite ? 'white' : `url(#linearOpacityGradient-${brush.key})`,
      opacity: isHilite ? 1 : opacity(brush, current),
      height: height,
      width: width,
      x: a[0],
      y: a[1] - height / 2,
      transform: `rotate(${(angle * 180) / Math.PI} ${a[0]} ${a[1]})`,
    });
    const arrowLine = setAttributes(createElement('line'), {
      // stroke="transparent" stroke-width="10" stroke-linecap="round" marker-end="url(#arrow)" opacity="1" x1="30" y1="305" x2="300" y2="305" cgHash="592,592,d7,c6,green"
      stroke: 'transparent',
      'stroke-width': height,
      'stroke-linecap': 'round',
      'marker-end': `url(#arrowhead-${isHilite ? 'hilite' : brush.key})`,
      opacity: isHilite ? 1 : opacity(brush, current),
      x1: a[0],
      y1: a[1],
      x2: b[0] - xo,
      y2: b[1] - yo,
    });

    group.appendChild(arrowRect);
    group.appendChild(arrowLine);

    return group;
  }
  const el = hilited ? createElement('g') : renderInner(false);
  if (hilited) [true, false].map(h => el.appendChild(renderInner(h)));
  return el;
}

function renderMarker(brush: DrawBrush): SVGElement {
  const marker = setAttributes(createElement('marker'), {
    id: 'arrowhead-' + brush.key,
    orient: 'auto',
    markerWidth: 4.8,
    markerHeight: 8,
    refX: brush.key === 'hilite' ? 3.86 : 4,
    refY: 4,
  });
  marker.appendChild(
    setAttributes(createElement('path'), {
      d: 'M0.5,0.5 L3.7,4 L0.5,7.5',
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      stroke: brush.color,
      fill: 'none',
    })
  );
  marker.setAttribute('cgKey', brush.key);
  return marker;
}

function renderLinearOpacityGradient(brush: DrawBrush): SVGElement {
  const linearGradient = setAttributes(createElement('linearGradient'), {
    id: 'linearOpacityGradient-' + brush.key,
    x1: '0%',
    x2: '100%',
    y1: '0%',
    y2: '0%',
  });
  const stop1 = setAttributes(createElement('stop'), {
    offset: '0%',
    'stop-color': brush.color,
    'stop-opacity': 0,
  });
  const stop2 = setAttributes(createElement('stop'), {
    offset: '100%',
    'stop-color': brush.color,
    'stop-opacity': 1,
  });

  linearGradient.appendChild(stop1);
  linearGradient.appendChild(stop2);

  return linearGradient;
}

/* */

export function setAttributes(el: SVGElement, attrs: { [key: string]: any }): SVGElement {
  for (const key in attrs) {
    if (Object.prototype.hasOwnProperty.call(attrs, key)) el.setAttribute(key, attrs[key]);
  }
  return el;
}

function orient(pos: cg.Pos, color: cg.Color): cg.Pos {
  return color === 'white' ? pos : [7 - pos[0], 7 - pos[1]];
}

function makeCustomBrush(base: DrawBrush, modifiers: DrawModifiers): DrawBrush {
  return {
    color: base.color,
    opacity: Math.round(base.opacity * 10) / 10,
    lineWidth: Math.round(modifiers.lineWidth || base.lineWidth),
    key: [base.key, modifiers.lineWidth].filter(x => x).join(''),
  };
}

function lineWidth(brush: DrawBrush, current: boolean): number {
  return ((brush.lineWidth || 10) * (current ? 0.85 : 1)) / 64;
}

function opacity(brush: DrawBrush, current: boolean): number {
  return (brush.opacity || 1) * (current ? 0.9 : 1);
}

function arrowMargin(shorten: boolean): number {
  return (shorten ? 20 : 10) / 64;
}

function pos2user(pos: cg.Pos, bounds: DOMRectReadOnly): cg.NumberPair {
  const xScale = Math.min(1, bounds.width / bounds.height);
  const yScale = Math.min(1, bounds.height / bounds.width);
  return [(pos[0] - 3.5) * xScale, (3.5 - pos[1]) * yScale];
}
