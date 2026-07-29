/**
 * Serializes a document selection as HTML for the clipboard's rich-text flavor.
 *
 * Captured at selection time, before the viewer repaints. The rendered view
 * wraps the pending selection in `mark.selection-highlight`, which replaces the
 * selected text nodes and collapses the browser's range, so nothing usable
 * survives to copy time. Snapshotting the range here keeps the rich flavor
 * independent of whether (or how) the highlight paints.
 */

/** Highlight wrappers the app paints. None of them are document content. */
const APP_MARK_SELECTOR =
  'mark.selection-highlight, mark.comment-highlight, mark.comment-highlight-sent, mark.comment-highlight-active, mark.search-highlight, mark.search-highlight-active';

/** List containers whose items must stay wrapped to paste as a list. */
const LIST_TAGS = new Set(['UL', 'OL']);

function unwrapAppMarks(root: DocumentFragment | HTMLElement): void {
  for (const mark of Array.from(root.querySelectorAll(APP_MARK_SELECTOR))) {
    const parent = mark.parentNode;
    if (!parent) continue;
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    parent.removeChild(mark);
  }
}

/**
 * UI the viewer injects into the prose. None of it is document content, and a
 * selection spanning a Mermaid diagram would otherwise carry its fullscreen
 * button (icon and all) into the paste.
 */
const VIEWER_CHROME_SELECTOR = '[data-drag-handle], [data-comment-form], .mermaid-block-expand';

/**
 * Layout scaffolding the pipeline wraps around content (see
 * `src/markdown/pipeline.ts`). Unlike viewer chrome these hold the content, so
 * they are unwrapped rather than removed: a selection running from a table into
 * the prose after it clones the scroll wrapper as a top-level node, and pasting
 * app-specific containers into a rich editor is exactly what CONTENT_WRAPPERS
 * exists to prevent.
 */
// .doc-frontmatter is a presentation box around document text, exactly like
// the table scroll wrappers: a selection running from a frontmatter field into
// the prose below reconstructs it via cloneContents and would otherwise paste
// an app class into someone else's document.
const LAYOUT_WRAPPER_SELECTOR = '.table-scroll, .table-scroll__viewport, .doc-frontmatter';

/** Drop UI the viewer overlays on the prose so it never lands on the clipboard. */
function stripViewerChrome(root: DocumentFragment | HTMLElement): void {
  for (const el of Array.from(root.querySelectorAll(VIEWER_CHROME_SELECTOR))) {
    el.remove();
  }
  for (const el of Array.from(root.querySelectorAll(LAYOUT_WRAPPER_SELECTOR))) {
    const parent = el.parentNode;
    if (!parent) continue;
    while (el.firstChild) parent.insertBefore(el.firstChild, el);
    parent.removeChild(el);
  }
}

/**
 * Elements the boundary walk may climb into. Document structure only: layout
 * wrappers (the doc sheet, the table scroll box) carry app classes and styles
 * that have no business on the clipboard, and stopping at them keeps the
 * snapshot to content the user can see.
 */
const CONTENT_WRAPPERS = new Set([
  'A',
  'ABBR',
  'BLOCKQUOTE',
  'CODE',
  'DD',
  'DEL',
  'DL',
  'DT',
  'EM',
  'FIGCAPTION',
  'FIGURE',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'INS',
  'KBD',
  'LI',
  'MARK',
  'OL',
  'P',
  'PRE',
  'S',
  'SMALL',
  'SPAN',
  'STRONG',
  'SUB',
  'SUP',
  'TABLE',
  'TBODY',
  'TD',
  'TFOOT',
  'TH',
  'THEAD',
  'TR',
  'UL',
]);

function isIgnorable(node: Node): boolean {
  return node.nodeType === Node.TEXT_NODE && (node.textContent ?? '').trim().length === 0;
}

function meaningfulChildren(parent: Node): Node[] {
  return Array.from(parent.childNodes).filter((n) => !isIgnorable(n));
}

/** Table-internal elements that cannot stand alone at a fragment's top level. */
const TABLE_SECTIONS = new Set(['TBODY', 'THEAD', 'TFOOT']);
const TABLE_SCOPED = new Set(['TBODY', 'THEAD', 'TFOOT', 'TR', 'TD', 'TH']);

/**
 * Rebuild the `<table>` around table-internal nodes left at the fragment's top
 * level, the same problem `wrapLooseListItems` solves for lists: a selection
 * that does not cover the whole table clones rows or cells without their table
 * ancestor. The HTML fragment parser drops stray `<tr>`/`<td>` and
 * foster-parents their text, so pasting one loses the table entirely.
 */
function rebuildTableWrapper(fragment: DocumentFragment, doc: Document): void {
  const topLevel = meaningfulChildren(fragment);
  if (topLevel.length === 0) return;
  if (!topLevel.every((n) => n instanceof Element && TABLE_SCOPED.has(n.tagName))) return;

  const table = doc.createElement('table');
  let section: Element | null = null;
  let row: Element | null = null;
  for (const node of topLevel as Element[]) {
    if (TABLE_SECTIONS.has(node.tagName)) {
      table.appendChild(node);
      section = null;
      row = null;
      continue;
    }
    if (!section) {
      section = doc.createElement('tbody');
      table.appendChild(section);
    }
    if (node.tagName === 'TR') {
      section.appendChild(node);
      row = null;
      continue;
    }
    if (!row) {
      row = doc.createElement('tr');
      section.appendChild(row);
    }
    row.appendChild(node);
  }
  fragment.appendChild(table);
}

/**
 * A selection that lives inside a single cell is a text selection, not a table
 * selection. Boundary widening lifts it to the enclosing table, so without this
 * copying one value out of a spec's config table would paste a 1x1 table.
 * Applies only when the clone holds exactly one cell and nothing else.
 */
function unwrapSingleCell(fragment: DocumentFragment): void {
  const topLevel = meaningfulChildren(fragment);
  if (topLevel.length !== 1) return;
  const only = topLevel[0];
  if (!(only instanceof Element)) return;
  if (only.tagName !== 'TABLE' && !TABLE_SCOPED.has(only.tagName)) return;

  const cells =
    only.tagName === 'TD' || only.tagName === 'TH'
      ? [only]
      : Array.from(only.querySelectorAll('td, th'));
  if (cells.length !== 1) return;
  const cell = cells[0];
  if ((only.textContent ?? '').trim() !== (cell.textContent ?? '').trim()) return;

  while (fragment.firstChild) fragment.removeChild(fragment.firstChild);
  while (cell.firstChild) fragment.appendChild(cell.firstChild);
}

/**
 * A range across list items clones to bare `<li>` elements when the `<ul>` sits
 * above the range's common ancestor. Rich-text targets need the list container
 * to render them as a list, so put it back. An ordered list also carries its
 * numbering across: copying items 3 through 5 pastes as 3, 4, 5 rather than
 * restarting at 1.
 */
function wrapLooseListItems(
  fragment: DocumentFragment,
  doc: Document,
  source: Element,
): Element | null {
  const topLevel = meaningfulChildren(fragment);
  const leading: Node[] = [];
  for (const node of topLevel) {
    if (node.nodeType !== Node.ELEMENT_NODE || (node as Element).tagName !== 'LI') break;
    leading.push(node);
  }
  if (leading.length === 0) return null;

  // Only the leading run is re-wrapped: a selection can run out of a list and
  // into the paragraph below it, and those trailing blocks are not list items.
  const list = doc.createElement(source.tagName.toLowerCase());
  fragment.insertBefore(list, leading[0]);
  for (const node of leading) list.appendChild(node);
  return list;
}

/**
 * Carry an ordered list's numbering across, so copying items 3 through 5
 * pastes as 3, 4, 5 rather than restarting at 1. Runs after any re-wrap,
 * because the list element reaches the fragment two different ways: cloned
 * along with the range when the selection ends on the list's last item, or
 * rebuilt by wrapLooseListItems when it does not.
 *
 * The offset comes from the source item the range started in, not from
 * matching text: a selection that starts mid-item clones a partial string,
 * and two items can read identically.
 */
function restoreOrderedStart(
  list: Element | null,
  source: Element | null,
  startItem: Element | null,
): void {
  if (!list || !source || list.tagName !== 'OL' || source.tagName !== 'OL') return;

  const items = Array.from(source.children).filter((el) => el.tagName === 'LI');
  const offset = startItem ? items.indexOf(startItem) : -1;
  const parsed = Number.parseInt(source.getAttribute('start') ?? '1', 10);
  const sourceStart = Number.isFinite(parsed) ? parsed : 1;
  const start = sourceStart + Math.max(0, offset);
  // The clone may already carry the source's `start`, so 1 has to clear it
  // rather than fall through: a `0.` list (valid CommonMark, and what the
  // pipeline emits) would otherwise keep numbering from 0.
  if (start === 1) list.removeAttribute('start');
  else list.setAttribute('start', String(start));
}

/**
 * Climb from a boundary through every ancestor the selection starts (or ends)
 * flush against. `cloneContents` only reproduces ancestors the range crosses,
 * so a link or heading wrapped tightly around the selected text would otherwise
 * be flattened to bare words. Stopping at the first ancestor the boundary is
 * not flush against keeps unselected content out of the range.
 */
function expandBoundaries(range: Range, container: Element): void {
  const startNode = range.startContainer;
  const startFlush =
    startNode.nodeType === Node.TEXT_NODE
      ? (startNode.textContent ?? '').slice(0, range.startOffset).trim().length === 0
      : range.startOffset === 0;
  if (startFlush) {
    let node: Node = startNode;
    while (
      node.parentElement &&
      node.parentElement !== container &&
      CONTENT_WRAPPERS.has(node.parentElement.tagName) &&
      meaningfulChildren(node.parentElement)[0] === node
    ) {
      node = node.parentElement;
    }
    if (node !== startNode) range.setStartBefore(node);
  }

  const endNode = range.endContainer;
  const endFlush =
    endNode.nodeType === Node.TEXT_NODE
      ? (endNode.textContent ?? '').slice(range.endOffset).trim().length === 0
      : range.endOffset === endNode.childNodes.length;
  if (endFlush) {
    let node: Node = endNode;
    while (
      node.parentElement &&
      node.parentElement !== container &&
      CONTENT_WRAPPERS.has(node.parentElement.tagName)
    ) {
      const siblings = meaningfulChildren(node.parentElement);
      if (siblings[siblings.length - 1] !== node) break;
      node = node.parentElement;
    }
    if (node !== endNode) range.setEndAfter(node);
  }
}

/** Transient attribute used to find a source list's clone. Never serialized. */
const CLONE_MARK = 'data-mdr-copy-list';

/** A list the selection passes through, paired with the item it starts at. */
interface ListLevel {
  list: Element;
  item: Element;
}

/**
 * Every list the range's start sits inside, outermost first, each paired with
 * the item at that list's own level.
 *
 * Nesting is arbitrarily deep and every level carries its own numbering, so
 * this walks the whole chain rather than modelling a fixed outer/inner pair —
 * a two-slot model silently drops the numbering of any list between the two.
 */
function collectListLevels(range: Range, container: Element): ListLevel[] {
  const { startContainer, startOffset } = range;
  const atBoundary =
    startContainer.nodeType === Node.ELEMENT_NODE
      ? (startContainer.childNodes[startOffset] ?? startContainer)
      : startContainer;
  const host = atBoundary instanceof Element ? atBoundary : (atBoundary?.parentElement ?? null);

  const levels: ListLevel[] = [];
  let item = host?.closest('li') ?? null;
  while (item && container.contains(item)) {
    const list = item.parentElement?.closest('ul, ol') ?? null;
    if (!list || !container.contains(list)) break;
    levels.unshift({ list, item });
    item = list.parentElement?.closest('li') ?? null;
  }
  return levels;
}

/**
 * The list that owns the fragment's top-level items. `cloneContents` puts the
 * widened range's common ancestor's children at the top level, so that
 * ancestor decides which list the clone's loose items belong to. Reading it
 * off the range's innermost item instead would re-wrap a nested selection in
 * the sublist's tag, pasting a bullet list as a numbered one.
 */
function owningList(range: Range): Element | null {
  const common = range.commonAncestorContainer;
  const commonEl =
    common.nodeType === Node.ELEMENT_NODE ? (common as Element) : common.parentElement;
  if (!commonEl) return null;
  if (LIST_TAGS.has(commonEl.tagName)) return commonEl;

  const startEl =
    range.startContainer.nodeType === Node.ELEMENT_NODE
      ? ((range.startContainer.childNodes[range.startOffset] ?? range.startContainer) as Element)
      : range.startContainer.parentElement;
  let node: Element | null = startEl instanceof Element ? startEl : null;
  while (node && node.parentElement !== commonEl) node = node.parentElement;
  return node && LIST_TAGS.has(node.tagName) ? node : null;
}

/**
 * Snapshot `range` as clipboard-ready HTML, or null when it holds no markup
 * worth carrying. Never mutates the live document beyond a transient tag that
 * is always removed: the passed range is cloned before its boundaries widen.
 *
 * Never throws. This runs inside `resolveSelection` on every mouseup, so a
 * failure here would leave the app without a selection at all — no pill, no
 * comment form, and the previous selection stranded in state for the next
 * Cmd+Enter to anchor against. The rich clipboard flavor is a nicety; losing
 * it silently is the right trade against losing the core interaction.
 */
export function buildRangeHtml(range: Range, container: Element | null): string | null {
  try {
    return serializeRange(range, container);
  } catch {
    return null;
  }
}

function serializeRange(range: Range, container: Element | null): string | null {
  if (!container) return null;
  const doc = container.ownerDocument;
  if (!doc) return null;

  let working: Range;
  try {
    working = range.cloneRange();
    expandBoundaries(working, container);
  } catch {
    return null;
  }

  // A source list's counterpart inside the clone cannot be found by search:
  // nesting, partial ancestors and dropped leading siblings all move it. Tag
  // each level for the duration of the clone instead. The attribute is removed
  // from the live document in a finally, and from the clone before serializing.
  const levels = collectListLevels(working, container);
  levels.forEach(({ list }, depth) => list.setAttribute(CLONE_MARK, String(depth)));
  let fragment: DocumentFragment;
  try {
    fragment = working.cloneContents();
  } finally {
    for (const { list } of levels) list.removeAttribute(CLONE_MARK);
  }
  unwrapAppMarks(fragment);
  stripViewerChrome(fragment);

  // The outermost list's items can be the fragment's top-level nodes, in which
  // case the list element itself was never cloned and has to be rebuilt.
  const wrapList = owningList(working);
  const rebuilt = wrapList ? wrapLooseListItems(fragment, doc, wrapList) : null;
  rebuildTableWrapper(fragment, doc);
  unwrapSingleCell(fragment);

  // Every level the selection passes through carries its own numbering.
  levels.forEach(({ list, item }, depth) => {
    const clone =
      fragment.querySelector(`[${CLONE_MARK}="${depth}"]`) ?? (list === wrapList ? rebuilt : null);
    restoreOrderedStart(clone, list, item);
  });

  for (const marked of Array.from(fragment.querySelectorAll(`[${CLONE_MARK}]`))) {
    marked.removeAttribute(CLONE_MARK);
  }

  const holder = doc.createElement('div');
  holder.appendChild(fragment);
  const html = holder.innerHTML.trim();
  return html.length > 0 ? html : null;
}
