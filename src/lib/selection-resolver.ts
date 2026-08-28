import type { SelectionInfo } from '../types';
import { buildRangeHtml } from './copy-selection-html';
import { getVisibleTextContent, getVisibleTextOffset } from './visible-text';

/**
 * The part of `range` that lies inside `containerEl`, or null if none of it
 * does.
 *
 * A drag that ends in the sheet's empty area below the text does not stop at
 * the last character: the browser carries the range's end into whatever layout
 * element the pointer was over, so its `commonAncestorContainer` is a wrapper
 * ABOVE the prose. Testing containment on that ancestor threw the entire
 * selection away, leaving the native highlight painted with no pill, no mark,
 * and a right-click that reached the browser's menu instead of the viewer's.
 * Clamping keeps what the reader actually selected inside the document and
 * drops the overshoot.
 */
function clampToContainer(range: Range, containerEl: HTMLElement): Range | null {
  const bounds = containerEl.ownerDocument.createRange();
  bounds.selectNodeContents(containerEl);

  const clamped = range.cloneRange();
  if (clamped.compareBoundaryPoints(Range.START_TO_START, bounds) < 0) {
    clamped.setStart(bounds.startContainer, bounds.startOffset);
  }
  if (clamped.compareBoundaryPoints(Range.END_TO_END, bounds) > 0) {
    clamped.setEnd(bounds.endContainer, bounds.endOffset);
  }
  // A selection entirely outside the container clamps to nothing, which is the
  // case the old containment check was right about.
  return clamped.collapsed ? null : clamped;
}

export function resolveSelection(containerEl: HTMLElement): SelectionInfo | null {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;

  const range = clampToContainer(sel.getRangeAt(0), containerEl);
  if (!range) return null;

  // `Selection.toString()` reports block boundaries, so two paragraphs come
  // back separated by a blank line; `Range.toString()` runs them together.
  // That string is the comment's stored anchor and the text/plain clipboard
  // flavour, and in markdown a single newline is a soft break, so the blank
  // line is the difference between pasting two paragraphs and pasting one.
  //
  // Prefer the selection's own string whenever the clamp only dropped empty
  // layout space, which is the whitespace-release case it exists for. When the
  // clamp removed actual content, the drag ran into another surface and the
  // clamped text is the honest answer.
  // Compared without whitespace, since the whole difference between the two is
  // whitespace: same characters means the clamp dropped nothing that matters.
  const squash = (t: string) => t.replace(/\s+/g, '');
  const selectionText = sel.toString();
  const clampedText = range.toString();
  const rawText = squash(selectionText) === squash(clampedText) ? selectionText : clampedText;
  const text = rawText.trim();
  if (!text || text.length < 2) return null;

  // Get surrounding context from the rendered text
  const fullText = getVisibleTextContent(containerEl);
  const selStart = getVisibleTextOffset(containerEl, range.startContainer, range.startOffset);

  // Adjust for leading whitespace that trim() removed so context windows
  // align with the trimmed anchor text, not the raw selection boundaries.
  const leadingTrim = rawText.length - rawText.trimStart().length;
  const adjustedStart = selStart + leadingTrim;
  const selEnd = adjustedStart + text.length;

  const contextBefore = fullText.slice(Math.max(0, adjustedStart - 40), adjustedStart);
  const contextAfter = fullText.slice(selEnd, selEnd + 40);

  const rect = range.getBoundingClientRect();

  return {
    text,
    html: buildRangeHtml(range, containerEl) ?? undefined,
    rect,
    contextBefore,
    contextAfter,
    offset: adjustedStart,
  };
}
