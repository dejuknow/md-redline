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

    // Close when the user scrolls the surface away from the menu's anchor.
    // We listen for the user's scroll *gestures* (wheel/touchmove) rather than
    // the `scroll` event, because `scroll` also fires for programmatic and
    // browser-driven scrolls: opening the menu re-renders the app, and the
    // browser's scroll-anchoring nudges the document container by a pixel or
    // two, which would otherwise dismiss the menu the instant it appears.
    const handleUserScroll = () => close();

    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('wheel', handleUserScroll, { capture: true, passive: true });
    document.addEventListener('touchmove', handleUserScroll, { capture: true, passive: true });

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('wheel', handleUserScroll, { capture: true });
      document.removeEventListener('touchmove', handleUserScroll, { capture: true });
    };
  }, [state.isOpen, close]);

  return { ...state, open, close };
}
