import { useCallback, useState } from 'react';

export interface UseMermaidFullscreenResult {
  isOpen: boolean;
  activeSource: string | null;
  /**
   * Zero-based index of the active diagram block among all Mermaid blocks in
   * the document, in source order. Lets consumers disambiguate two diagrams
   * with byte-identical sources.
   */
  activeBlockIndex: number | null;
  open: (source: string, blockIndex: number) => void;
  close: () => void;
}

export function useMermaidFullscreen(): UseMermaidFullscreenResult {
  const [active, setActive] = useState<{ source: string; blockIndex: number } | null>(null);

  const open = useCallback((source: string, blockIndex: number) => {
    setActive({ source, blockIndex });
  }, []);

  const close = useCallback(() => {
    setActive(null);
  }, []);

  return {
    isOpen: active !== null,
    activeSource: active?.source ?? null,
    activeBlockIndex: active?.blockIndex ?? null,
    open,
    close,
  };
}
