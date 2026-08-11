interface Position {
  top: number;
  left: number;
  height: number;
}

interface DragHandlesProps {
  startPos: Position | null;
  endPos: Position | null;
  /** Returns whether a drag began; capture is taken only then. */
  onPointerDown: (handle: 'start' | 'end', pointerId: number) => boolean;
}

export function DragHandles({ startPos, endPos, onPointerDown }: DragHandlesProps) {
  if (!startPos || !endPos) return null;

  /**
   * Pointer events, not mouse events, because a touch never sends the latter.
   * iOS synthesises a `mousedown` on tap, so a mouse-only handle highlighted
   * and appeared to start dragging, then received no `mousemove` and no
   * `mouseup` for the rest of the gesture: dead, with nothing on screen to say
   * so. `PointerEvent` covers mouse, touch and pen in one path.
   */
  const begin = (handle: 'start' | 'end') => (e: React.PointerEvent<HTMLDivElement>) => {
    // Primary button, primary pointer. A right-press used to start a real drag
    // and take capture; on a platform whose context menu swallows the release
    // that left the drag live, and since a mouse reuses one pointerId, bare
    // movement afterwards went on re-anchoring the comment with nothing held.
    if (!e.isPrimary || e.button !== 0) return;

    // preventDefault, but deliberately NOT stopPropagation. `useSelection`
    // listens for pointerdown on the document and names [data-drag-handle] in
    // the selector that decides whether a gesture may keep the current
    // selection; stopping it here starved that listener of the one event it
    // most needs, leaving its gesture epoch unbumped and its
    // preserved-selection flag stale. Suppressing the compatibility mousedown
    // is preventDefault's job and it still does it.
    e.preventDefault();

    // Only capture once the drag is really running. Capturing first left a
    // pointer pinned to a handle that had declined the gesture, and with
    // touch-action none on that element the finger could neither drag nor
    // scroll until it lifted.
    if (!onPointerDown(handle, e.pointerId)) return;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // NotFoundError when the pointer is already gone. The drag keeps working
      // off the document listeners; capture only makes it survive leaving the
      // element, so losing it is a degradation and not a failure.
    }
  };

  return (
    <>
      <div
        className="drag-handle"
        style={{
          top: startPos.top,
          left: startPos.left - 2,
          height: startPos.height,
        }}
        onPointerDown={begin('start')}
        data-drag-handle
      />
      <div
        className="drag-handle"
        style={{
          top: endPos.top,
          left: endPos.left - 2,
          height: endPos.height,
        }}
        onPointerDown={begin('end')}
        data-drag-handle
      />
    </>
  );
}
