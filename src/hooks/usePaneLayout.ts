import { useState, useCallback, useEffect, useRef } from 'react';
import type { ViewMode } from '../components/Toolbar';

export type LeftPanelView = 'explorer' | 'outline';
export type RailDensity = 'anchored' | 'list';

interface PaneLayout {
  explorerVisible: boolean;
  sidebarVisible: boolean;
  leftPanelView: LeftPanelView;
  viewMode: ViewMode;
  railDensity: RailDensity;
}

const STORAGE_KEY = 'md-redline-pane-layout';

const DEFAULTS: PaneLayout = {
  explorerVisible: true,
  sidebarVisible: true,
  leftPanelView: 'explorer',
  viewMode: 'rendered',
  railDensity: 'anchored',
};

export function load(): PaneLayout {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    const parsed = JSON.parse(raw);
    return {
      explorerVisible:
        typeof parsed.explorerVisible === 'boolean'
          ? parsed.explorerVisible
          : DEFAULTS.explorerVisible,
      sidebarVisible:
        typeof parsed.sidebarVisible === 'boolean'
          ? parsed.sidebarVisible
          : DEFAULTS.sidebarVisible,
      leftPanelView: parsed.leftPanelView === 'outline' ? 'outline' : 'explorer',
      viewMode: parsed.viewMode === 'raw' || parsed.viewMode === 'diff' ? 'raw' : 'rendered',
      railDensity: parsed.railDensity === 'list' ? 'list' : 'anchored',
    };
  } catch {
    return DEFAULTS;
  }
}

export function save(layout: PaneLayout) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
  } catch {
    /* ignore */
  }
}

export function usePaneLayout() {
  const [layout, setLayout] = useState<PaneLayout>(load);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  // Persist on every change
  useEffect(() => {
    save(layout);
  }, [layout]);

  const setExplorerVisible = useCallback((v: boolean | ((prev: boolean) => boolean)) => {
    setLayout((prev) => {
      const next = typeof v === 'function' ? v(prev.explorerVisible) : v;
      return { ...prev, explorerVisible: next };
    });
  }, []);

  const setSidebarVisible = useCallback((v: boolean | ((prev: boolean) => boolean)) => {
    setLayout((prev) => {
      const next = typeof v === 'function' ? v(prev.sidebarVisible) : v;
      return { ...prev, sidebarVisible: next };
    });
  }, []);

  const setLeftPanelView = useCallback((v: LeftPanelView) => {
    setLayout((prev) => ({ ...prev, leftPanelView: v }));
  }, []);

  const setViewMode = useCallback((v: ViewMode | ((prev: ViewMode) => ViewMode)) => {
    setLayout((prev) => {
      const next = typeof v === 'function' ? v(prev.viewMode) : v;
      return { ...prev, viewMode: next };
    });
  }, []);

  const setRailDensity = useCallback((v: RailDensity) => {
    setLayout((prev) => ({ ...prev, railDensity: v }));
  }, []);

  // Diff overlay is transient — not persisted to localStorage
  const [diffEnabled, setDiffEnabled] = useState(false);

  return {
    explorerVisible: layout.explorerVisible,
    sidebarVisible: layout.sidebarVisible,
    leftPanelView: layout.leftPanelView,
    viewMode: layout.viewMode,
    railDensity: layout.railDensity,
    diffEnabled,
    setExplorerVisible,
    setSidebarVisible,
    setLeftPanelView,
    setViewMode,
    setRailDensity,
    setDiffEnabled,
  };
}
