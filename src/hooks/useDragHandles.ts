import { useState, useEffect, useCallback, useRef } from 'react';
import type { MarkdownViewerHandle } from '../components/MarkdownViewer';
import type { MdComment } from '../types';

interface Position {
  top: number;
  left: number;
  height: number;
}

interface HandlePositions {
  start: Position;
  end: Position;
}

interface UseDragHandlesOptions {
  viewerRef: React.RefObject<MarkdownViewerHandle | null>;
  scrollContainerRef: React.RefObject<HTMLElement | null>;
  activeCommentId: string | null;
  comments: MdComment[];
  onAnchorChange: (commentIds: string[], newAnchor: string) => void;
}

interface UseDragHandlesReturn {
  handlePositions: HandlePositions | null;
  isDragging: boolean;
  onHandleMouseDown: (handle: 'start' | 'end') => void;
}

function caretFromPoint(x: number, y: number): { node: Node; offset: number } | null {
  if ('caretPositionFromPoint' in document) {
    const pos = (
      document as unknown as {
        caretPositionFromPoint(x: number, y: number): { offsetNode: Node; offset: number } | null;
      }
    ).caretPositionFromPoint(x, y);
    if (pos) return { node: pos.offsetNode, offset: pos.offset };
  }
  if ('caretRangeFromPoint' in document) {
    const range = document.caretRangeFromPoint(x, y);
    if (range) return { node: range.startContainer, offset: range.startOffset };
  }
  return null;
}

function computePositions(
  markEls: HTMLElement[],
  scrollContainer: HTMLElement,
): HandlePositions | null {
  const allRects: DOMRect[] = [];
  for (const markEl of markEls) {
    const rects = markEl.getClientRects();
    for (let i = 0; i < rects.length; i++) {
      allRects.push(rects[i]);
    }
  }
  if (allRects.length === 0) return null;

  const containerRect = scrollContainer.getBoundingClientRect();
  const firstRect = allRects[0];
  const lastRect = allRects[allRects.length - 1];

  return {
    start: {
      top: firstRect.top - containerRect.top + scrollContainer.scrollTop,
      left: firstRect.left - containerRect.left + scrollContainer.scrollLeft,
      height: firstRect.height,
    },
    end: {
      top: lastRect.top - containerRect.top + scrollContainer.scrollTop,
      left: lastRect.right - containerRect.left + scrollContainer.scrollLeft,
      height: lastRect.height,
    },
  };
}

/** Get container-relative text offset for a node+offset pair */
function getContainerTextOffset(container: HTMLElement, targetNode: Node, offset: number): number {
  let total = 0;
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    if (node === targetNode) return total + offset;
    total += node.textContent?.length || 0;
  }
  return total;
}

export function useDragHandles({
  viewerRef,
  scrollContainerRef,
  activeCommentId,
  comments,
  onAnchorChange,
}: UseDragHandlesOptions): UseDragHandlesReturn {
  const [handlePositions, setHandlePositions] = useState<HandlePositions | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  // Refs for drag state (avoid stale closures in event handlers)
  const dragRef = useRef<{
    handle: 'start' | 'end';
    commentIds: string[];
    originalAnchor: string;
    // Container-relative text offsets for the fixed boundary
    fixedStartOffset: number;
    fixedEndOffset: number;
    // Current text offsets (updated during drag)
    currentStartOffset: number;
    currentEndOffset: number;
    markEls: HTMLElement[];
  } | null>(null);

  // Store drag listener cleanup so we can call it on unmount
  const dragCleanupRef = useRef<(() => void) | null>(null);

  // Compute handle positions when active comment changes
  const updatePositions = useCallback(() => {
    const markEls = viewerRef.current?.getActiveMarks() || [];
    const scrollContainer = scrollContainerRef.current;
    if (markEls.length === 0 || !scrollContainer) {
      setHandlePositions(null);
      return;
    }
    setHandlePositions(computePositions(markEls, scrollContainer));
  }, [viewerRef, scrollContainerRef]);

  // Recalculate positions when activeCommentId or comments change
  useEffect(() => {
    // Small delay to let useLayoutEffect in MarkdownViewer run first
    const raf = requestAnimationFrame(updatePositions);
    return () => cancelAnimationFrame(raf);
  }, [activeCommentId, comments, updatePositions]);

  // Recalculate on scroll and resize
  useEffect(() => {
    if (!activeCommentId) return;
    const scrollContainer = scrollContainerRef.current;
    if (!scrollContainer) return;

    const handler = () => {
      if (!dragRef.current) updatePositions();
    };
    scrollContainer.addEventListener('scroll', handler, { passive: true });
    window.addEventListener('resize', handler);
    return () => {
      scrollContainer.removeEventListener('scroll', handler);
      window.removeEventListener('resize', handler);
    };
  }, [activeCommentId, scrollContainerRef, updatePositions]);

  const onHandleMouseDown = useCallback(
    (handle: 'start' | 'end') => {
      const markEls = viewerRef.current?.getActiveMarks() || [];
      const container = viewerRef.current?.getContainer();
      if (markEls.length === 0 || !container) return;

      const commentIds = markEls[0].dataset.commentIds?.split(',') || [];

      // Find the mark's text boundaries across ALL active marks
      const firstMark = markEls[0];
      const lastMark = markEls[markEls.length - 1];

      const firstWalker = document.createTreeWalker(firstMark, NodeFilter.SHOW_TEXT);
      const firstTextNode = firstWalker.nextNode() as Text | null;

      const lastWalker = document.createTreeWalker(lastMark, NodeFilter.SHOW_TEXT);
      let lastTextNode: Text | null = null;
      let tn: Text | null;
      while ((tn = lastWalker.nextNode() as Text | null)) {
        lastTextNode = tn;
      }
      if (!lastTextNode) lastTextNode = firstTextNode;

      if (!firstTextNode || !lastTextNode) return;

      const startOffset = getContainerTextOffset(container, firstTextNode, 0);
      const endOffset = getContainerTextOffset(
        container,
        lastTextNode,
        lastTextNode.textContent?.length || 0,
      );
      const originalAnchor = (container.textContent || '').slice(startOffset, endOffset);

      dragRef.current = {
        handle,
        commentIds,
        originalAnchor,
        fixedStartOffset: startOffset,
        fixedEndOffset: endOffset,
        currentStartOffset: startOffset,
        currentEndOffset: endOffset,
        markEls,
      };

      setIsDragging(true);
      document.body.classList.add('anchor-dragging');

      const handleMouseMove = (e: MouseEvent) => {
        const drag = dragRef.current;
        if (!drag) return;

        const caret = caretFromPoint(e.clientX, e.clientY);
        if (!caret || !container.contains(caret.node)) return;

        // Don't allow dragging into another comment's mark
        const parentMark = (caret.node.parentElement as Element)?.closest?.('mark');
        if (
          parentMark &&
          !drag.markEls.some((m) => m.contains(caret.node)) &&
          !drag.markEls.includes(parentMark as HTMLElement)
        ) {
          return;
        }

        const caretOffset = getContainerTextOffset(container, caret.node, caret.offset);

        let newStartOffset: number;
        let newEndOffset: number;

        if (drag.handle === 'start') {
          newStartOffset = caretOffset;
          newEndOffset = drag.fixedEndOffset;
        } else {
          newStartOffset = drag.fixedStartOffset;
          newEndOffset = caretOffset;
        }

        // Ensure valid range
        if (newStartOffset >= newEndOffset) return;

        // Pre-validate text length before modifying DOM
        const fullText = container.textContent || '';
        const newText = fullText.slice(newStartOffset, newEndOffset);
        if (newText.length < 2) return;

        // Unwrap all active marks, preserving their children
        const oldMarks = container.querySelectorAll('mark.comment-highlight-active');
        oldMarks.forEach((oldMark) => {
          const parent = oldMark.parentNode;
          if (parent) {
            while (oldMark.firstChild) parent.insertBefore(oldMark.firstChild, oldMark);
            parent.removeChild(oldMark);
          }
        });
        if (oldMarks.length > 0) container.normalize();

        // Collect text node positions after normalize
        const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
        const nodeInfos: { node: Text; globalStart: number; length: number }[] = [];
        let pos = 0;
        let textNode: Text | null;
        while ((textNode = walker.nextNode() as Text | null)) {
          const len = textNode.textContent?.length || 0;
          nodeInfos.push({ node: textNode, globalStart: pos, length: len });
          pos += len;
        }

        // Find text nodes that overlap the new range
        const wraps: { node: Text; start: number; end: number }[] = [];
        for (const info of nodeInfos) {
          const nodeEnd = info.globalStart + info.length;
          if (nodeEnd <= newStartOffset || info.globalStart >= newEndOffset) continue;
          const localStart = Math.max(0, newStartOffset - info.globalStart);
          const localEnd = Math.min(info.length, newEndOffset - info.globalStart);
          if (localStart < localEnd) {
            const slice = info.node.textContent?.slice(localStart, localEnd) || '';
            if (slice.trim()) {
              wraps.push({ node: info.node, start: localStart, end: localEnd });
            }
          }
        }

        if (wraps.length === 0) return;

        // Wrap each portion in reverse order to avoid invalidating earlier nodes
        const newMarks: HTMLElement[] = [];
        for (let i = wraps.length - 1; i >= 0; i--) {
          const { node, start, end } = wraps[i];
          const range = document.createRange();
          range.setStart(node, start);
          range.setEnd(node, end);
          const mark = document.createElement('mark');
          mark.className = 'comment-highlight comment-highlight-active';
          mark.dataset.commentIds = drag.commentIds.join(',');
          try {
            range.surroundContents(mark);
            newMarks.unshift(mark);
          } catch {
            // Skip if wrapping fails
          }
        }

        if (newMarks.length > 0) {
          drag.markEls = newMarks;
          drag.currentStartOffset = newStartOffset;
          drag.currentEndOffset = newEndOffset;
        }

        // Update handle positions
        const scrollContainer = scrollContainerRef.current;
        if (scrollContainer && drag.markEls.length > 0) {
          const positions = computePositions(drag.markEls, scrollContainer);
          if (positions) setHandlePositions(positions);
        }
      };

      const handleMouseUp = () => {
        const drag = dragRef.current;
        if (drag) {
          // Use container text offsets to get the full anchor including whitespace
          // between styled elements that weren't wrapped in marks
          const newAnchor = (container.textContent || '').slice(
            drag.currentStartOffset,
            drag.currentEndOffset,
          );
          if (newAnchor.length >= 2 && newAnchor !== drag.originalAnchor) {
            onAnchorChange(drag.commentIds, newAnchor);
          }
        }

        dragRef.current = null;
        setIsDragging(false);
        document.body.classList.remove('anchor-dragging');
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
        document.removeEventListener('keydown', handleKeyDown);
        dragCleanupRef.current = null;
      };

      const handleKeyDown = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          dragRef.current = null;
          setIsDragging(false);
          document.body.classList.remove('anchor-dragging');
          document.removeEventListener('mousemove', handleMouseMove);
          document.removeEventListener('mouseup', handleMouseUp);
          document.removeEventListener('keydown', handleKeyDown);
          dragCleanupRef.current = null;
          updatePositions();
        }
      };

      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
      document.addEventListener('keydown', handleKeyDown);

      dragCleanupRef.current = () => {
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
        document.removeEventListener('keydown', handleKeyDown);
        document.body.classList.remove('anchor-dragging');
        dragRef.current = null;
      };
    },
    [viewerRef, scrollContainerRef, onAnchorChange, updatePositions],
  );

  // Clean up drag listeners on unmount
  useEffect(() => {
    return () => {
      dragCleanupRef.current?.();
    };
  }, []);

  return {
    handlePositions: activeCommentId ? handlePositions : null,
    isDragging,
    onHandleMouseDown,
  };
}
