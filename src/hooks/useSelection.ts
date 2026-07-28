import { useState, useEffect, useCallback, useRef } from 'react';
import { resolveSelection } from '../lib/selection-resolver';
import type { SelectionInfo } from '../types';

export function useSelection(containerRef: React.RefObject<HTMLElement | null>) {
  const [selection, setSelection] = useState<SelectionInfo | null>(null);
  // Selections made by touch or pen are captured here instead of opening the
  // comment form directly. Native selection-handle drags happen in browser
  // chrome and emit no pointer events the page can see, so no timer can
  // distinguish "paused to think" from "done adjusting" — the form opens only
  // when the user commits explicitly (the floating Comment button). Mouse
  // selections keep the immediate-open behavior.
  const [pendingSelection, setPendingSelection] = useState<SelectionInfo | null>(null);
  const lockedRef = useRef(false);
  const pendingRef = useRef<SelectionInfo | null>(null);
  const hasSelectionRef = useRef(false);

  useEffect(() => {
    hasSelectionRef.current = selection !== null;
  }, [selection]);

  const lockSelection = useCallback(() => {
    lockedRef.current = true;
  }, []);

  const clearSelection = useCallback(() => {
    lockedRef.current = false;
    pendingRef.current = null;
    setPendingSelection(null);
    setSelection(null);
    window.getSelection()?.removeAllRanges();
  }, []);

  const commitPendingSelection = useCallback(() => {
    if (!pendingRef.current) return;
    setSelection(pendingRef.current);
    pendingRef.current = null;
    setPendingSelection(null);
  }, []);

  useEffect(() => {
    // The pointerType of the most recent pointerdown decides which flow
    // handles the resulting selection: 'mouse' opens the form on mouseup as
    // before; 'touch' and 'pen' route through the pending flow. Tracked per
    // gesture (not per device) so hybrid devices — touchscreen laptops,
    // tablets with trackpads — get the right behavior for each interaction.
    let lastPointerType = 'mouse';
    const handlePointerDown = (e: PointerEvent) => {
      if (e.pointerType) lastPointerType = e.pointerType;
    };

    const handleMouseUp = (e: MouseEvent) => {
      if (lastPointerType !== 'mouse') return;
      if (lockedRef.current) return;
      if ((e.target as Element)?.closest?.('[data-comment-form]')) return;
      if ((e.target as Element)?.closest?.('[data-drag-handle]')) return;
      if ((e.target as Element)?.closest?.('[data-preserve-selection]')) return;
      if (document.body.classList.contains('anchor-dragging')) return;
      if (!containerRef.current) return;

      const info = resolveSelection(containerRef.current);
      setSelection(info);
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        lockedRef.current = false;
        pendingRef.current = null;
        setPendingSelection(null);
        setSelection(null);
        window.getSelection()?.removeAllRanges();
      }
    };

    // Touch/pen selection never fires mouseup, so watch selectionchange. The
    // short debounce only coalesces the event stream during a handle drag —
    // it does not gate the UI, since the pending selection just enables the
    // commit button rather than opening anything.
    let selectionDebounce: ReturnType<typeof setTimeout> | undefined;
    const handleSelectionChange = () => {
      if (lastPointerType === 'mouse') return;
      if (lockedRef.current || hasSelectionRef.current) return;
      if (document.body.classList.contains('anchor-dragging')) return;
      if (!containerRef.current) return;
      clearTimeout(selectionDebounce);
      selectionDebounce = setTimeout(() => {
        const anchorNode = window.getSelection()?.anchorNode;
        const anchorEl = anchorNode instanceof Element ? anchorNode : anchorNode?.parentElement;
        if (
          anchorEl?.closest?.('[data-comment-form], [data-drag-handle], [data-preserve-selection]')
        )
          return;
        const info = resolveSelection(containerRef.current!);
        pendingRef.current = info;
        setPendingSelection(info);
      }, 150);
    };

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('mouseup', handleMouseUp);
    document.addEventListener('keyup', handleKeyUp);
    document.addEventListener('selectionchange', handleSelectionChange);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('mouseup', handleMouseUp);
      document.removeEventListener('keyup', handleKeyUp);
      document.removeEventListener('selectionchange', handleSelectionChange);
      clearTimeout(selectionDebounce);
    };
  }, [containerRef]);

  return { selection, pendingSelection, clearSelection, lockSelection, commitPendingSelection };
}
