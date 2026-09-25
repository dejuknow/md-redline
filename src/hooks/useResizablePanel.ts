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
  // The pointer that started the current drag. Filtering moves and endings on
  // it (below) stops a stray second pointer from steering a drag it didn't
  // start; the separate in-flight guard in onPointerDown (bailing when
  // `dragging.current` is already set) is what stops that second pointer from
  // starting its own drag in the first place, since the id filter alone only
  // protects a drag that has already begun.
  const activePointerId = useRef<number | null>(null);
  const startX = useRef(0);
  const startWidth = useRef(0);

  const persist = useCallback((w: PanelWidths) => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(w));
    } catch {
      /* ignore */
    }
  }, []);

  const onPointerDown = useCallback(
    (panel: 'explorer' | 'sidebar' | 'mermaidPanel') => (e: React.PointerEvent<HTMLDivElement>) => {
      // Primary pointer and primary button only, and only while nothing
      // else is already dragging a divider. Without the in-flight guard, a
      // second finger landing on the other divider mid-drag would overwrite
      // this state out from under the first, the same race #35 found with
      // two fingers on the anchor handles.
      if (!e.isPrimary || e.button !== 0 || dragging.current) return;
      // Cancelled for every pointer type: it keeps a touch from turning into
      // a scroll, and for a mouse it keeps focus in the field being edited
      // (the e2e spec pins that) and stops a text selection starting.
      e.preventDefault();
      dragging.current = panel;
      activePointerId.current = e.pointerId;
      setIsDragging(true);
      startX.current = e.clientX;
      startWidth.current = widths[panel];
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      // Captured only now that the drag has actually started, and inside a
      // try. Capturing before the guards above pass would pin a declined
      // gesture (a right-press, a second finger) to this divider instead of
      // letting it fall through untouched; a plain assignment would throw
      // and abort the handler if the pointer is already gone by the time
      // capture runs.
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // NotFoundError when the pointer is already gone. The drag still
        // runs off the document listeners below; capture only makes it
        // survive leaving this 1px line before release, so losing it is a
        // degradation, not a failure.
      }
    },
    [widths],
  );

  useEffect(() => {
    // One teardown for every ending, because four separate copies is exactly
    // how a fifth ending gets forgotten. There are four here: released,
    // cancelled, capture lost, and unmounted (handled inline in the effect
    // cleanup below, since it can't call back into this closure once torn
    // down). Unlike the anchor drag handles there's no fifth Escape-to-revert
    // ending: a resize has no prior document state to roll back, only a width
    // that already tracks wherever the pointer last was, so every ending
    // below does the same thing.
    const endDrag = () => {
      dragging.current = null;
      activePointerId.current = null;
      setIsDragging(false);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    // A gesture that ends without a release was not a choice: put the width
    // back where the drag found it, so the screen and saved width agree. Left
    // in place, it showed a width a reload would undo, or that the next,
    // unrelated drag would save along with its own.
    const revertAndEnd = () => {
      const panel = dragging.current;
      if (panel) setWidths((prev) => ({ ...prev, [panel]: startWidth.current }));
      endDrag();
    };

    const onPointerMove = (e: PointerEvent) => {
      const panel = dragging.current;
      if (!panel || e.pointerId !== activePointerId.current) return;

      // Right-edge panels (sidebar, mermaidPanel) grow when dragged leftward;
      // left-edge panels (explorer) grow when dragged rightward.
      const delta = panel === 'explorer' ? e.clientX - startX.current : startX.current - e.clientX;

      const newWidth = clamp(startWidth.current + delta, MIN_WIDTHS[panel], MAX_WIDTHS[panel]);

      setWidths((prev) => ({ ...prev, [panel]: newWidth }));
    };

    const onPointerUp = (e: PointerEvent) => {
      if (!dragging.current || e.pointerId !== activePointerId.current) return;
      endDrag();
      setWidths((prev) => {
        persist(prev);
        return prev;
      });
    };

    // Touch fires this for a gesture the system took away (a palm landed, an
    // edge swipe started, the browser reclaimed it for scrolling), which a
    // mouse effectively never does. The width goes back to where the drag
    // began; see revertAndEnd.
    const onPointerCancel = (e: PointerEvent) => {
      if (!dragging.current || e.pointerId !== activePointerId.current) return;
      revertAndEnd();
    };

    // Fires when the capturing divider leaves the DOM mid-drag (the explorer
    // pane or the mermaid panel collapsing out from under it) rather than
    // `pointercancel`, and pointer events keep arriving at the document
    // afterwards. Without this the drag stayed "on": the cursor and
    // user-select styles stuck, and whatever pointer event arrived next kept
    // resizing a panel that no longer has a divider to drag.
    const onLostPointerCapture = (e: PointerEvent) => {
      if (!dragging.current || e.pointerId !== activePointerId.current) return;
      revertAndEnd();
    };

    document.addEventListener('pointermove', onPointerMove);
    document.addEventListener('pointerup', onPointerUp);
    document.addEventListener('pointercancel', onPointerCancel);
    document.addEventListener('lostpointercapture', onLostPointerCapture);
    return () => {
      document.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('pointerup', onPointerUp);
      document.removeEventListener('pointercancel', onPointerCancel);
      document.removeEventListener('lostpointercapture', onLostPointerCapture);
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
    onResizeStart: onPointerDown,
    isDragging,
  };
}
