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
    const pos = (document as any).caretPositionFromPoint(x, y);
    if (pos) return { node: pos.offsetNode, offset: pos.offset };
  }
  if ('caretRangeFromPoint' in document) {
    const range = (document as any).caretRangeFromPoint(x, y);
    if (range) return { node: range.startContainer, offset: range.startOffset };
  }
  return null;
}

function computePositions(
  markEl: HTMLElement,
  scrollContainer: HTMLElement
): HandlePositions | null {
  const rects = markEl.getClientRects();
  if (rects.length === 0) return null;

  const containerRect = scrollContainer.getBoundingClientRect();
  const firstRect = rects[0];
  const lastRect = rects[rects.length - 1];

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

/** Find text node + local offset from a container-relative text offset */
function nodeFromContainerOffset(container: HTMLElement, targetOffset: number): { node: Text; offset: number } | null {
  let total = 0;
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let node: Text | null;
  while ((node = walker.nextNode() as Text | null)) {
    const len = node.textContent?.length || 0;
    if (total + len >= targetOffset) {
      return { node, offset: targetOffset - total };
    }
    total += len;
  }
  return null;
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
    markEl: HTMLElement;
  } | null>(null);

  // Compute handle positions when active comment changes
  const updatePositions = useCallback(() => {
    const markEl = viewerRef.current?.getActiveMark();
    const scrollContainer = scrollContainerRef.current;
    if (!markEl || !scrollContainer) {
      setHandlePositions(null);
      return;
    }
    setHandlePositions(computePositions(markEl, scrollContainer));
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

  const onHandleMouseDown = useCallback((handle: 'start' | 'end') => {
    const markEl = viewerRef.current?.getActiveMark();
    const container = viewerRef.current?.getContainer();
    if (!markEl || !container) return;

    const commentIds = markEl.dataset.commentIds?.split(',') || [];
    const originalAnchor = markEl.textContent || '';

    // Find the mark's text boundaries in container-relative offsets
    const markWalker = document.createTreeWalker(markEl, NodeFilter.SHOW_TEXT);
    const firstTextNode = markWalker.nextNode() as Text | null;
    let lastTextNode = firstTextNode;
    let tn: Text | null;
    while ((tn = markWalker.nextNode() as Text | null)) {
      lastTextNode = tn;
    }

    if (!firstTextNode || !lastTextNode) return;

    const startOffset = getContainerTextOffset(container, firstTextNode, 0);
    const endOffset = getContainerTextOffset(container, lastTextNode, lastTextNode.textContent?.length || 0);

    dragRef.current = {
      handle,
      commentIds,
      originalAnchor,
      fixedStartOffset: startOffset,
      fixedEndOffset: endOffset,
      markEl,
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
      if (parentMark && !drag.markEl.contains(caret.node) && parentMark !== drag.markEl) {
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

      const startInfo = nodeFromContainerOffset(container, newStartOffset);
      const endInfo = nodeFromContainerOffset(container, newEndOffset);
      if (!startInfo || !endInfo) return;

      // Build a range and check text length
      const range = document.createRange();
      try {
        range.setStart(startInfo.node, startInfo.offset);
        range.setEnd(endInfo.node, endInfo.offset);
      } catch {
        return;
      }

      const newText = range.toString();
      if (newText.length < 2) return;

      // Unwrap the old mark, preserving its children
      const oldMark = container.querySelector('mark.comment-highlight-active');
      if (oldMark) {
        const parent = oldMark.parentNode;
        if (parent) {
          while (oldMark.firstChild) parent.insertBefore(oldMark.firstChild, oldMark);
          parent.removeChild(oldMark);
        }
        container.normalize();
      }

      // Re-find positions after normalize (text nodes may have merged)
      const newStart = nodeFromContainerOffset(container, newStartOffset);
      const newEnd = nodeFromContainerOffset(container, newEndOffset);
      if (!newStart || !newEnd) return;

      const newRange = document.createRange();
      try {
        newRange.setStart(newStart.node, newStart.offset);
        newRange.setEnd(newEnd.node, newEnd.offset);
      } catch {
        return;
      }

      // Wrap in a new mark
      try {
        const newMark = document.createElement('mark');
        newMark.className = 'comment-highlight comment-highlight-active';
        newMark.dataset.commentIds = drag.commentIds.join(',');
        newRange.surroundContents(newMark);
        drag.markEl = newMark;
      } catch {
        // Cross-element boundary — ignore this position
        return;
      }

      // Update handle positions
      const scrollContainer = scrollContainerRef.current;
      if (scrollContainer && drag.markEl) {
        const positions = computePositions(drag.markEl, scrollContainer);
        if (positions) setHandlePositions(positions);
      }
    };

    const handleMouseUp = () => {
      const drag = dragRef.current;
      if (drag) {
        const newAnchor = drag.markEl.textContent || '';
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
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        dragRef.current = null;
        setIsDragging(false);
        document.body.classList.remove('anchor-dragging');
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
        document.removeEventListener('keydown', handleKeyDown);
        updatePositions();
      }
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    document.addEventListener('keydown', handleKeyDown);
  }, [viewerRef, scrollContainerRef, onAnchorChange, updatePositions]);

  return {
    handlePositions: activeCommentId ? handlePositions : null,
    isDragging,
    onHandleMouseDown,
  };
}
