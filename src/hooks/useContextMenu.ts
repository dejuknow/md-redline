import { useState, useCallback, useEffect } from 'react';

export interface ContextMenuState {
  isOpen: boolean;
  position: { x: number; y: number };
}

export function useContextMenu() {
  const [state, setState] = useState<ContextMenuState>({
    isOpen: false,
    position: { x: 0, y: 0 },
  });

  const open = useCallback((x: number, y: number) => {
    setState({ isOpen: true, position: { x, y } });
  }, []);

  const close = useCallback(() => {
    setState((prev) => ({ ...prev, isOpen: false }));
  }, []);

  // Close on Escape
  useEffect(() => {
    if (!state.isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
      }
    };

    const handleScroll = () => {
      close();
    };

    document.addEventListener('keydown', handleKeyDown);
    // Close on any scroll event (capture phase to catch scrollable containers)
    document.addEventListener('scroll', handleScroll, true);

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('scroll', handleScroll, true);
    };
  }, [state.isOpen, close]);

  return { ...state, open, close };
}
