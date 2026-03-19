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
      const anchorGroups = new Map<string, string[]>();
      for (const comment of comments) {
        if (comment.resolved) continue;
        const ids = anchorGroups.get(comment.anchor) || [];
        ids.push(comment.id);
        anchorGroups.set(comment.anchor, ids);
      }

      for (const [anchor, ids] of anchorGroups) {
        wrapText(container, anchor, (mark) => {
          mark.className = 'comment-highlight';
          mark.dataset.commentIds = ids.join(',');
          if (ids.includes(activeCommentId || '')) {
            mark.classList.add('comment-highlight-active');
          }
        });
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

/** Find the first occurrence of `text` in the container's text nodes and wrap it in a <mark>. */
function wrapText(
  container: HTMLElement,
  text: string,
  configure: (mark: HTMLElement) => void
) {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let node: Text | null;

  while ((node = walker.nextNode() as Text | null)) {
    // Skip nodes already inside a highlight mark
    if ((node.parentElement as Element)?.closest?.('mark')) continue;

    const nodeText = node.textContent || '';
    const idx = nodeText.indexOf(text);
    if (idx === -1) continue;

    const range = document.createRange();
    range.setStart(node, idx);
    range.setEnd(node, idx + text.length);

    const mark = document.createElement('mark');
    configure(mark);

    try {
      range.surroundContents(mark);
    } catch {
      continue;
    }

    return; // Only highlight first occurrence
  }
}
