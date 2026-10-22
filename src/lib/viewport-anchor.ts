/**
 * The reader's place in a rendered document, recorded as a block rather than a
 * pixel offset: the topmost top-level block still intersecting the scroller's
 * viewport, and how far that block sits from the viewport's top. A pixel offset
 * points at different text once the document above it changes or reflows; a
 * block can be found again and scrolled back to the same spot.
 *
 * Blocks are identified by content (viewportAnchorKey), because the viewer
 * rebuilds its whole subtree with innerHTML, so every node is new after a
 * render. Identical blocks share a key and are told apart by position among
 * themselves (`ordinal`), as matchTableScroll pairs equal tables in order.
 */
export interface ViewportAnchor {
  key: string;
  /** Which copy of a block with this key: 0 for the first. */
  ordinal: number;
  /** The block's top relative to the scroller's top, in pixels. */
  offset: number;
}

/** Content identity for a top-level block. The tag name keeps a heading and a
 *  paragraph with identical text apart. A Mermaid diagram is keyed by its
 *  source instead: the same diagram is a <pre> of source until its SVG lands
 *  and a .mermaid-block of SVG text after, and that SVG text carries an id
 *  minted per render (`#mermaid-svg-N` in its styles), so neither its tag nor
 *  its text survives from one render to the next. */
export function viewportAnchorKey(el: Element): string {
  const source = mermaidSourceOf(el);
  if (source !== null) return `MERMAID:${source.length}:${source.slice(0, 200)}`;
  const text = el.textContent ?? '';
  return `${el.tagName}:${text.length}:${text.slice(0, 200)}`;
}

/**
 * The diagram source behind a top-level Mermaid block in any of its states, or
 * null for any other block. Trimmed as MarkdownViewer trims it to look the SVG
 * up, so all three states agree: the fenced <pre> still waiting for its SVG,
 * the rendered .mermaid-block (whose fullscreen button carries the source), and
 * the .mermaid-block error that replaces a diagram that failed to render.
 */
function mermaidSourceOf(el: Element): string | null {
  if (el.tagName === 'PRE') {
    const code = el.querySelector(':scope > code.language-mermaid');
    return code ? (code.textContent ?? '').trim() : null;
  }
  if (!el.classList.contains('mermaid-block')) return null;
  const holder = el.querySelector(':scope > .mermaid-block-expand') ?? el;
  return holder.getAttribute('data-mermaid-source');
}

/** How many blocks before `index` share its key: which copy of an identical
 *  block it is (0 for the first). */
export function viewportAnchorOrdinal(keys: string[], index: number): number {
  let ordinal = 0;
  for (let i = 0; i < index; i++) if (keys[i] === keys[index]) ordinal++;
  return ordinal;
}

/**
 * The index of the `ordinal`-th block whose key is `key`, or undefined when
 * there is no such copy: the anchored content was deleted or rewritten, or has
 * not rendered yet.
 */
export function matchViewportAnchor(
  key: string,
  ordinal: number,
  currentKeys: string[],
): number | undefined {
  let seen = 0;
  for (let i = 0; i < currentKeys.length; i++) {
    if (currentKeys[i] !== key) continue;
    if (seen === ordinal) return i;
    seen++;
  }
  return undefined;
}

/**
 * Record the reader's place among `blocks`' children. Undefined at the very
 * top, where there is nothing to hold onto: a reader at scrollTop 0 stays at
 * the top, as native scroll anchoring selects no anchor at offset 0.
 */
export function captureViewportAnchor(
  scroller: HTMLElement,
  blocks: Element,
): ViewportAnchor | undefined {
  if (scroller.scrollTop <= 0) return undefined;
  const scrollerTop = scroller.getBoundingClientRect().top;
  const children = Array.from(blocks.children);
  const keys = children.map(viewportAnchorKey);
  for (let i = 0; i < children.length; i++) {
    const rect = children[i].getBoundingClientRect();
    if (rect.bottom > scrollerTop) {
      return {
        key: keys[i],
        ordinal: viewportAnchorOrdinal(keys, i),
        offset: rect.top - scrollerTop,
      };
    }
  }
  return undefined;
}

/**
 * The scrollTop that puts the anchored block back at its recorded offset, or
 * undefined when no block among `blocks`' children matches the anchor.
 *
 * The offset is clamped to the block's current height. A block can come back
 * shorter than it was (a Mermaid diagram's source <pre> replaced by its SVG):
 * a reader 800px into an 1100px <pre> whose diagram is 300px tall lands at the
 * diagram's end, not 500px past it in whatever follows.
 */
export function viewportAnchorScrollTop(
  scroller: HTMLElement,
  blocks: Element,
  anchor: ViewportAnchor,
): number | undefined {
  const children = Array.from(blocks.children);
  const index = matchViewportAnchor(anchor.key, anchor.ordinal, children.map(viewportAnchorKey));
  if (index === undefined) return undefined;
  const rect = children[index].getBoundingClientRect();
  const blockTop = rect.top - scroller.getBoundingClientRect().top;
  const offset = Math.max(anchor.offset, -(rect.bottom - rect.top));
  return scroller.scrollTop + blockTop - offset;
}
