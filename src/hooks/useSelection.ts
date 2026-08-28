import { useState, useEffect, useCallback, useRef } from 'react';
import { resolveSelection } from '../lib/selection-resolver';
import { SELECTION_MARK_SELECTOR } from '../lib/selection-mark';
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
  // Mirrors `selection` for the event handlers, which run outside React's
  // render cycle and cannot read the state variable. Written synchronously by
  // commitSelection rather than by a passive effect: an effect lags a render,
  // and a selectionchange timer scheduled in that window used to be able to
  // leave both states non-null.
  const hasSelectionRef = useRef(false);
  // Bumped by every state write and every new pointerdown. A debounce timer
  // captures it when armed and bails if it changed, so a timer can only ever
  // apply to the gesture that armed it. Native handle drags emit no pointer
  // events and write nothing, so they leave it alone and their adjustments land.
  // This replaces a per-event "was something committed before this gesture"
  // snapshot, which could not distinguish a superseding gesture from the drag it
  // was meant to allow and so let a stale timer destroy a fresh mouse selection.
  const epochRef = useRef(0);

  // `selection` and `pendingSelection` are mutually exclusive by construction.
  // These two functions are the ONLY writers, and each clears the other, which
  // is what stops a stale pending selection from outliving the gesture that
  // produced it. Add a third writer and that guarantee is gone.
  //
  // capturePending: a fresh touch gesture supersedes an unlocked committed
  // selection exactly as a fresh mouse drag does.
  const capturePending = useCallback((info: SelectionInfo | null) => {
    epochRef.current += 1;
    hasSelectionRef.current = false;
    setSelection(null);
    pendingRef.current = info;
    setPendingSelection(info);
  }, []);

  // commitSelection: promotes to committed, or clears everything when passed null.
  const commitSelection = useCallback((info: SelectionInfo | null) => {
    epochRef.current += 1;
    pendingRef.current = null;
    setPendingSelection(null);
    hasSelectionRef.current = info !== null;
    setSelection(info);
  }, []);

  /**
   * Commit an already-resolved selection and lock it, because every caller is
   * about to act on it. The context menu builds its items from a snapshot taken
   * when the menu opened; locking live state instead means that if anything has
   * cleared the selection in between, `lockedRef` is set with nothing committed
   * and stays set, which silently ignores every later selection in the
   * document. Delegates to commitSelection, so the two-writer rule above holds.
   */
  const adoptSelection = useCallback(
    (info: SelectionInfo) => {
      commitSelection(info);
      lockedRef.current = true;
    },
    [commitSelection],
  );

  const clearSelection = useCallback(() => {
    lockedRef.current = false;
    commitSelection(null);
    window.getSelection()?.removeAllRanges();
  }, [commitSelection]);

  const commitPendingSelection = useCallback(() => {
    // No-op once something is already committed. onLock fires this on every
    // pill interaction, including for a selection that arrived by mouse, and
    // without this guard a touch selection left pending from an earlier
    // gesture would silently replace it and anchor the comment to the wrong
    // text.
    if (hasSelectionRef.current || !pendingRef.current) return;
    commitSelection(pendingRef.current);
  }, [commitSelection]);

  // Composed on purpose. Every consumer that locks a selection is starting a
  // comment on it, which means a pending touch selection has to be promoted
  // first. Offering a lock-only variant alongside is what let a second consumer
  // wire `onLock={lockSelection}` and silently lose touch commenting entirely,
  // so this hook does not expose one. Stable, because commitPendingSelection is.
  const lockSelection = useCallback(() => {
    commitPendingSelection();
    lockedRef.current = true;
  }, [commitPendingSelection]);

  useEffect(() => {
    // The pointerType of the most recent pointerdown decides which flow
    // handles the resulting selection: 'mouse' opens the form on mouseup as
    // before; 'touch' and 'pen' route through the pending flow. Tracked per
    // gesture (not per device) so hybrid devices — touchscreen laptops,
    // tablets with trackpads — get the right behavior for each interaction.
    let lastPointerType = 'mouse';
    // Whether the gesture in progress started inside something that must not
    // lose the selection: the pill, the comment form, a drag handle.
    let pointerInPreserved = false;
    const handlePointerDown = (e: PointerEvent) => {
      // A new gesture invalidates any timer armed by the previous one.
      epochRef.current += 1;
      if (e.pointerType) lastPointerType = e.pointerType;
      pointerInPreserved =
        (e.target as Element)?.closest?.(
          '[data-comment-form], [data-drag-handle], [data-preserve-selection]',
        ) != null;
    };

    const handleMouseUp = (e: MouseEvent) => {
      if (lastPointerType !== 'mouse') return;
      // A secondary press ON the selection is spared, and only there. That
      // gesture opens the viewer's context menu, whose items act on the
      // selection, and resolveSelection below would return null for it: the
      // viewer has painted the selection as a mark, which collapses the native
      // range. So this handler would destroy the selection the menu was opened
      // on. It also decouples that from event ordering, since Windows fires
      // contextmenu after mouseup rather than before it.
      //
      // Anywhere else a secondary press clears like any other click. Sparing
      // it everywhere leaves a stale selection committed with its pill floating
      // over unrelated text, and the next menu builds on that stale selection
      // rather than on what the reader pointed at.
      if (e.button !== 0 && (e.target as HTMLElement)?.closest?.(SELECTION_MARK_SELECTOR)) return;
      if (lockedRef.current) return;
      if ((e.target as Element)?.closest?.('[data-comment-form]')) return;
      if ((e.target as Element)?.closest?.('[data-drag-handle]')) return;
      if ((e.target as Element)?.closest?.('[data-preserve-selection]')) return;
      if (document.body.classList.contains('anchor-dragging')) return;
      if (!containerRef.current) return;

      const info = resolveSelection(containerRef.current);
      // Also clears any pending touch selection: the mouse gesture supersedes
      // it, whether it resolved to something or collapsed to nothing.
      commitSelection(info);
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        lockedRef.current = false;
        commitSelection(null);
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
      // Only a LOCKED selection blocks capture. An unlocked committed selection
      // is just a pill showing, and a new touch gesture supersedes it the same
      // way a new mouse drag does. Gating on hasSelectionRef here dropped every
      // touch selection made while a mouse pill was up, silently, with the stale
      // pill left floating over the old text.
      if (lockedRef.current) return;
      const armedEpoch = epochRef.current;
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
        // Re-read the ref inside the timer: the guard above ran 150ms ago and
        // the container can unmount in between (tab close, view switch), which
        // a non-null assertion here would turn into a throw in a stray timeout.
        const container = containerRef.current;
        if (!container) return;
        // Re-check inside the callback, not only before scheduling: a commit or
        // a lock landing during the 150ms window would otherwise let this write
        // pendingSelection while a selection is already committed.
        if (lockedRef.current) return;
        // Anything that wrote state or started a new gesture since this timer
        // was armed supersedes it.
        if (epochRef.current !== armedEpoch) return;
        const info = resolveSelection(container);
        // The tap that engages the pill collapses the native selection. Dropping
        // pending then would leave the commit nothing to promote. But this must
        // not veto a real adjustment: handle drags emit no pointerdown here,
        // because DragHandles stops it, so the flag is still set from that tap
        // long after it mattered.
        if (info === null && pointerInPreserved) return;
        capturePending(info);
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
  }, [containerRef, commitSelection, capturePending]);

  return {
    selection,
    pendingSelection,
    // The derived pair every consumer needs. Hand-rolling these at each call
    // site is how the Mermaid fullscreen modal ended up reading `selection`
    // alone and losing touch commenting without any error.
    commentSelection: selection ?? pendingSelection,
    isPending: !selection && pendingSelection !== null,
    clearSelection,
    lockSelection,
    adoptSelection,
    commitPendingSelection,
  };
}
