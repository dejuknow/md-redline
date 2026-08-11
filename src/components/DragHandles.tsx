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

    // Both. The stopPropagation is kept on reasoning, not measurement: the
    // first thing `useSelection`'s document listener does is bump a gesture
    // epoch that invalidates any in-flight selection timer, and a press on a
    // drag handle is not a new selection gesture. That listener was written for
    // a world where handles emit no pointerdown, and this keeps it true rather
    // than half-changing it.
    //
    // A code review argued the opposite, since the same listener names
    // [data-drag-handle] in the selector deciding which gestures may keep the
    // current selection, so stopping the event looks like starving it. That
    // concern is real and unresolved: see the linked issue. Both arrangements
    // pass 20 consecutive runs of the heaviest insertion spec, so nothing here
    // is settled by a flake rate.
    e.preventDefault();
    e.stopPropagation();

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
