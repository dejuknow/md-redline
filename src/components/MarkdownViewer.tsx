import { memo, useRef, useLayoutEffect, forwardRef, useImperativeHandle } from 'react';
import type { MdComment } from '../types';
import { getEffectiveStatus } from '../types';

interface Props {
  html: string;
  comments: MdComment[];
  activeCommentId: string | null;
  selectionText: string | null;
  selectionOffset: number | null;
  onHighlightClick: (commentId: string) => void;
}

export interface MarkdownViewerHandle {
  getContainer: () => HTMLElement | null;
  scrollToComment: (commentId: string) => void;
  getActiveMark: () => HTMLElement | null;
  getActiveMarks: () => HTMLElement[];
}

// React.memo prevents re-renders from parent state changes that don't affect our props.
// Combined with ref-based innerHTML (no dangerouslySetInnerHTML), React never touches
// the container's children — our useLayoutEffect is the sole DOM manager.
export const MarkdownViewer = memo(
  forwardRef<MarkdownViewerHandle, Props>(function MarkdownViewer(
    { html, comments, activeCommentId, selectionText, selectionOffset, onHighlightClick },
    ref,
  ) {
    const containerRef = useRef<HTMLDivElement>(null);
    const activeMarkRef = useRef<HTMLElement | null>(null);

    useImperativeHandle(ref, () => ({
      getContainer: () => containerRef.current,
      scrollToComment: (commentId: string) => {
        if (!containerRef.current) return;
        const marks = containerRef.current.querySelectorAll('mark.comment-highlight');
        const mark = Array.from(marks).find((m) =>
          (m as HTMLElement).dataset.commentIds?.split(',').includes(commentId),
        );
        if (mark) {
          mark.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      },
      getActiveMark: () => activeMarkRef.current,
      getActiveMarks: () => {
        if (!containerRef.current) return [];
        return Array.from(
          containerRef.current.querySelectorAll('mark.comment-highlight-active'),
        ) as HTMLElement[];
      },
    }));

    // Set innerHTML and apply highlights after React commits.
    // We manage innerHTML ourselves (no dangerouslySetInnerHTML) so React's
    // reconciliation never interferes with our DOM modifications.
    useLayoutEffect(() => {
      const container = containerRef.current;
      if (!container) return;

      // Set innerHTML from scratch — guarantees a clean starting state
      container.innerHTML = html;

      // --- Comment highlights ---
      // Group comments that share the same anchor AND cleanOffset (exact same highlight)
      const highlightGroups = new Map<
        string,
        { ids: string[]; anchor: string; cleanOffset?: number }
      >();
      for (const comment of comments) {
        if (getEffectiveStatus(comment) === 'accepted') continue;
        const key = `${comment.cleanOffset ?? ''}:${comment.anchor}`;
        const group = highlightGroups.get(key) || {
          ids: [],
          anchor: comment.anchor,
          cleanOffset: comment.cleanOffset,
        };
        group.ids.push(comment.id);
        highlightGroups.set(key, group);
      }

      for (const { anchor, ids, cleanOffset } of highlightGroups.values()) {
        wrapText(
          container,
          anchor,
          (mark) => {
            mark.className = 'comment-highlight';
            mark.dataset.commentIds = ids.join(',');
            if (ids.includes(activeCommentId || '')) {
              mark.classList.add('comment-highlight-active');
            }
          },
          cleanOffset,
        );
      }

      // --- Selection highlight ---
      if (selectionText) {
        wrapText(
          container,
          selectionText,
          (mark) => {
            mark.className = 'selection-highlight';
          },
          selectionOffset ?? undefined,
        );
      }

      // Store reference to the active mark for drag handles
      activeMarkRef.current = container.querySelector(
        'mark.comment-highlight-active',
      ) as HTMLElement | null;
    }, [html, comments, activeCommentId, selectionText, selectionOffset]);

    const handleClick = (e: React.MouseEvent) => {
      const mark = (e.target as HTMLElement).closest(
        'mark.comment-highlight',
      ) as HTMLElement | null;
      if (mark?.dataset.commentIds) {
        const ids = mark.dataset.commentIds.split(',');
        onHighlightClick(ids[0]);
      }
    };

    return (
      <div
        ref={containerRef}
        className="prose max-w-none prose-headings:scroll-mt-4
          prose-h1:text-2xl prose-h1:font-bold prose-h1:border-b prose-h1:pb-2
          prose-h2:text-xl prose-h2:font-semibold prose-h2:mt-8
          prose-h3:text-lg prose-h3:font-medium
          prose-p:leading-relaxed
          prose-table:text-sm
          prose-th:font-semibold
          prose-code:rounded prose-code:px-1 prose-code:py-0.5 prose-code:text-sm prose-code:font-normal prose-code:before:content-none prose-code:after:content-none"
        onClick={handleClick}
      />
    );
  }),
);

/** Find an occurrence of `text` in the container's text nodes and wrap it in <mark> elements.
 *  When `cleanOffset` is provided, uses it to find the correct occurrence (supports overlapping).
 *  Handles text that spans multiple DOM elements (e.g. header -> paragraph). */
function wrapText(
  container: HTMLElement,
  text: string,
  configure: (mark: HTMLElement) => void,
  cleanOffset?: number,
) {
  // Collect ALL text nodes — include those inside marks to support overlapping highlights
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const allTextNodes: Text[] = [];
  let node: Text | null;
  while ((node = walker.nextNode() as Text | null)) {
    allTextNodes.push(node);
  }
  if (allTextNodes.length === 0) return;

  // Build concatenated text with position tracking (all nodes, for offset-based matching)
  const allNodeInfo: { node: Text; globalStart: number; length: number }[] = [];
  let allPos = 0;
  for (const tn of allTextNodes) {
    const len = tn.textContent?.length || 0;
    allNodeInfo.push({ node: tn, globalStart: allPos, length: len });
    allPos += len;
  }
  const fullText = allTextNodes.map((n) => n.textContent || '').join('');

  // Find the match
  let matchStart: number;
  let matchEnd: number;

  if (cleanOffset != null) {
    // Position-based: use cleanOffset to find the right occurrence.
    // The rendered text may differ from clean markdown (no ## / ** etc),
    // so search for the anchor text near the expected position.
    // When the anchor is drag-expanded backwards, it can start well before
    // cleanOffset (the marker stays put but the anchor grows leftward).
    // Use the anchor length as additional search window to handle this.
    const searchWindow = Math.max(20, text.length);
    const exactIdx = fullText.indexOf(text, Math.max(0, cleanOffset - searchWindow));
    if (exactIdx !== -1 && exactIdx <= cleanOffset + 20) {
      matchStart = exactIdx;
      matchEnd = exactIdx + text.length;
    } else {
      // Rendered text is shorter than clean markdown (heading markers, bold/italic
      // syntax, list markers etc. are stripped), so cleanOffset can overshoot the
      // actual position in fullText.  Find ALL occurrences and pick the closest.
      let bestIdx = -1;
      let bestDist = Infinity;
      let searchFrom = 0;
      while (searchFrom < fullText.length) {
        const idx = fullText.indexOf(text, searchFrom);
        if (idx === -1) break;
        const dist = Math.abs(idx - cleanOffset);
        if (dist < bestDist) {
          bestDist = dist;
          bestIdx = idx;
        }
        searchFrom = idx + 1;
      }
      if (bestIdx !== -1) {
        matchStart = bestIdx;
        matchEnd = bestIdx + text.length;
      } else {
        // Flexible whitespace fallback (no startFrom constraint)
        const result = flexibleSearch(fullText, text);
        if (!result) return;
        matchStart = result.start;
        matchEnd = result.end;
      }
    }
  } else {
    // No offset — first occurrence (used for selection highlights)
    const exactIdx = fullText.indexOf(text);
    if (exactIdx !== -1) {
      matchStart = exactIdx;
      matchEnd = exactIdx + text.length;
    } else {
      const result = flexibleSearch(fullText, text);
      if (!result) return;
      matchStart = result.start;
      matchEnd = result.end;
    }
  }

  // Determine which text nodes the match spans and their local offsets
  const wraps: { node: Text; start: number; end: number }[] = [];
  for (const info of allNodeInfo) {
    const nodeEnd = info.globalStart + info.length;
    if (nodeEnd <= matchStart || info.globalStart >= matchEnd) continue;
    const localStart = Math.max(0, matchStart - info.globalStart);
    const localEnd = Math.min(info.length, matchEnd - info.globalStart);
    if (localStart < localEnd) {
      wraps.push({ node: info.node, start: localStart, end: localEnd });
    }
  }
  if (wraps.length === 0) return;

  // Filter out whitespace-only portions
  const visibleWraps = wraps.filter(({ node: tn, start, end }) => {
    const slice = tn.textContent?.slice(start, end) || '';
    return slice.trim().length > 0;
  });
  if (visibleWraps.length === 0) return;

  // Group wraps by block parent so we merge wraps within the same block
  // (e.g. text nodes split by <strong>) into a single <mark>, while creating
  // separate marks for wraps in different blocks (e.g. different <li>s).
  const groups: { node: Text; start: number; end: number }[][] = [];
  let currentGroup: typeof groups[0] = [];
  let currentBlock: Element | null = null;

  for (const w of visibleWraps) {
    const block = getBlockParent(w.node);
    if (block !== currentBlock && currentGroup.length > 0) {
      groups.push(currentGroup);
      currentGroup = [];
    }
    currentBlock = block;
    currentGroup.push(w);
  }
  if (currentGroup.length > 0) groups.push(currentGroup);

  // Process each group in reverse to avoid invalidating earlier positions
  for (let g = groups.length - 1; g >= 0; g--) {
    const group = groups[g];
    if (group.length > 1) {
      // Multiple wraps in the same block — use Range to wrap them in a single
      // <mark>.  extractContents() splits partially-selected inline elements
      // (e.g. <strong>), preserving formatting while producing one mark (no seam).
      const mark = document.createElement('mark');
      configure(mark);

      const firstWrap = group[0];
      const lastWrap = group[group.length - 1];
      const range = document.createRange();
      range.setStart(firstWrap.node, firstWrap.start);
      range.setEnd(lastWrap.node, lastWrap.end);

      try {
        const fragment = range.extractContents();
        mark.appendChild(fragment);
        range.insertNode(mark);
      } catch {
        // Skip if extraction fails
      }
    } else {
      // Single wrap in this block — use surroundContents
      const { node: tn, start, end } = group[0];
      const range = document.createRange();
      range.setStart(tn, start);
      range.setEnd(tn, end);
      const mark = document.createElement('mark');
      configure(mark);
      try {
        range.surroundContents(mark);
      } catch {
        try {
          const fragment = range.extractContents();
          mark.appendChild(fragment);
          range.insertNode(mark);
        } catch {
          // Skip if all wrapping fails
        }
      }
    }
  }
}

const BLOCK_TAGS = new Set([
  'P', 'LI', 'DIV', 'BLOCKQUOTE', 'TD', 'TH', 'DD', 'DT',
  'PRE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'SECTION', 'ARTICLE',
]);

function getBlockParent(node: Node): Element | null {
  let el = node.parentElement;
  while (el) {
    if (BLOCK_TAGS.has(el.tagName)) return el;
    el = el.parentElement;
  }
  return null;
}

/**
 * Search for `needle` in `haystack` with flexible whitespace matching.
 * Whitespace runs in the needle can match zero or more whitespace chars in the haystack,
 * handling cross-element selections where sel.toString() adds newlines that aren't in text nodes.
 */
function flexibleSearch(
  haystack: string,
  needle: string,
  startFrom: number = 0,
): { start: number; end: number } | null {
  const parts = needle.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;
  if (parts.length === 1) {
    const idx = haystack.indexOf(parts[0], startFrom);
    return idx === -1 ? null : { start: idx, end: idx + parts[0].length };
  }

  let searchFrom = startFrom;
  while (searchFrom < haystack.length) {
    const firstIdx = haystack.indexOf(parts[0], searchFrom);
    if (firstIdx === -1) return null;

    let pos = firstIdx + parts[0].length;
    let matched = true;
    for (let i = 1; i < parts.length; i++) {
      // Skip optional whitespace between segments
      while (pos < haystack.length && /\s/.test(haystack[pos])) pos++;
      if (haystack.startsWith(parts[i], pos)) {
        pos += parts[i].length;
      } else {
        matched = false;
        break;
      }
    }
    if (matched) return { start: firstIdx, end: pos };
    searchFrom = firstIdx + 1;
  }
  return null;
}
