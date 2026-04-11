export interface MermaidHighlightTheme {
  background: string;
  activeBackground: string;
  color: string;
  underline: string;
  activeUnderline: string;
  ring: string;
}

const MERMAID_BASE_D_ATTR = 'data-mermaid-base-d';
const MERMAID_BASE_TRANSFORM_ATTR = 'data-mermaid-base-transform';
const MERMAID_BASE_VIEWBOX_ATTR = 'data-mermaid-base-view-box';
const MERMAID_MIN_RANK_GAP = 32;

interface TranslateTransform {
  x: number;
  y: number;
  suffix: string;
}

interface MermaidNodeLayoutInfo {
  bbox: DOMRect | SVGRect;
  el: SVGGElement;
  transform: TranslateTransform;
}

interface MermaidRankLayout {
  centerY: number;
  items: MermaidNodeLayoutInfo[];
  shift: number;
  top: number;
  bottom: number;
}

interface Point {
  x: number;
  y: number;
}

type MermaidNodeGeometry =
  | {
      center: Point;
      kind: 'rect';
      height: number;
      width: number;
    }
  | {
      center: Point;
      kind: 'circle';
      radius: number;
    }
  | {
      center: Point;
      kind: 'ellipse';
      rx: number;
      ry: number;
    }
  | {
      center: Point;
      kind: 'polygon';
      points: Point[];
    };

export function getMermaidHighlightTheme(rootStyles: CSSStyleDeclaration): MermaidHighlightTheme {
  return {
    background: rootStyles.getPropertyValue('--theme-comment-bg-opaque').trim(),
    activeBackground:
      rootStyles.getPropertyValue('--theme-comment-bg-hover-opaque').trim() ||
      rootStyles.getPropertyValue('--theme-comment-bg-opaque').trim(),
    color: rootStyles.getPropertyValue('--theme-text').trim(),
    underline: rootStyles.getPropertyValue('--theme-comment-underline').trim(),
    activeUnderline:
      rootStyles.getPropertyValue('--theme-comment-underline-active').trim() ||
      rootStyles.getPropertyValue('--theme-comment-underline').trim(),
    ring: rootStyles.getPropertyValue('--theme-comment-ring').trim(),
  };
}

export function applyMermaidHighlightStyles(
  el: HTMLElement,
  theme: MermaidHighlightTheme,
  active: boolean,
) {
  el.style.backgroundColor = active ? theme.activeBackground : theme.background;
  el.style.backgroundImage = 'none';
  el.style.color = theme.color;
  el.style.textDecoration = 'none';
  el.style.borderBottom = `2px solid ${active ? theme.activeUnderline : theme.underline}`;
  el.style.borderRadius = '2px';
  el.style.cursor = 'pointer';
  el.style.display = 'inline';
  el.style.lineHeight = 'inherit';
  el.style.padding = '0';
  el.style.transition = 'none';
  el.style.whiteSpace = 'pre-wrap';
  el.style.wordBreak = 'break-word';
  el.style.overflowWrap = 'break-word';
  el.style.maxWidth = '100%';
  el.style.outline = active ? `1px solid ${theme.ring}` : 'none';
  el.style.outlineOffset = '0';
  el.style.boxDecorationBreak = 'clone';
  el.style.setProperty('-webkit-box-decoration-break', 'clone');
}

const SVG_NS_HIGHLIGHT = 'http://www.w3.org/2000/svg';
const MERMAID_SVG_HIGHLIGHT_BG_CLASS = 'mermaid-svg-text-highlight-bg';

interface BBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Compute the bbox of characters [start, end) within an SVG text element
 *  using SVGTextContentElement APIs. Returns null if the range is invalid
 *  or the browser can't resolve character extents (e.g. offscreen). */
function getSvgCharRangeBBox(
  el: SVGElement,
  start: number,
  end: number,
): BBox | null {
  const text = el as unknown as SVGTextContentElement;
  if (typeof text.getNumberOfChars !== 'function') return null;
  let nChars: number;
  try {
    nChars = text.getNumberOfChars();
  } catch {
    return null;
  }
  const clampedStart = Math.max(0, Math.min(start, nChars));
  const clampedEnd = Math.max(clampedStart, Math.min(end, nChars));
  if (clampedEnd <= clampedStart) return null;

  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  try {
    for (let i = clampedStart; i < clampedEnd; i++) {
      const ext = text.getExtentOfChar(i);
      if (!Number.isFinite(ext.x) || !Number.isFinite(ext.width)) continue;
      x1 = Math.min(x1, ext.x);
      y1 = Math.min(y1, ext.y);
      x2 = Math.max(x2, ext.x + ext.width);
      y2 = Math.max(y2, ext.y + ext.height);
    }
  } catch {
    return null;
  }
  if (!Number.isFinite(x1) || !Number.isFinite(x2) || x2 <= x1) return null;
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

/** Style an SVG <text> element as commented and draw a highlight rect over
 *  a specific character range (or the whole element if no range is supplied).
 *
 *  SVG <text> can't contain HTML <mark> children, and it has no box model, so
 *  a "background highlight" is drawn as a sibling <rect> inserted immediately
 *  before the <text> element. The rect shares the text's coordinate space
 *  (same parent <g>) and is sized via getExtentOfChar for precision. */
export function applyMermaidSvgTextHighlight(
  el: SVGElement,
  theme: MermaidHighlightTheme,
  active: boolean,
  matchStart?: number,
  matchEnd?: number,
) {
  // Styles that live on the <text> element itself can only apply to the
  // whole element — they'd be inconsistent with the per-character highlight
  // rect when the anchor is a substring. Keep only click affordance here;
  // the visual highlight is entirely carried by the sibling <rect>.
  el.style.cursor = 'pointer';

  const parent = el.parentNode as SVGElement | null;
  if (!parent || !('getBBox' in el)) return;

  // Belt-and-suspenders: remove any stale highlight rect from a previous pass
  // in the same render (e.g. if the same text element is hit twice).
  const textId =
    el.getAttribute('data-mdr-highlight-id') || `mdr-hl-${Math.random().toString(36).slice(2)}`;
  el.setAttribute('data-mdr-highlight-id', textId);
  const stale = parent.querySelector(
    `rect.${MERMAID_SVG_HIGHLIGHT_BG_CLASS}[data-mdr-highlight-for="${textId}"]`,
  );
  if (stale) stale.remove();

  // Prefer a precise character-range bbox; fall back to the full element bbox
  // if range info isn't supplied or the API isn't available.
  let bbox: BBox | null = null;
  if (matchStart != null && matchEnd != null) {
    bbox = getSvgCharRangeBBox(el, matchStart, matchEnd);
  }
  if (!bbox) {
    try {
      const full = (el as unknown as SVGGraphicsElement).getBBox();
      bbox = { x: full.x, y: full.y, width: full.width, height: full.height };
    } catch {
      return;
    }
  }
  if (!bbox.width || !bbox.height) return;

  const padX = 3;
  const padY = 2;
  const rect = document.createElementNS(SVG_NS_HIGHLIGHT, 'rect');
  rect.classList.add(MERMAID_SVG_HIGHLIGHT_BG_CLASS);
  rect.setAttribute('data-mdr-highlight-for', textId);
  rect.setAttribute('x', String(bbox.x - padX));
  rect.setAttribute('y', String(bbox.y - padY));
  rect.setAttribute('width', String(bbox.width + padX * 2));
  rect.setAttribute('height', String(bbox.height + padY * 2));
  rect.setAttribute('rx', '2');
  rect.setAttribute('ry', '2');
  // The theme's opaque comment backgrounds assume a lighter prose page behind
  // them. Inside the mermaid SVG the diagram's own background can be just as
  // dark, which kills contrast. Use the theme's accent color with fill-opacity
  // so the highlight pops regardless of what's behind it.
  const accent = active ? theme.activeUnderline : theme.underline;
  rect.setAttribute('fill', accent);
  rect.setAttribute('fill-opacity', active ? '0.45' : '0.28');
  if (active) {
    rect.setAttribute('stroke', theme.ring || accent);
    rect.setAttribute('stroke-width', '1.5');
  }
  rect.setAttribute('pointer-events', 'none');
  parent.insertBefore(rect, el);
}

function getRenderedLabelHeight(contentRoot: HTMLElement) {
  const rootRect = contentRoot.getBoundingClientRect();
  let height = Math.max(rootRect.height, contentRoot.scrollHeight, contentRoot.offsetHeight);
  const rootTop = rootRect.top;

  for (const descendant of contentRoot.querySelectorAll('*')) {
    const rect = descendant.getBoundingClientRect();
    height = Math.max(height, rect.bottom - rootTop);
    if (descendant instanceof HTMLElement) {
      height = Math.max(height, descendant.scrollHeight, descendant.offsetHeight);
    }
  }

  return Math.ceil(height);
}

function applyWrappedLabelTextStyles(contentRoot: HTMLElement, width: number) {
  contentRoot.style.maxWidth = `${width}px`;
  contentRoot.style.width = `${width}px`;
  contentRoot.style.whiteSpace = 'pre-wrap';
  contentRoot.style.overflowWrap = 'break-word';
  contentRoot.style.wordBreak = 'break-word';

  const blockEls = contentRoot.querySelectorAll('p, span, div');
  for (const blockEl of blockEls) {
    const el = blockEl as HTMLElement;
    el.style.maxWidth = '100%';
    el.style.whiteSpace = 'pre-wrap';
    el.style.overflowWrap = 'break-word';
    el.style.wordBreak = 'break-word';
  }
}

function rememberBaseAttribute(el: Element, attribute: string, storageAttribute: string) {
  const stored = el.getAttribute(storageAttribute);
  if (stored != null) return stored;

  const current = el.getAttribute(attribute);
  if (current != null) {
    el.setAttribute(storageAttribute, current);
  }
  return current;
}

export function parseTranslateTransform(transform: string | null): TranslateTransform | null {
  if (!transform) return null;

  const match = transform.match(
    /^translate\(\s*([-+]?\d*\.?\d+(?:e[-+]?\d+)?)\s*(?:,|\s)\s*([-+]?\d*\.?\d+(?:e[-+]?\d+)?)\s*\)\s*(.*)$/i,
  );
  if (!match) return null;

  return {
    x: Number.parseFloat(match[1]),
    y: Number.parseFloat(match[2]),
    suffix: match[3]?.trim() ?? '',
  };
}

export function formatTranslateTransform(transform: TranslateTransform) {
  return `translate(${transform.x}, ${transform.y})${transform.suffix ? ` ${transform.suffix}` : ''}`;
}

function applyTranslate(point: Point, transform: TranslateTransform | null) {
  return {
    x: point.x + (transform?.x ?? 0),
    y: point.y + (transform?.y ?? 0),
  };
}

function distanceSquared(a: Point, b: Point) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

export function parsePolygonPoints(points: string | null) {
  if (!points) return [];

  return points
    .trim()
    .split(/\s+/)
    .map((pair) => pair.split(',').map((value) => Number.parseFloat(value)))
    .filter((pair) => pair.length === 2 && pair.every((value) => Number.isFinite(value)))
    .map(([x, y]) => ({ x, y }));
}

export function pointInPolygon(point: Point, polygon: Point[]) {
  let inside = false;

  for (
    let index = 0, prevIndex = polygon.length - 1;
    index < polygon.length;
    prevIndex = index, index += 1
  ) {
    const current = polygon[index];
    const previous = polygon[prevIndex];
    const intersects =
      current.y > point.y !== previous.y > point.y &&
      point.x <
        ((previous.x - current.x) * (point.y - current.y)) / (previous.y - current.y) + current.x;
    if (intersects) {
      inside = !inside;
    }
  }

  return inside;
}

function pointInsideGeometry(geometry: MermaidNodeGeometry, point: Point) {
  switch (geometry.kind) {
    case 'rect':
      return (
        point.x >= geometry.center.x - geometry.width / 2 &&
        point.x <= geometry.center.x + geometry.width / 2 &&
        point.y >= geometry.center.y - geometry.height / 2 &&
        point.y <= geometry.center.y + geometry.height / 2
      );
    case 'circle':
      return distanceSquared(point, geometry.center) <= geometry.radius * geometry.radius;
    case 'ellipse': {
      const dx = point.x - geometry.center.x;
      const dy = point.y - geometry.center.y;
      if (geometry.rx === 0 || geometry.ry === 0) return false;
      return (dx * dx) / (geometry.rx * geometry.rx) + (dy * dy) / (geometry.ry * geometry.ry) <= 1;
    }
    case 'polygon':
      return pointInPolygon(point, geometry.points);
    default:
      return false;
  }
}

function intersectRect(geometry: Extract<MermaidNodeGeometry, { kind: 'rect' }>, point: Point) {
  let halfWidth = geometry.width / 2;
  let halfHeight = geometry.height / 2;
  const dx = point.x - geometry.center.x;
  const dy = point.y - geometry.center.y;

  if (Math.abs(dy) * halfWidth > Math.abs(dx) * halfHeight) {
    if (dy < 0) halfHeight = -halfHeight;
    return {
      x: geometry.center.x + (dy === 0 ? 0 : (halfHeight * dx) / dy),
      y: geometry.center.y + halfHeight,
    };
  }

  if (dx < 0) halfWidth = -halfWidth;
  return {
    x: geometry.center.x + halfWidth,
    y: geometry.center.y + (dx === 0 ? 0 : (halfWidth * dy) / dx),
  };
}

function intersectCircle(geometry: Extract<MermaidNodeGeometry, { kind: 'circle' }>, point: Point) {
  const dx = point.x - geometry.center.x;
  const dy = point.y - geometry.center.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) return null;

  return {
    x: geometry.center.x + (dx / length) * geometry.radius,
    y: geometry.center.y + (dy / length) * geometry.radius,
  };
}

function intersectEllipse(
  geometry: Extract<MermaidNodeGeometry, { kind: 'ellipse' }>,
  point: Point,
) {
  const dx = point.x - geometry.center.x;
  const dy = point.y - geometry.center.y;
  const scale = Math.sqrt(
    (dx * dx) / (geometry.rx * geometry.rx) + (dy * dy) / (geometry.ry * geometry.ry),
  );
  if (!Number.isFinite(scale) || scale === 0) return null;

  return {
    x: geometry.center.x + dx / scale,
    y: geometry.center.y + dy / scale,
  };
}

function intersectLineSegments(start: Point, end: Point, edgeStart: Point, edgeEnd: Point) {
  const denominator =
    (end.x - start.x) * (edgeEnd.y - edgeStart.y) - (end.y - start.y) * (edgeEnd.x - edgeStart.x);
  if (Math.abs(denominator) < 0.000001) return null;

  const startToEdgeX = edgeStart.x - start.x;
  const startToEdgeY = edgeStart.y - start.y;
  const lineProgress =
    (startToEdgeX * (edgeEnd.y - edgeStart.y) - startToEdgeY * (edgeEnd.x - edgeStart.x)) /
    denominator;
  const edgeProgress =
    (startToEdgeX * (end.y - start.y) - startToEdgeY * (end.x - start.x)) / denominator;

  if (lineProgress < 0 || lineProgress > 1 || edgeProgress < 0 || edgeProgress > 1) {
    return null;
  }

  return {
    point: {
      x: start.x + (end.x - start.x) * lineProgress,
      y: start.y + (end.y - start.y) * lineProgress,
    },
    progress: lineProgress,
  };
}

function intersectPolygon(
  geometry: Extract<MermaidNodeGeometry, { kind: 'polygon' }>,
  point: Point,
) {
  const intersections = geometry.points
    .map((current, index) => {
      const next = geometry.points[(index + 1) % geometry.points.length];
      return intersectLineSegments(geometry.center, point, current, next);
    })
    .filter(
      (intersection): intersection is { point: Point; progress: number } => intersection != null,
    )
    .sort((a, b) => a.progress - b.progress);

  return intersections[0]?.point ?? null;
}

function intersectNodeGeometry(geometry: MermaidNodeGeometry, point: Point) {
  switch (geometry.kind) {
    case 'rect':
      return intersectRect(geometry, point);
    case 'circle':
      return intersectCircle(geometry, point);
    case 'ellipse':
      return intersectEllipse(geometry, point);
    case 'polygon':
      return intersectPolygon(geometry, point);
    default:
      return null;
  }
}

function getNodeGeometry(node: SVGGElement): MermaidNodeGeometry | null {
  const nodeTransform = parseTranslateTransform(node.getAttribute('transform'));
  if (!nodeTransform) return null;

  const polygon = node.querySelector('polygon.label-container, polygon');
  if (polygon instanceof SVGPolygonElement) {
    const polygonTransform = parseTranslateTransform(polygon.getAttribute('transform'));
    const points = parsePolygonPoints(polygon.getAttribute('points'))
      .map((point) => applyTranslate(point, polygonTransform))
      .map((point) => applyTranslate(point, nodeTransform));
    if (points.length >= 3) {
      return {
        kind: 'polygon',
        center: { x: nodeTransform.x, y: nodeTransform.y },
        points,
      };
    }
  }

  const rect = node.querySelector('rect.label-container, rect.basic.label-container');
  if (rect instanceof SVGRectElement) {
    const rectTransform = parseTranslateTransform(rect.getAttribute('transform'));
    const x = Number.parseFloat(rect.getAttribute('x') || '0') + (rectTransform?.x ?? 0);
    const y = Number.parseFloat(rect.getAttribute('y') || '0') + (rectTransform?.y ?? 0);
    const width = Number.parseFloat(rect.getAttribute('width') || '0');
    const height = Number.parseFloat(rect.getAttribute('height') || '0');
    if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
      return {
        kind: 'rect',
        center: {
          x: nodeTransform.x + x + width / 2,
          y: nodeTransform.y + y + height / 2,
        },
        width,
        height,
      };
    }
  }

  const circle = node.querySelector('circle');
  if (circle instanceof SVGCircleElement) {
    const circleTransform = parseTranslateTransform(circle.getAttribute('transform'));
    const radius = Number.parseFloat(circle.getAttribute('r') || '0');
    if (Number.isFinite(radius) && radius > 0) {
      return {
        kind: 'circle',
        center: {
          x:
            nodeTransform.x +
            Number.parseFloat(circle.getAttribute('cx') || '0') +
            (circleTransform?.x ?? 0),
          y:
            nodeTransform.y +
            Number.parseFloat(circle.getAttribute('cy') || '0') +
            (circleTransform?.y ?? 0),
        },
        radius,
      };
    }
  }

  const ellipse = node.querySelector('ellipse');
  if (ellipse instanceof SVGEllipseElement) {
    const ellipseTransform = parseTranslateTransform(ellipse.getAttribute('transform'));
    const rx = Number.parseFloat(ellipse.getAttribute('rx') || '0');
    const ry = Number.parseFloat(ellipse.getAttribute('ry') || '0');
    if (Number.isFinite(rx) && Number.isFinite(ry) && rx > 0 && ry > 0) {
      return {
        kind: 'ellipse',
        center: {
          x:
            nodeTransform.x +
            Number.parseFloat(ellipse.getAttribute('cx') || '0') +
            (ellipseTransform?.x ?? 0),
          y:
            nodeTransform.y +
            Number.parseFloat(ellipse.getAttribute('cy') || '0') +
            (ellipseTransform?.y ?? 0),
        },
        rx,
        ry,
      };
    }
  }

  return null;
}

function findClosestNodeGeometry(geometries: MermaidNodeGeometry[], point: Point) {
  return geometries.reduce<MermaidNodeGeometry | null>((closest, geometry) => {
    if (closest == null) return geometry;

    return distanceSquared(geometry.center, point) < distanceSquared(closest.center, point)
      ? geometry
      : closest;
  }, null);
}

function getMarkerForwardExtent(path: SVGPathElement) {
  const markerUrl = path.getAttribute('marker-end');
  const markerIdMatch = markerUrl?.match(/url\(#([^)]+)\)/);
  const markerId = markerIdMatch?.[1];
  if (!markerId) return 0;

  const marker = path.ownerSVGElement?.querySelector(
    `marker#${CSS.escape(markerId)}`,
  ) as SVGMarkerElement | null;
  if (!marker) return 0;

  const viewBox = marker.viewBox?.baseVal;
  const refX = marker.refX?.baseVal?.value ?? Number.parseFloat(marker.getAttribute('refX') || '0');
  let maxX = Number.isFinite(viewBox?.width) ? viewBox!.x + viewBox!.width : Number.NaN;

  for (const child of marker.children) {
    if (!(child instanceof SVGGraphicsElement)) continue;
    try {
      const bbox = child.getBBox();
      if (Number.isFinite(bbox.width)) {
        maxX = Number.isFinite(maxX) ? Math.max(maxX, bbox.x + bbox.width) : bbox.x + bbox.width;
      }
    } catch {
      // Ignore marker children that cannot report bounds.
    }
  }

  if (!Number.isFinite(maxX)) return 0;

  const markerWidth =
    marker.markerWidth?.baseVal?.value ??
    Number.parseFloat(marker.getAttribute('markerWidth') || '0');
  const scaleX =
    viewBox && viewBox.width > 0 && Number.isFinite(markerWidth) && markerWidth > 0
      ? markerWidth / viewBox.width
      : 1;

  return Math.max(0, (maxX - refX) * scaleX);
}

export function parseViewBox(viewBox: string | null) {
  if (!viewBox) return null;
  const parts = viewBox
    .trim()
    .split(/[\s,]+/)
    .map((part) => Number.parseFloat(part));

  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) {
    return null;
  }

  return { minX: parts[0], minY: parts[1], width: parts[2], height: parts[3] };
}

function collectNodeRanks(root: SVGGElement) {
  const nodeEls = root.querySelectorAll(':scope > g.nodes > g.node');
  const ranks: MermaidRankLayout[] = [];

  for (const nodeEl of nodeEls) {
    const el = nodeEl as SVGGElement;
    const baseTransform = rememberBaseAttribute(el, 'transform', MERMAID_BASE_TRANSFORM_ATTR);
    const transform = parseTranslateTransform(baseTransform);
    if (!transform) continue;

    let bbox: DOMRect | SVGRect;
    try {
      bbox = el.getBBox();
    } catch {
      continue;
    }
    if (!Number.isFinite(bbox.height) || bbox.height <= 0) continue;

    const top = transform.y + bbox.y;
    const bottom = top + bbox.height;
    const rank = ranks.find((candidate) => Math.abs(candidate.centerY - transform.y) < 1);
    const info: MermaidNodeLayoutInfo = { el, transform, bbox };

    if (rank) {
      rank.items.push(info);
      rank.top = Math.min(rank.top, top);
      rank.bottom = Math.max(rank.bottom, bottom);
      continue;
    }

    ranks.push({
      centerY: transform.y,
      items: [info],
      shift: 0,
      top,
      bottom,
    });
  }

  ranks.sort((a, b) => a.centerY - b.centerY);
  return ranks;
}

function getRankShiftResolver(ranks: MermaidRankLayout[]) {
  if (ranks.length === 0) {
    return () => 0;
  }

  return (y: number) => {
    if (y <= ranks[0].centerY) return ranks[0].shift;

    for (let index = 0; index < ranks.length - 1; index += 1) {
      const current = ranks[index];
      const next = ranks[index + 1];
      if (y <= next.centerY) {
        const span = next.centerY - current.centerY;
        if (span <= 0) return next.shift;
        const ratio = (y - current.centerY) / span;
        return current.shift + (next.shift - current.shift) * ratio;
      }
    }

    return ranks[ranks.length - 1].shift;
  };
}

interface PathCommand {
  cmd: string;
  values: number[];
}

export function parsePathCommands(pathData: string) {
  const commands: PathCommand[] = [];
  const commandRe = /([AaCcHhLlMmQqSsTtVvZz])([^AaCcHhLlMmQqSsTtVvZz]*)/g;
  const numberRe = /[-+]?\d*\.?\d+(?:e[-+]?\d+)?/gi;

  for (const match of pathData.matchAll(commandRe)) {
    const cmd = match[1];
    const values = (match[2].match(numberRe) || []).map((value) => Number.parseFloat(value));
    commands.push({ cmd, values });
  }

  return commands;
}

export function formatPathCommands(commands: PathCommand[]) {
  return commands
    .map(({ cmd, values }) => (values.length > 0 ? `${cmd}${values.join(' ')}` : cmd))
    .join('');
}

export function transformPathY(pathData: string, transformY: (y: number) => number) {
  const commands = parsePathCommands(pathData);
  if (commands.some(({ cmd }) => cmd !== cmd.toUpperCase())) {
    return pathData;
  }

  for (const command of commands) {
    switch (command.cmd) {
      case 'M':
      case 'L':
      case 'T':
        for (let index = 1; index < command.values.length; index += 2) {
          command.values[index] = transformY(command.values[index]);
        }
        break;
      case 'C':
        for (let index = 0; index < command.values.length; index += 6) {
          command.values[index + 1] = transformY(command.values[index + 1]);
          command.values[index + 3] = transformY(command.values[index + 3]);
          command.values[index + 5] = transformY(command.values[index + 5]);
        }
        break;
      case 'S':
      case 'Q':
        for (let index = 0; index < command.values.length; index += 4) {
          command.values[index + 1] = transformY(command.values[index + 1]);
          command.values[index + 3] = transformY(command.values[index + 3]);
        }
        break;
      case 'V':
        for (let index = 0; index < command.values.length; index += 1) {
          command.values[index] = transformY(command.values[index]);
        }
        break;
      case 'A':
        for (let index = 0; index < command.values.length; index += 7) {
          command.values[index + 6] = transformY(command.values[index + 6]);
        }
        break;
      default:
        break;
    }
  }

  return formatPathCommands(commands);
}

function stabilizeMermaidRenderedLayout(container: HTMLElement) {
  const svgs = container.querySelectorAll('.mermaid-block .mermaid-svg svg');
  for (const svgEl of svgs) {
    const svg = svgEl as SVGSVGElement;
    const root = svg.querySelector('g.root');
    const edgePaths = root?.querySelector(':scope > g.edgePaths');
    const edgeLabels = root?.querySelector(':scope > g.edgeLabels');
    if (!root || !edgePaths || !edgeLabels) continue;

    const ranks = collectNodeRanks(root as SVGGElement);
    if (ranks.length === 0) continue;

    let previousBottom = Number.NEGATIVE_INFINITY;
    let cumulativeShift = 0;
    for (const rank of ranks) {
      const shiftedTop = rank.top + cumulativeShift;
      const additionalShift = Number.isFinite(previousBottom)
        ? Math.max(0, previousBottom + MERMAID_MIN_RANK_GAP - shiftedTop)
        : 0;
      cumulativeShift += additionalShift;
      rank.shift = cumulativeShift;
      previousBottom = rank.bottom + cumulativeShift;
    }

    const shiftAtY = getRankShiftResolver(ranks);

    for (const rank of ranks) {
      for (const item of rank.items) {
        item.el.setAttribute(
          'transform',
          formatTranslateTransform({
            ...item.transform,
            y: item.transform.y + rank.shift,
          }),
        );
      }
    }

    const edgeLabelEls = edgeLabels.querySelectorAll(':scope > g.edgeLabel');
    for (const edgeLabelEl of edgeLabelEls) {
      const el = edgeLabelEl as SVGGElement;
      const baseTransform = rememberBaseAttribute(el, 'transform', MERMAID_BASE_TRANSFORM_ATTR);
      const transform = parseTranslateTransform(baseTransform);
      if (!transform) continue;

      el.setAttribute(
        'transform',
        formatTranslateTransform({
          ...transform,
          y: transform.y + shiftAtY(transform.y),
        }),
      );
    }

    const edgePathEls = edgePaths.querySelectorAll('path');
    for (const edgePathEl of edgePathEls) {
      const el = edgePathEl as SVGPathElement;
      const basePathData = rememberBaseAttribute(el, 'd', MERMAID_BASE_D_ATTR);
      if (!basePathData) continue;
      el.setAttribute(
        'd',
        transformPathY(basePathData, (y) => y + shiftAtY(y)),
      );
    }

    const baseViewBox = parseViewBox(
      rememberBaseAttribute(svg, 'viewBox', MERMAID_BASE_VIEWBOX_ATTR),
    );
    if (baseViewBox) {
      svg.setAttribute(
        'viewBox',
        `${baseViewBox.minX} ${baseViewBox.minY} ${baseViewBox.width} ${baseViewBox.height + cumulativeShift}`,
      );
    }
  }
}

export function stabilizeMermaidSvgSizing(container: HTMLElement) {
  const svgs = container.querySelectorAll('.mermaid-block .mermaid-svg svg');
  for (const svgEl of svgs) {
    const svg = svgEl as SVGSVGElement;
    const wrapper = svg.parentElement as HTMLElement | null;
    const viewBox = svg.viewBox?.baseVal;
    if (!wrapper || !viewBox || !viewBox.width || !viewBox.height) continue;

    svg.style.width = '100%';
    svg.style.maxWidth = `${viewBox.width}px`;
    svg.style.minWidth = '0';
    svg.style.height = 'auto';
    svg.style.overflow = 'visible';
    svg.setAttribute('preserveAspectRatio', 'xMidYMin meet');
    wrapper.scrollLeft = 0;
  }
}

function findPathPointOutsideGeometry(
  path: SVGPathElement,
  totalLength: number,
  geometry: MermaidNodeGeometry,
) {
  const sampleOffsets = [24, 48, 96, Math.max(0, totalLength - 1)].filter(
    (offset, index, offsets) =>
      offset > 0 && offset < totalLength && offsets.indexOf(offset) === index,
  );

  for (const offset of sampleOffsets) {
    const samplePoint = path.getPointAtLength(Math.max(0, totalLength - offset));
    const point = { x: samplePoint.x, y: samplePoint.y };
    if (!pointInsideGeometry(geometry, point)) {
      return point;
    }
  }

  return null;
}

// Mermaid computes edge intersections before we resize HTML labels. Once wrapped labels
// settle, we rebuild only the visible endpoint overlay so arrowheads stay aligned to the
// current node boundary without repainting the full connector above the node boxes.
function buildArrowEndpointSegment(
  path: SVGPathElement,
  geometry: MermaidNodeGeometry | null,
  totalLength: number,
  segmentLength = 1.5,
) {
  const originalEnd = path.getPointAtLength(totalLength);
  const endPoint = { x: originalEnd.x, y: originalEnd.y };
  const externalPoint = geometry ? findPathPointOutsideGeometry(path, totalLength, geometry) : null;
  const targetEnd =
    geometry && externalPoint
      ? (intersectNodeGeometry(geometry, externalPoint) ?? endPoint)
      : endPoint;
  const directionPoint =
    externalPoint ?? path.getPointAtLength(Math.max(0, totalLength - segmentLength));
  const dx = targetEnd.x - directionPoint.x;
  const dy = targetEnd.y - directionPoint.y;
  const length = Math.hypot(dx, dy);
  const markerForwardExtent = getMarkerForwardExtent(path);

  if (!Number.isFinite(length) || length === 0) {
    return `M${targetEnd.x},${targetEnd.y}L${targetEnd.x},${targetEnd.y}`;
  }

  const endX = targetEnd.x - (dx / length) * markerForwardExtent;
  const endY = targetEnd.y - (dy / length) * markerForwardExtent;
  return `M${endX - (dx / length) * segmentLength},${endY - (dy / length) * segmentLength}L${endX},${endY}`;
}

function stabilizeMermaidArrowEndpoints(container: HTMLElement) {
  const svgs = container.querySelectorAll('.mermaid-block .mermaid-svg svg');
  for (const svgEl of svgs) {
    const root = svgEl.querySelector('g.root');
    const edgePaths = root?.querySelector(':scope > g.edgePaths');
    const nodes = root?.querySelector(':scope > g.nodes');
    const edgeLabels = root?.querySelector(':scope > g.edgeLabels');
    if (!root || !edgePaths || !nodes || !edgeLabels) continue;

    root.querySelector(':scope > g.edgeEndpointOverlays')?.remove();

    const overlayGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    overlayGroup.setAttribute('class', 'edgeEndpointOverlays');
    overlayGroup.setAttribute('pointer-events', 'none');
    const nodeGeometries = Array.from(nodes.querySelectorAll(':scope > g.node'))
      .map((node) => getNodeGeometry(node as SVGGElement))
      .filter((geometry): geometry is MermaidNodeGeometry => geometry != null);

    const paths = edgePaths.querySelectorAll('path[marker-end]');
    for (const pathEl of paths) {
      const path = pathEl as SVGPathElement;
      const totalLength = path.getTotalLength();
      if (!Number.isFinite(totalLength) || totalLength <= 0) continue;

      const endPoint = path.getPointAtLength(totalLength);
      const targetGeometry = findClosestNodeGeometry(nodeGeometries, {
        x: endPoint.x,
        y: endPoint.y,
      });
      const overlayPath = path.cloneNode(false) as SVGPathElement;
      overlayPath.removeAttribute('id');
      overlayPath.setAttribute('d', buildArrowEndpointSegment(path, targetGeometry, totalLength));
      overlayPath.classList.add('mermaid-edge-endpoint-overlay');
      overlayPath.setAttribute('data-source-edge-id', path.id);
      overlayPath.setAttribute('style', 'stroke: transparent !important; fill: none !important;');
      overlayGroup.appendChild(overlayPath);
    }

    root.appendChild(nodes);
    if (overlayGroup.childNodes.length > 0) {
      root.appendChild(overlayGroup);
    }
    root.appendChild(edgeLabels);
  }
}

export function stabilizeMermaidLabelLayout(container: HTMLElement) {
  const labels = container.querySelectorAll('.mermaid-block .node .label foreignObject');
  for (const label of labels) {
    const foreignObject = label as SVGForeignObjectElement;
    const width = Number.parseFloat(foreignObject.getAttribute('width') || '');
    if (!Number.isFinite(width) || width <= 0) continue;

    const contentRoot = foreignObject.firstElementChild as HTMLElement | null;
    if (!contentRoot) continue;

    applyWrappedLabelTextStyles(contentRoot, width);

    const measuredHeight = getRenderedLabelHeight(contentRoot);
    if (!Number.isFinite(measuredHeight) || measuredHeight <= 0) continue;

    const labelGroup = foreignObject.parentElement as SVGGElement | null;
    const nodeGroup = labelGroup?.closest('.node') as SVGGElement | null;
    const labelRect = nodeGroup?.querySelector(
      'rect.label-container, rect.basic.label-container',
    ) as SVGRectElement | null;

    foreignObject.setAttribute('height', String(measuredHeight));

    if (labelGroup) {
      labelGroup.setAttribute('transform', `translate(${-width / 2}, ${-measuredHeight / 2})`);
    }

    if (labelRect) {
      const paddedHeight = measuredHeight + 30;
      const paddedWidth = width + 60;
      labelRect.setAttribute('width', String(paddedWidth));
      labelRect.setAttribute('height', String(paddedHeight));
      labelRect.setAttribute('x', String(-paddedWidth / 2));
      labelRect.setAttribute('y', String(-paddedHeight / 2));
    }
  }

  const edgeLabels = container.querySelectorAll('.mermaid-block g.edgeLabel foreignObject');
  for (const label of edgeLabels) {
    const foreignObject = label as SVGForeignObjectElement;
    const width = Number.parseFloat(foreignObject.getAttribute('width') || '');
    const currentHeight = Number.parseFloat(foreignObject.getAttribute('height') || '');
    if (!Number.isFinite(width) || width <= 0) continue;

    const contentRoot = foreignObject.firstElementChild as HTMLElement | null;
    if (!contentRoot) continue;

    applyWrappedLabelTextStyles(contentRoot, width);

    const measuredHeight = getRenderedLabelHeight(contentRoot);
    const targetHeight = Math.max(
      Number.isFinite(currentHeight) ? currentHeight : 0,
      measuredHeight,
    );
    if (!Number.isFinite(targetHeight) || targetHeight <= 0) continue;

    foreignObject.setAttribute('height', String(targetHeight));

    const labelGroup = foreignObject.parentElement as SVGGElement | null;
    if (labelGroup) {
      labelGroup.setAttribute('transform', `translate(${-width / 2}, ${-targetHeight / 2})`);
    }
  }
}

export function scheduleMermaidLayoutStabilization(container: HTMLElement) {
  let disposed = false;
  const frameIds: number[] = [];
  const timeoutIds: number[] = [];

  const run = () => {
    if (disposed || !container.isConnected) return;
    stabilizeMermaidLabelLayout(container);
    stabilizeMermaidRenderedLayout(container);
    stabilizeMermaidSvgSizing(container);
    stabilizeMermaidArrowEndpoints(container);
  };

  const queueFramePasses = (remaining: number) => {
    if (remaining <= 0) return;
    const frameId = window.requestAnimationFrame(() => {
      run();
      queueFramePasses(remaining - 1);
    });
    frameIds.push(frameId);
  };

  run();
  queueFramePasses(2);
  timeoutIds.push(window.setTimeout(run, 50));
  timeoutIds.push(window.setTimeout(run, 200));
  if ('fonts' in document) {
    void document.fonts.ready.then(() => {
      run();
    });
  }

  return () => {
    disposed = true;
    for (const frameId of frameIds) {
      window.cancelAnimationFrame(frameId);
    }
    for (const timeoutId of timeoutIds) {
      window.clearTimeout(timeoutId);
    }
  };
}
