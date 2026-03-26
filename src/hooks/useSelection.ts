import { useState, useEffect, useCallback, useRef } from 'react';
import { resolveSelection } from '../lib/selection-resolver';
import type { SelectionInfo } from '../types';

export function useSelection(containerRef: React.RefObject<HTMLElement | null>) {
  const [selection, setSelection] = useState<SelectionInfo | null>(null);
  const lockedRef = useRef(false);

  const lockSelection = useCallback(() => {
    lockedRef.current = true;
  }, []);

  const clearSelection = useCallback(() => {
    lockedRef.current = false;
    setSelection(null);
    window.getSelection()?.removeAllRanges();
  }, []);

  useEffect(() => {
    const handleMouseUp = (e: MouseEvent) => {
      if (lockedRef.current) return;
      if ((e.target as Element)?.closest?.('[data-comment-form]')) return;
      if ((e.target as Element)?.closest?.('[data-drag-handle]')) return;
      if (document.body.classList.contains('anchor-dragging')) return;
      if (!containerRef.current) return;

      const info = resolveSelection(containerRef.current);
      setSelection(info);
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        lockedRef.current = false;
        setSelection(null);
        window.getSelection()?.removeAllRanges();
      }
    };

    document.addEventListener('mouseup', handleMouseUp);
    document.addEventListener('keyup', handleKeyUp);
    return () => {
      document.removeEventListener('mouseup', handleMouseUp);
      document.removeEventListener('keyup', handleKeyUp);
    };
  }, [containerRef]);

  return { selection, clearSelection, lockSelection };
}
