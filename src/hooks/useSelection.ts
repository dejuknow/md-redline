import { useState, useEffect, useCallback, useRef } from 'react';
import { resolveSelection } from '../lib/selection-resolver';
import { SELECTION_MARK_SELECTOR } from '../lib/selection-mark';
import { isSecondaryClick } from '../lib/platform';
import type { SelectionInfo } from '../types';

/**
 * @param escapeOwnedElsewhere Whether an overlay or menu is open, asked when
 *   Escape goes down. An Escape pressed while one is open is that layer's
 *   (it closes it), not a request to drop the selection (#100).
 */
export function useSelection(
  containerRef: React.RefObject<HTMLElement | null>,
  escapeOwnedElsewhere?: React.RefObject<() => boolean>,
) {
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
  // How many selections have been handed in from outside (adoptSelection):
  // a draft handed back, a context-menu snapshot. Escape's release checks it.
  const adoptCountRef = useRef(0);

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
      adoptCountRef.current += 1;
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

  /**
   * Release the lock and leave the selection where it is. For a composer that
   * gives way to the unavailable status on text the file cannot place: the
   * selection stays up under the status, and the next drag replaces it.
   */
  const unlockSelection = useCallback(() => {
    lockedRef.current = false;
  }, []);

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
    // The press that committed the current selection: its multi-click count
    // and the epoch right after the commit. handleMouseUp reads it to tell the
    // next press of the same double- or triple-click from a new gesture.
    let lastCommit: { epoch: number; detail: number } | null = null;
    const handlePointerDown = (e: PointerEvent) => {
      // A new gesture invalidates any timer armed by the previous one.
      epochRef.current += 1;
      if (e.pointerType) lastPointerType = e.pointerType;
      pointerInPreserved =
        (e.target as Element)?.closest?.(
          '[data-comment-form], [data-drag-handle], [data-preserve-selection]',
        ) != null;
    };

    // The press in progress, one per mousedown. Not per pointerdown: a second
    // button pressed while the first is held (a chord) fires mousedown but no
    // pointerdown, and must not be mistaken for the press it joins.
    //
    // WebKit on macOS never fires mouseup after a press that opened a context
    // menu, so for a right-click the mouseup handling runs from contextmenu
    // instead (settleRightClick), and the mouseup Chromium does send later is
    // skipped as a repeat. The repeat is matched by the press's button, not by
    // isSecondaryClick: a ctrl+click whose Ctrl comes up before the button
    // ends in a mouseup that no longer reads as secondary.
    let pressSeq = 0;
    let pressReleased = true;
    let settledByContextMenu = false;
    let pressButton = 0;
    // The native range when the press began, and the word WebKit selected in
    // its place, if it did (see routeRightClick).
    let rangeAtPress: Range | null = null;
    let droppedWord: Range | null = null;
    let fallbackSettle: ReturnType<typeof setTimeout> | undefined;

    const beginPress = (e: MouseEvent) => {
      pressSeq += 1;
      pressReleased = false;
      settledByContextMenu = false;
      pressButton = e.button;
      droppedWord = null;
      const sel = window.getSelection();
      rangeAtPress =
        sel && sel.rangeCount > 0 && !sel.isCollapsed ? sel.getRangeAt(0).cloneRange() : null;
    };

    const handleMouseUp = (e: MouseEvent) => {
      pressReleased = true;
      if (settledByContextMenu && e.button === pressButton) {
        settledByContextMenu = false;
        return;
      }
      settleMouseUp(e);
    };

    const settleRightClick = (e: MouseEvent) => {
      // Shift+secondary is the browser's menu, which the viewer leaves alone.
      // Settling here would commit the word WebKit selected for that menu.
      if (pressReleased || !isSecondaryClick(e) || e.shiftKey) return;
      pressReleased = true;
      settledByContextMenu = true;
      settleMouseUp(e);
    };

    const settleMouseUp = (e: MouseEvent) => {
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
      if (isSecondaryClick(e) && (e.target as HTMLElement)?.closest?.(SELECTION_MARK_SELECTOR)) {
        return;
      }
      // A locked selection ignores mouseups, except the next press of the
      // multi-click that committed it. A triple-click arrives as three presses:
      // the second commits a word, which quick comment locks as its composer
      // mounts, and the third widens the browser's highlight to the whole line.
      // Ignoring that press left the composer anchored to the word. `detail`
      // numbers the presses, and an epoch moved by exactly this press's
      // pointerdown means nothing else wrote a selection in between.
      const continuesCommit =
        lastCommit !== null &&
        e.detail >= 2 &&
        e.detail === lastCommit.detail + 1 &&
        epochRef.current === lastCommit.epoch + 1;
      if (lockedRef.current && !continuesCommit) return;
      if ((e.target as Element)?.closest?.('[data-comment-form]')) return;
      if ((e.target as Element)?.closest?.('[data-drag-handle]')) return;
      if ((e.target as Element)?.closest?.('[data-preserve-selection]')) return;
      if (document.body.classList.contains('anchor-dragging')) return;
      if (!containerRef.current) return;

      const info = resolveSelection(containerRef.current);
      // That press may replace a locked selection but never clear it, and the
      // lock carries over to the replacement: the composer does not remount,
      // so nothing would lock it again.
      if (lockedRef.current && !info) return;
      // Also clears any pending touch selection: the mouse gesture supersedes
      // it, whether it resolved to something or collapsed to nothing.
      commitSelection(info);
      lastCommit = info ? { epoch: epochRef.current, detail: e.detail } : null;
    };

    // An Escape pressed while an overlay or menu is open (Settings, search,
    // the palette, the drawer, a context menu) closes that layer and is not a
    // request to drop the selection: clearing it too discarded an expanded
    // comment draft along with it (#100). Asked in the capture phase on
    // window, before any handler runs and closes the layer (and so before one
    // can stop the event), and kept across auto-repeats until the key comes
    // up, since a held key's later repeats find nothing open.
    //
    // The comment form's field owns its Escape too: the form acts on keydown,
    // clearing an untouched template or cancelling, and clearing again here
    // closed the form a template had just been cleared from.
    //
    // And the release clears only the selection the key went down on. A held
    // Escape that closed one file's form could be released after a tab switch
    // had handed another file's draft back, and took that draft with it
    // (#196). Counted by adoptSelection, the way a draft comes back, and not
    // by the epoch: a touch selection settling while the key is down moves
    // that, and Escape should still clear it.
    let escapeOwned = false;
    let escapeDownEpoch: number | null = null;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // A fresh press starts over, in case the last one's release went to
      // another window.
      if (!e.repeat) {
        escapeDownEpoch = adoptCountRef.current;
        escapeOwned = false;
      }
      const target = e.target as Element | null;
      const inCommentField =
        target?.tagName === 'TEXTAREA' && target.closest?.('[data-comment-form]') != null;
      escapeOwned = escapeOwned || inCommentField || (escapeOwnedElsewhere?.current?.() ?? false);
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        const downEpoch = escapeDownEpoch;
        escapeDownEpoch = null;
        if (escapeOwned) {
          escapeOwned = false;
          return;
        }
        if (downEpoch !== null && adoptCountRef.current !== downEpoch) return;
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

    // On macOS, WebKit answers a right-click by selecting the word under the
    // cursor, before contextmenu reaches the page. That selection is the
    // browser's, not the reader's: the viewer took it for a right-click on the
    // reader's own selection, so a comment highlight opened no comment menu,
    // and the press then committed the word (#229). So while the click is
    // routed (this capture listener runs before the viewer's handlers) the
    // range the press began with is put back, or the selection collapses when
    // there was none. Browsers that select nothing on a right-click leave the
    // range as it was, so nothing happens there.
    //
    // The word is the browser's to use, though: Look Up and Copy in its own
    // menu act on it. finishRightClick gives it back when nothing claimed the
    // click for a menu of ours.
    const routeRightClick = (e: MouseEvent) => {
      if (!isSecondaryClick(e)) return;
      // Settle even when a handler stops the event before it reaches
      // finishRightClick (a link's own menu in a comment does). The guard in
      // settleRightClick makes this a no-op when finishRightClick ran.
      const seq = pressSeq;
      clearTimeout(fallbackSettle);
      fallbackSettle = setTimeout(() => {
        if (pressSeq === seq) settleRightClick(e);
      }, 0);
      // Shift asks for the browser's own menu, which acts on that word.
      if (e.shiftKey) return;
      const sel = window.getSelection();
      const container = containerRef.current;
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed || !container || !sel.anchorNode) return;
      if (!container.contains(sel.anchorNode)) return;
      const current = sel.getRangeAt(0);
      if (
        rangeAtPress &&
        current.compareBoundaryPoints(Range.START_TO_START, rangeAtPress) === 0 &&
        current.compareBoundaryPoints(Range.END_TO_END, rangeAtPress) === 0
      ) {
        return; // the reader's own selection, untouched by the press
      }
      droppedWord = current.cloneRange();
      if (rangeAtPress) {
        sel.removeAllRanges();
        sel.addRange(rangeAtPress);
      } else {
        sel.collapseToStart();
      }
    };

    // Bubble phase on document: after the viewer's own contextmenu handler,
    // the same order a mouseup arriving after the menu opens has.
    const finishRightClick = (e: MouseEvent) => {
      settleRightClick(e);
      // Nothing claimed the click, so the browser's menu opens: hand it back
      // the word it selected for that menu.
      if (droppedWord && !e.defaultPrevented) {
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(droppedWord);
      }
      droppedWord = null;
    };

    window.addEventListener('mousedown', beginPress, true);
    window.addEventListener('contextmenu', routeRightClick, true);
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('mouseup', handleMouseUp);
    document.addEventListener('contextmenu', finishRightClick);
    window.addEventListener('keydown', handleKeyDown, true);
    document.addEventListener('keyup', handleKeyUp);
    document.addEventListener('selectionchange', handleSelectionChange);
    // A key held as the window loses focus is released somewhere else.
    const handleBlur = () => {
      escapeOwned = false;
      escapeDownEpoch = null;
    };
    window.addEventListener('blur', handleBlur);
    return () => {
      window.removeEventListener('blur', handleBlur);
      window.removeEventListener('mousedown', beginPress, true);
      window.removeEventListener('contextmenu', routeRightClick, true);
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('mouseup', handleMouseUp);
      document.removeEventListener('contextmenu', finishRightClick);
      clearTimeout(fallbackSettle);
      window.removeEventListener('keydown', handleKeyDown, true);
      document.removeEventListener('keyup', handleKeyUp);
      document.removeEventListener('selectionchange', handleSelectionChange);
      clearTimeout(selectionDebounce);
    };
  }, [containerRef, commitSelection, capturePending, escapeOwnedElsewhere]);

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
    unlockSelection,
    adoptSelection,
    commitPendingSelection,
  };
}
