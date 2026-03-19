import { memo, useRef, useLayoutEffect, forwardRef, useImperativeHandle } from 'react';
import type { MdComment } from '../types';

interface Props {
  html: string;
  comments: MdComment[];
  activeCommentId: string | null;
  selectionText: string | null;
  onHighlightClick: (commentId: string) => void;
}

export interface MarkdownViewerHandle {
  getContainer: () => HTMLElement | null;
  scrollToComment: (commentId: string) => void;
  getActiveMark: () => HTMLElement | null;
}

// React.memo prevents re-renders from parent state changes (e.g. saveFile → setLastSaved)
// that don't affect our props. Without this, React would re-render the component,
// detect that dangerouslySetInnerHTML's DOM was modified by our useLayoutEffect marks,
// replace the entire innerHTML, and our marks would be destroyed — but the effect
// wouldn't re-run because its deps haven't changed.
export const MarkdownViewer = memo(forwardRef<MarkdownViewerHandle, Props>(
  function MarkdownViewer({ html, comments, activeCommentId, selectionText, onHighlightClick }, ref) {
    const containerRef = useRef<HTMLDivElement>(null);
    const activeMarkRef = useRef<HTMLElement | null>(null);

    useImperativeHandle(ref, () => ({
      getContainer: () => containerRef.current,
      scrollToComment: (commentId: string) => {
        const mark = containerRef.current?.querySelector(
          `mark[data-comment-id="${commentId}"]`
        );
        if (mark) {
          mark.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      },
      getActiveMark: () => activeMarkRef.current,
    }));

    // Apply all highlights after React commits the innerHTML.
    // This runs AFTER React's DOM update, so we're working with fresh nodes.
    useLayoutEffect(() => {
      const container = containerRef.current;
      if (!container) return;

      // --- Clear all previous highlights ---
      // React may not replace innerHTML if the html prop hasn't changed,
      // so stale marks from the last effect run can linger.
      container.querySelectorAll('mark.comment-highlight, mark.selection-highlight').forEach((mark) => {
        const parent = mark.parentNode;
        if (!parent) return;
        while (mark.firstChild) {
          parent.insertBefore(mark.firstChild, mark);
        }
        parent.removeChild(mark);
      });
      // Merge adjacent text nodes that were split by the old marks
      container.normalize();

      // --- Comment highlights ---
      // Group comments that share the same anchor AND cleanOffset (exact same highlight)
      const highlightGroups = new Map<string, { ids: string[]; anchor: string; cleanOffset?: number }>();
      for (const comment of comments) {
        if (comment.resolved) continue;
        const key = `${comment.cleanOffset ?? ''}:${comment.anchor}`;
        const group = highlightGroups.get(key) || { ids: [], anchor: comment.anchor, cleanOffset: comment.cleanOffset };
        group.ids.push(comment.id);
        highlightGroups.set(key, group);
      }

      for (const { anchor, ids, cleanOffset } of highlightGroups.values()) {
        wrapText(container, anchor, (mark) => {
          mark.className = 'comment-highlight';
          mark.dataset.commentIds = ids.join(',');
          if (ids.includes(activeCommentId || '')) {
            mark.classList.add('comment-highlight-active');
          }
        }, cleanOffset);
      }

      // --- Selection highlight ---
      if (selectionText) {
        wrapText(container, selectionText, (mark) => {
          mark.className = 'selection-highlight';
        });
      }

      // Store reference to the active mark for drag handles
      activeMarkRef.current = container.querySelector('mark.comment-highlight-active') as HTMLElement | null;
    }, [html, comments, activeCommentId, selectionText]);

    const handleClick = (e: React.MouseEvent) => {
      const mark = (e.target as HTMLElement).closest(
        'mark.comment-highlight'
      ) as HTMLElement | null;
      if (mark?.dataset.commentIds) {
        const ids = mark.dataset.commentIds.split(',');
        onHighlightClick(ids[0]);
      }
    };

    return (
      <div
        ref={containerRef}
        className="prose prose-slate max-w-none prose-headings:scroll-mt-4
          prose-h1:text-2xl prose-h1:font-bold prose-h1:border-b prose-h1:border-slate-200 prose-h1:pb-2
          prose-h2:text-xl prose-h2:font-semibold prose-h2:mt-8
          prose-h3:text-lg prose-h3:font-medium
          prose-p:leading-relaxed
          prose-table:text-sm
          prose-th:bg-slate-50 prose-th:font-semibold
          prose-td:border-slate-200
          prose-code:text-indigo-600 prose-code:bg-indigo-50 prose-code:rounded prose-code:px-1 prose-code:py-0.5 prose-code:text-sm prose-code:font-normal prose-code:before:content-none prose-code:after:content-none"
        dangerouslySetInnerHTML={{ __html: html }}
        onClick={handleClick}
      />
    );
  }
));

/** Find an occurrence of `text` in the container's text nodes and wrap it in <mark> elements.
 *  When `cleanOffset` is provided, uses it to find the correct occurrence (supports overlapping).
 *  Handles text that spans multiple DOM elements (e.g. header → paragraph). */
function wrapText(
  container: HTMLElement,
  text: string,
  configure: (mark: HTMLElement) => void,
  cleanOffset?: number
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
  const fullText = allTextNodes.map(n => n.textContent || '').join('');

  // Find the match
  let matchStart: number;
  let matchEnd: number;

  if (cleanOffset != null) {
    // Position-based: use cleanOffset to find the right occurrence.
    // The rendered text may differ from clean markdown (no ## / ** etc),
    // so search for the anchor text near the expected position.
    const exactIdx = fullText.indexOf(text, Math.max(0, cleanOffset - 20));
    if (exactIdx !== -1 && exactIdx <= cleanOffset + 20) {
      matchStart = exactIdx;
      matchEnd = exactIdx + text.length;
    } else {
      // Flexible fallback near the offset
      const result = flexibleSearch(fullText, text, Math.max(0, cleanOffset - 50));
      if (!result) return;
      matchStart = result.start;
      matchEnd = result.end;
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

  // Wrap matched portions — process in reverse to avoid invalidating earlier nodes
  for (let i = wraps.length - 1; i >= 0; i--) {
    const { node: tn, start, end } = wraps[i];
    // Skip whitespace-only portions (e.g. newline nodes between block elements)
    const slice = tn.textContent?.slice(start, end) || '';
    if (!slice.trim()) continue;
    const range = document.createRange();
    range.setStart(tn, start);
    range.setEnd(tn, end);
    const mark = document.createElement('mark');
    configure(mark);
    try {
      range.surroundContents(mark);
    } catch {
      // Skip if wrapping fails
    }
  }
}

/**
 * Search for `needle` in `haystack` with flexible whitespace matching.
 * Whitespace runs in the needle can match zero or more whitespace chars in the haystack,
 * handling cross-element selections where sel.toString() adds newlines that aren't in text nodes.
 */
function flexibleSearch(
  haystack: string,
  needle: string,
  startFrom: number = 0
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
