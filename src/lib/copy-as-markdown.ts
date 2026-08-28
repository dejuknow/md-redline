import { unified } from 'unified';
import rehypeParse from 'rehype-parse';
import rehypeRemark from 'rehype-remark';
import remarkGfm from 'remark-gfm';
import remarkStringify from 'remark-stringify';
import { buildRangeHtml } from './copy-selection-html';
import { collectVisibleTextNodes } from './visible-text';

export interface SelectionMarkdown {
  markdown: string;
  /**
   * True when this is the document's own bytes, sliced by the spans the
   * pipeline annotated blocks with; false when it was rebuilt from the rendered
   * fragment. Both cover exactly what was highlighted. Only the first is
   * guaranteed to match the file character for character, which is what an
   * agent needs when it is asked to rewrite the passage in place.
   */
  exact: boolean;
}

const START = 'data-src-start';
const END = 'data-src-end';

/** The nearest ancestor that carries a source span, itself included. */
function annotatedAncestor(node: Node | null, container: HTMLElement): HTMLElement | null {
  let el = node instanceof HTMLElement ? node : (node?.parentElement ?? null);
  while (el && container.contains(el)) {
    if (el.hasAttribute(START) && el.hasAttribute(END)) return el;
    el = el.parentElement;
  }
  return null;
}

/**
 * Whether `range` covers `el` from its very first character to its very last.
 *
 * This is what separates the two paths. A selection flush with a block's
 * boundaries can be answered with the file's own bytes; anything finer cannot,
 * because a block's span is the only position the DOM carries.
 *
 * Asked with comparePoint against the block's first and last text rather than
 * with compareBoundaryPoints: a boundary written as (textNode, 0) and one
 * written as (element, 0) are the same position, and jsdom does not treat them
 * as equal, so the boundary comparison quietly reported a flush selection as
 * ragged. Points are unambiguous.
 */
function coversWholeElement(range: Range, el: HTMLElement): boolean {
  // Whitespace-only nodes between block tags are text the selection never
  // covers, and treating them as the block's first and last characters made
  // every flush selection of a list, a quote, a table or a fenced block look
  // ragged: they all fell back to a rebuild rather than slicing the file.
  const texts = collectVisibleTextNodes(el).filter((node) => (node.textContent ?? '').trim());
  const first = texts[0];
  const last = texts[texts.length - 1];
  if (!first || !last) return false;
  // comparePoint returns 0 for a point inside the range, boundaries included.
  return (
    range.comparePoint(first, 0) === 0 &&
    range.comparePoint(last, last.textContent?.length ?? 0) === 0
  );
}

const toMarkdown = unified()
  .use(rehypeParse, { fragment: true })
  .use(rehypeRemark)
  .use(remarkGfm)
  .use(remarkStringify, { bullet: '-', fences: true, rule: '-' });

/**
 * The markdown for a selection: the document's own source where the selection
 * lines up with blocks, and markdown rebuilt from the rendered fragment where
 * it does not.
 *
 * The scope never changes. Widening a ragged selection out to its enclosing
 * block would hand back more text than was highlighted, and people paste into a
 * composer and send without rereading, so the rebuild is used instead: it keeps
 * the words exactly as selected and normalises only the syntax.
 */
export function resolveSelectionMarkdown(
  range: Range,
  container: HTMLElement,
  source: string,
): SelectionMarkdown | null {
  if (range.collapsed) return null;

  const startBlock = annotatedAncestor(range.startContainer, container);
  const endBlock = annotatedAncestor(range.endContainer, container);
  if (
    startBlock &&
    endBlock &&
    coversWholeElement(range, startBlock) &&
    coversWholeElement(range, endBlock)
  ) {
    const start = Number(startBlock.getAttribute(START));
    const end = Number(endBlock.getAttribute(END));
    if (Number.isFinite(start) && Number.isFinite(end) && end > start && end <= source.length) {
      return { markdown: source.slice(start, end), exact: true };
    }
  }

  const html = buildRangeHtml(range, container);
  if (!html) return null;
  const markdown = String(toMarkdown.processSync(html)).trim();
  return markdown ? { markdown, exact: false } : null;
}

/**
 * The Range the painted selection occupies, rebuilt from the marks on screen.
 *
 * The Range the reader actually dragged is long gone by the time a menu item is
 * clicked: committing a selection re-runs the render effect, which replaces the
 * container's innerHTML and takes every live Range with it. The painted marks
 * are what survive, and they are the selection, so they are what the copy is
 * built from.
 */
export function rangeFromPaintedSelection(container: HTMLElement): Range | null {
  const marks = Array.from(container.querySelectorAll('mark.selection-highlight'));
  const first = marks[0];
  const last = marks[marks.length - 1];
  if (!first || !last) return null;
  const range = container.ownerDocument.createRange();
  range.setStartBefore(first);
  range.setEndAfter(last);
  return range;
}
