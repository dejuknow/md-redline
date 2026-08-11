interface Position {
  top: number;
  left: number;
  height: number;
}

interface DragHandlesProps {
  startPos: Position | null;
  endPos: Position | null;
  onPointerDown: (handle: 'start' | 'end', pointerId: number) => void;
}

export function DragHandles({ startPos, endPos, onPointerDown }: DragHandlesProps) {
  if (!startPos || !endPos) return null;

  /**
   * Pointer events, not mouse events, because a touch never sends the latter.
   * iOS synthesises a `mousedown` on tap, so a mouse-only handle highlighted
   * and appeared to start dragging, then received no `mousemove` and no
   * `mouseup` for the rest of the gesture: dead, with nothing on screen to say
   * so. `PointerEvent` covers mouse, touch and pen in one path.
   *
   * The capture is what lets the drag survive the pointer leaving the handle,
   * which is the whole gesture. Events stay retargeted here and still bubble to
   * the document listeners the hook attaches.
   */
  const begin = (handle: 'start' | 'end') => (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    onPointerDown(handle, e.pointerId);
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
