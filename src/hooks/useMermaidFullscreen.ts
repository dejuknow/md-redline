import { useCallback, useState } from 'react';
import type { MermaidBlockIdentity } from '../lib/mermaid-blocks';

export interface UseMermaidFullscreenResult {
  isOpen: boolean;
  activeSource: string | null;
  activeIdentity: MermaidBlockIdentity | null;
  /**
   * Zero-based index of the active diagram block among all Mermaid blocks in
   * the document, in source order. Lets consumers disambiguate two diagrams
   * with byte-identical sources.
   */
  activeBlockIndex: number | null;
  open: (source: string, blockIndex: number, identity?: MermaidBlockIdentity | null) => void;
  close: () => void;
}

export function useMermaidFullscreen(): UseMermaidFullscreenResult {
  const [active, setActive] = useState<{
    source: string;
    blockIndex: number;
    identity: MermaidBlockIdentity | null;
  } | null>(null);

  const open = useCallback(
    (source: string, blockIndex: number, identity?: MermaidBlockIdentity | null) => {
      setActive({ source, blockIndex, identity: identity ?? null });
    },
    [],
  );

  const close = useCallback(() => {
    setActive(null);
  }, []);

  return {
    isOpen: active !== null,
    activeSource: active?.source ?? null,
    activeIdentity: active?.identity ?? null,
    activeBlockIndex: active?.blockIndex ?? null,
    open,
    close,
  };
}
