interface Position {
  top: number;
  left: number;
  height: number;
}

interface DragHandlesProps {
  startPos: Position | null;
  endPos: Position | null;
  onMouseDown: (handle: 'start' | 'end') => void;
}

export function DragHandles({ startPos, endPos, onMouseDown }: DragHandlesProps) {
  if (!startPos || !endPos) return null;

  return (
    <>
      <div
        className="drag-handle"
        style={{
          top: startPos.top,
          left: startPos.left - 2,
          height: startPos.height,
        }}
        onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); onMouseDown('start'); }}
        data-drag-handle
      />
      <div
        className="drag-handle"
        style={{
          top: endPos.top,
          left: endPos.left - 2,
          height: endPos.height,
        }}
        onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); onMouseDown('end'); }}
        data-drag-handle
      />
    </>
  );
}
