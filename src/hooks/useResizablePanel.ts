import { useState, useCallback, useRef, useEffect } from 'react';

const STORAGE_KEY = 'md-redline-panel-widths';

interface PanelWidths {
  explorer: number;
  sidebar: number;
  mermaidPanel: number;
}

const DEFAULTS: PanelWidths = {
  explorer: 224, // w-56
  sidebar: 320, // w-80
  mermaidPanel: 320,
};

const MIN_WIDTHS: PanelWidths = {
  explorer: 160,
  sidebar: 240,
  mermaidPanel: 240,
};

const MAX_WIDTHS: PanelWidths = {
  explorer: 480,
  sidebar: 560,
  mermaidPanel: 560,
};

export function loadWidths(): PanelWidths {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    const parsed = JSON.parse(raw);
    return {
      explorer: clamp(
        parsed.explorer ?? DEFAULTS.explorer,
        MIN_WIDTHS.explorer,
        MAX_WIDTHS.explorer,
      ),
      sidebar: clamp(parsed.sidebar ?? DEFAULTS.sidebar, MIN_WIDTHS.sidebar, MAX_WIDTHS.sidebar),
      mermaidPanel: clamp(
        parsed.mermaidPanel ?? DEFAULTS.mermaidPanel,
        MIN_WIDTHS.mermaidPanel,
        MAX_WIDTHS.mermaidPanel,
      ),
    };
  } catch {
    return DEFAULTS;
  }
}

export function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function useResizablePanel() {
  const [widths, setWidths] = useState<PanelWidths>(loadWidths);
  const [isDragging, setIsDragging] = useState(false);
  const dragging = useRef<'explorer' | 'sidebar' | 'mermaidPanel' | null>(null);
  const startX = useRef(0);
  const startWidth = useRef(0);

  const persist = useCallback((w: PanelWidths) => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(w));
    } catch {
      /* ignore */
    }
  }, []);

  const onMouseDown = useCallback(
    (panel: 'explorer' | 'sidebar' | 'mermaidPanel', e: React.MouseEvent) => {
      e.preventDefault();
      dragging.current = panel;
      setIsDragging(true);
      startX.current = e.clientX;
      startWidth.current = widths[panel];
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    },
    [widths],
  );

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      const panel = dragging.current;
      if (!panel) return;

      // Right-edge panels (sidebar, mermaidPanel) grow when dragged leftward;
      // left-edge panels (explorer) grow when dragged rightward.
      const delta =
        panel === 'explorer' ? e.clientX - startX.current : startX.current - e.clientX;

      const newWidth = clamp(startWidth.current + delta, MIN_WIDTHS[panel], MAX_WIDTHS[panel]);

      setWidths((prev) => ({ ...prev, [panel]: newWidth }));
    };

    const onMouseUp = () => {
      if (!dragging.current) return;
      dragging.current = null;
      setIsDragging(false);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      setWidths((prev) => {
        persist(prev);
        return prev;
      });
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      // Clean up body styles if component unmounts mid-drag
      if (dragging.current) {
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      }
    };
  }, [persist]);

  return {
    explorerWidth: widths.explorer,
    sidebarWidth: widths.sidebar,
    mermaidPanelWidth: widths.mermaidPanel,
    onResizeStart: onMouseDown,
    isDragging,
  };
}
