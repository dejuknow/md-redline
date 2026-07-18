import {
  forwardRef,
  useState,
  useRef,
  useMemo,
  useCallback,
  useEffect,
  useLayoutEffect,
  type ComponentProps,
  type RefObject,
} from 'react';
import { useTabs } from './hooks/useTabs';
import { useSelection } from './hooks/useSelection';
import { useRecentFiles } from './hooks/useRecentFiles';
import { useFileWatcher } from './hooks/useFileWatcher';
import { usePageVisible } from './hooks/usePageVisible';
import { useResizablePanel } from './hooks/useResizablePanel';
import { useSessionPersistence, loadSession } from './hooks/useSessionPersistence';
import {
  backfillReplyTimestamps,
  createCommentMarkerRegex,
  findNewReplyIds,
  parseComments,
  stripInlineFormatting,
} from './lib/comment-parser';
import { getEffectiveStatus } from './types';
import { MarkdownViewer, type MarkdownViewerHandle } from './components/MarkdownViewer';
import { TableOfContents } from './components/TableOfContents';
import { CommentPopover } from './components/CommentPopover';
import { CommentForm } from './components/CommentForm';
import { Toolbar } from './components/Toolbar';
import { TabBar } from './components/TabBar';
import { FileExplorer } from './components/FileExplorer';
import { FileOpener } from './components/FileOpener';
import { DragHandles } from './components/DragHandles';
import { RawView, type RawViewHandle } from './components/RawView';
import {
  RenderedDiffView,
  type RenderedDiffViewHandle,
} from './components/RenderedDiffView';
import { useDiffLines } from './hooks/useDiffLines';
import { PanelToolbar } from './components/PanelToolbar';
import { Toast } from './components/Toast';

import { CommandPalette, type Command } from './components/CommandPalette';
import { ContextMenu } from './components/ContextMenu';
import { SettingsPanel } from './components/SettingsPanel';
import { SearchBar } from './components/SearchBar';
import { ConfirmDialog } from './components/ConfirmDialog';
import { KeyboardShortcutsPanel } from './components/KeyboardShortcutsPanel';
import { useDragHandles } from './hooks/useDragHandles';
import { useAuthor } from './hooks/useAuthor';
import { useContextMenu } from './hooks/useContextMenu';
import { useSettings } from './contexts/SettingsContext';
import { usePersistedTheme, useSetPersistedTheme } from './hooks/useThemePersistence';
import { migrateLocalStorageToDisk } from './lib/preferences-client';
import { readJsonResponse } from './lib/http';
import { ALL_THEMES } from './lib/themes';
import {
  collectMermaidBlocks,
  findCurrentMermaidBlock,
  getMermaidBlockIdentity,
} from './lib/mermaid-blocks';
import { useMermaidRenderer } from './hooks/useMermaidRenderer';
import { useMermaidFullscreen } from './hooks/useMermaidFullscreen';
import { MermaidFullscreenModal } from './components/MermaidFullscreenModal';
import { usePaneLayout } from './hooks/usePaneLayout';
import { useToast, type ShowToast } from './hooks/useToast';
import { useModalState } from './hooks/useModalState';
import { useSearch } from './hooks/useSearch';
import { useCommentCardTriggers } from './hooks/useCommentCardTriggers';
import { useDiffSnapshot } from './hooks/useDiffSnapshot';
import { shouldAdvanceFrontier, formatReferenceLabel } from './lib/review-frontier';
import { useComments } from './hooks/useComments';
import { useHeadingTracking } from './hooks/useHeadingTracking';
import { useContextMenuItems } from './hooks/useContextMenuItems';
import { getCopySelectionFallbackText } from './lib/copy-selection';
import { useReviewSession, findActiveSessionForFile } from './hooks/useReviewSession';
import { ReviewBanner } from './components/ReviewBanner';
import { stripReviewParamFromUrl } from './lib/review-url';
import { selectAgentAsks } from './lib/agent-asks';
import { CommentsRail, RailDensityControl } from './components/CommentsRail';
import { AppLogo } from './components/AppLogo';
import { IconButton } from './components/IconButton';
import { getPrimaryModifierLabel } from './lib/platform';
import { CommentsDrawer } from './components/CommentsDrawer';
import { useMarginLayout } from './hooks/useMarginLayout';
import { DensityStrip } from './components/DensityStrip';
import { useCommentTicks } from './hooks/useCommentTicks';
import { SectionBreadcrumb } from './components/SectionBreadcrumb';
import { headingChain } from './lib/heading-chain';
import { usePageGeometry } from './hooks/usePageGeometry';
import { PAD_L, DOC_WIDTH_COLS } from './lib/page-geometry';

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.userAgent);
const modKey = isMac ? '\u2318' : 'Ctrl';
const prevTabShortcut = isMac ? '\u2318\u21e7[' : 'Ctrl+Shift+[';
const nextTabShortcut = isMac ? '\u2318\u21e7]' : 'Ctrl+Shift+]';

const ThemedMarkdownViewer = forwardRef<MarkdownViewerHandle, ComponentProps<typeof MarkdownViewer>>(
  function ThemedMarkdownViewer(props, ref) {
    const theme = usePersistedTheme();
    return <MarkdownViewer ref={ref} {...props} theme={theme} />;
  },
);

export default function App() {
  // Load saved session lazily (deferred to first render, not module import time)
  const [savedSession] = useState(() => loadSession());
  const showToastRef = useRef<ShowToast | null>(null);
  const onSaveError = useCallback(
    (msg: string) => showToastRef.current?.(`Save failed: ${msg}`, 'error'),
    [],
  );
  const {
    tabs,
    activeFilePath,
    rawMarkdown,
    setRawMarkdown,
    updateTab,
    isLoading,
    error,
    errorKind,
    isTabDirty,
    openTab,
    openTabInBackground,
    closeTab: closeTabDirect,
    closeOtherTabs: closeOtherTabsDirect,
    closeAllTabs: closeAllTabsDirect,
    closeTabsToRight: closeTabsToRightDirect,
    switchTab,
    saveFile,
    saveFileAt,
    getTabSnapshot,
    reloadFile,
    retryAllAccessDenied,
  } = useTabs({ onSaveError });

  // Dirty-tab close guard: when closing tabs that have unsaved changes
  // (e.g. save failed), show a confirmation dialog before discarding.
  const [pendingClose, setPendingClose] = useState<{
    type: 'single' | 'others' | 'all' | 'right';
    path?: string;
  } | null>(null);

  const executePendingClose = useCallback(() => {
    if (!pendingClose) return;
    switch (pendingClose.type) {
      case 'single':
        if (pendingClose.path) closeTabDirect(pendingClose.path);
        break;
      case 'others':
        if (pendingClose.path) closeOtherTabsDirect(pendingClose.path);
        break;
      case 'all':
        closeAllTabsDirect();
        break;
      case 'right':
        if (pendingClose.path) closeTabsToRightDirect(pendingClose.path);
        break;
    }
    setPendingClose(null);
  }, [pendingClose, closeTabDirect, closeOtherTabsDirect, closeAllTabsDirect, closeTabsToRightDirect]);

  const closeTab = useCallback(
    (path: string) => {
      if (isTabDirty(path)) {
        setPendingClose({ type: 'single', path });
        return;
      }
      closeTabDirect(path);
    },
    [isTabDirty, closeTabDirect],
  );

  const closeOtherTabs = useCallback(
    (keepPath: string) => {
      const hasDirty = tabs.some((t) => t.filePath !== keepPath && isTabDirty(t.filePath));
      if (hasDirty) {
        setPendingClose({ type: 'others', path: keepPath });
        return;
      }
      closeOtherTabsDirect(keepPath);
    },
    [tabs, isTabDirty, closeOtherTabsDirect],
  );

  const closeAllTabs = useCallback(() => {
    const hasDirty = tabs.some((t) => isTabDirty(t.filePath));
    if (hasDirty) {
      setPendingClose({ type: 'all' });
      return;
    }
    closeAllTabsDirect();
  }, [tabs, isTabDirty, closeAllTabsDirect]);

  const closeTabsToRight = useCallback(
    (path: string) => {
      const idx = tabs.findIndex((t) => t.filePath === path);
      const hasDirty = tabs.slice(idx + 1).some((t) => isTabDirty(t.filePath));
      if (hasDirty) {
        setPendingClose({ type: 'right', path });
        return;
      }
      closeTabsToRightDirect(path);
    },
    [tabs, isTabDirty, closeTabsToRightDirect],
  );

  const trustFolderInFlightRef = useRef(false);
  const handleTrustFolder = useCallback(
    async (defaultPathOverride?: string) => {
      if (trustFolderInFlightRef.current) return;
      trustFolderInFlightRef.current = true;
      try {
        // Only accept string overrides. The Toolbar binds this directly to a
        // button onClick, which passes a SyntheticEvent as the first arg —
        // we need to ignore it and fall back to deriving from activeFilePath.
        const overrideDir =
          typeof defaultPathOverride === 'string' ? defaultPathOverride : null;
        let hint: string | null = null;
        if (overrideDir) {
          hint = overrideDir;
        } else if (activeFilePath) {
          const lastSlash = activeFilePath.lastIndexOf('/');
          hint = lastSlash > 0 ? activeFilePath.slice(0, lastSlash) : null;
        }
        const url = hint
          ? `/api/pick-folder?defaultPath=${encodeURIComponent(hint)}`
          : '/api/pick-folder';
        const res = await fetch(url);
        const data = (await res.json()) as { path?: string; cancelled?: boolean };
        if (!res.ok || data.cancelled || !data.path) {
          // Cancelled, failed, or returned no path. Leave the existing error
          // in place; the user can click the button again or close the tab.
          return;
        }
        await retryAllAccessDenied();
      } catch {
        // Network or parse error. Leave the existing error in place.
      } finally {
        trustFolderInFlightRef.current = false;
      }
    },
    [activeFilePath, retryAllAccessDenied],
  );

  const [explorerDir, setExplorerDir] = useState<string | undefined>(undefined);
  const [homeDir, setHomeDir] = useState<string>('');
  const { recentFiles, addRecentFile, clearRecentFiles } = useRecentFiles();
  const { author, setAuthor } = useAuthor();
  const { settings, updateDocWidth } = useSettings();
  const setTheme = useSetPersistedTheme();
  const { explorerWidth, mermaidPanelWidth, onResizeStart, isDragging } = useResizablePanel();
  const pageVisible = usePageVisible();
  const {
    explorerVisible,
    setExplorerVisible,
    sidebarVisible,
    setSidebarVisible,
    leftPanelView,
    setLeftPanelView,
    viewMode,
    setViewMode,
    railDensity,
    setRailDensity,
    diffEnabled,
    setDiffEnabled,
  } = usePaneLayout();

  const [focusMode, setFocusMode] = useState(false);
  const focusSnapshotRef = useRef<{ explorerVisible: boolean; sidebarVisible: boolean } | null>(
    null,
  );

  const enterFocusMode = useCallback(() => {
    focusSnapshotRef.current = { explorerVisible, sidebarVisible };
    setExplorerVisible(false);
    setSidebarVisible(false);
    setFocusMode(true);
  }, [explorerVisible, sidebarVisible, setExplorerVisible, setSidebarVisible]);

  const exitFocusMode = useCallback(() => {
    const snap = focusSnapshotRef.current;
    if (snap) {
      setExplorerVisible(snap.explorerVisible);
      setSidebarVisible(snap.sidebarVisible);
    }
    focusSnapshotRef.current = null;
    setFocusMode(false);
  }, [setExplorerVisible, setSidebarVisible]);

  // Force-open paths (context menu reveals, outline toggle) exit focus mode
  // and then apply, unlike the plain pane toggles which exit and stop.
  const setExplorerVisibleGuarded = useCallback(
    (visible: boolean | ((p: boolean) => boolean)) => {
      if (focusMode) exitFocusMode();
      setExplorerVisible(visible);
    },
    [focusMode, exitFocusMode, setExplorerVisible],
  );

  const setSidebarVisibleGuarded = useCallback(
    (visible: boolean | ((p: boolean) => boolean)) => {
      if (focusMode) exitFocusMode();
      setSidebarVisible(visible);
    },
    [focusMode, exitFocusMode, setSidebarVisible],
  );

  const toggleFocusMode = useCallback(() => {
    if (focusMode) exitFocusMode();
    else enterFocusMode();
  }, [focusMode, enterFocusMode, exitFocusMode]);

  const toggleExplorerPane = useCallback(() => {
    if (focusMode) {
      exitFocusMode();
      return;
    }
    if (explorerVisible && leftPanelView === 'explorer') {
      setExplorerVisible(false);
    } else {
      setExplorerVisible(true);
      setLeftPanelView('explorer');
    }
  }, [focusMode, exitFocusMode, explorerVisible, leftPanelView, setExplorerVisible, setLeftPanelView]);

  const toggleSidebarPane = useCallback(() => {
    if (focusMode) {
      exitFocusMode();
      return;
    }
    setSidebarVisible((p) => !p);
  }, [focusMode, exitFocusMode, setSidebarVisible]);

  // One-time migration of localStorage preferences to disk
  useEffect(() => {
    migrateLocalStorageToDisk();
  }, []);

  // Session persistence (tabs only — pane layout is persisted by usePaneLayout)
  const { persist } = useSessionPersistence();
  useEffect(() => {
    persist({
      openTabs: tabs.map((t) => t.filePath),
      activeFilePath,
    });
  }, [tabs, activeFilePath, persist]);

  // Restore session tabs on first mount
  const sessionRestoredRef = useRef(false);
  useEffect(() => {
    if (sessionRestoredRef.current) return;
    sessionRestoredRef.current = true;
    const params = new URLSearchParams(window.location.search);
    if (params.get('file') || params.get('dir') || params.get('review')) return;
    if (savedSession && savedSession.openTabs.length > 0) {
      // Open inactive tabs in background first, then the active tab last
      // (openTab sets it active, avoiding the setTimeout race)
      const activeTarget =
        savedSession.activeFilePath && savedSession.openTabs.includes(savedSession.activeFilePath)
          ? savedSession.activeFilePath
          : savedSession.openTabs[0];
      for (const path of savedSession.openTabs) {
        if (path === activeTarget) continue;
        openTabInBackground(path);
      }
      openTab(activeTarget);
    }
  }, [openTab, openTabInBackground, savedSession]);

  // Toast notification state
  const { toast, showToast, dismissToast } = useToast();
  showToastRef.current = showToast;

  // Accumulate external-change counts so rapid SSE events coalesce into one
  // updating toast ("3 comments addressed") instead of flickering "1 comment" each time.
  const accResolvedRef = useRef(0);
  const accDeletedRef = useRef(0);
  const accRepliesRef = useRef(0);

  useEffect(() => {
    if (!toast.visible) {
      accResolvedRef.current = 0;
      accDeletedRef.current = 0;
      accRepliesRef.current = 0;
    }
  }, [toast.visible]);

  // Auto-expand comment form state (Feature 3)
  const [autoExpandForm, setAutoExpandForm] = useState(false);
  const [highlightPaintTick, setHighlightPaintTick] = useState(0);
  const handleHighlightsPainted = useCallback(() => setHighlightPaintTick((t) => t + 1), []);
  const [requestedCommentFocus, setRequestedCommentFocus] = useState<{
    commentId: string;
    token: number;
    origin: 'creation' | 'jump';
  } | null>(null);

  // Modal state — only one modal can be open at a time
  const { activeModal, setActiveModal, toggleModal, openFilePicker } = useModalState();

  const switchTabByOffset = useCallback(
    (offset: number) => {
      if (tabs.length === 0) return;

      const activeIndex = activeFilePath
        ? tabs.findIndex((tab) => tab.filePath === activeFilePath)
        : -1;

      const fallbackIndex = offset >= 0 ? 0 : tabs.length - 1;
      const nextIndex =
        activeIndex === -1 ? fallbackIndex : (activeIndex + offset + tabs.length) % tabs.length;

      switchTab(tabs[nextIndex].filePath);
    },
    [tabs, activeFilePath, switchTab],
  );

  // Text search state
  const showSearch = activeModal === 'search';
  const {
    searchQuery,
    activeSearchIndex,
    searchMatchCount,
    searchFocusTrigger,
    setSearchFocusTrigger,
    handleSearchCount,
    handleSearchNext,
    handleSearchPrev,
    handleSearchClose,
    handleSearchQueryChange,
  } = useSearch(() => setActiveModal(null));

  // Platform info for context menu labels
  const [revealLabel, setRevealLabel] = useState('Reveal in File Manager');
  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/platform', { signal: controller.signal })
      .then((r) => {
        if (!r.ok) throw new Error();
        return readJsonResponse<{ platform?: string }>(r);
      })
      .then((data) => {
        const platform = data?.platform;
        if (platform === 'darwin') setRevealLabel('Show in Finder');
        else if (platform === 'win32') setRevealLabel('Show in File Explorer');
        else setRevealLabel('Show in File Manager');
      })
      .catch(() => {});
    return () => controller.abort();
  }, []);

  // Context menu state
  const viewerCtxMenu = useContextMenu();
  const explorerCtxMenu = useContextMenu();
  const tabCtxMenu = useContextMenu();
  const sidebarCtxMenu = useContextMenu();

  // Triggers for remotely entering edit/reply mode on a CommentCard
  const { requestedEditor, triggerEdit, triggerReply } = useCommentCardTriggers();

  const viewerRef = useRef<MarkdownViewerHandle>(null);
  const rawViewRef = useRef<RawViewHandle>(null);
  const renderedDiffRef = useRef<RenderedDiffViewHandle>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const pageRef = useRef<HTMLDivElement>(null);

  // Ref to avoid rawMarkdown in callback dependencies (stabilizes function identities).
  const rawMarkdownRef = useRef(rawMarkdown);
  useLayoutEffect(() => {
    rawMarkdownRef.current = rawMarkdown;
  }, [rawMarkdown]);

  // Diff snapshot state
  const { currentSnapshot, currentReference, captureReference, restoreReference } =
    useDiffSnapshot(activeFilePath, rawMarkdownRef);

  // Ref to access snapshot state inside callbacks without adding dependencies.
  const currentSnapshotRef = useRef(currentSnapshot);
  useLayoutEffect(() => {
    currentSnapshotRef.current = currentSnapshot;
  }, [currentSnapshot]);

  // Track whether the diff has unseen external changes (badge indicator on diff button)
  const [diffPending, setDiffPending] = useState(false);

  // Single source of truth for diff state — both views and the panel
  // toolbar badge read from this so they always agree, and the badge can
  // appear immediately on snapshot+content-change without entering diff mode.
  const {
    diffLines,
    chunkCount: diffChunkCount,
    oldCleanToRawLine,
    newCleanToRawLine,
  } = useDiffLines(rawMarkdown, currentSnapshot);

  // Copy document — strips comment markers so reviewers paste clean prose,
  // not the agent metadata. Lives at App level so the panel toolbar can call
  // it from either view.
  const [copyFeedback, setCopyFeedback] = useState(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const backfillTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    },
    [],
  );
  const handleCopyDocument = useCallback(() => {
    const clean = rawMarkdownRef.current.replace(createCommentMarkerRegex(), '');
    navigator.clipboard.writeText(clean).then(
      () => {
        setCopyFeedback(true);
        if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
        copyTimerRef.current = setTimeout(() => setCopyFeedback(false), 2000);
      },
      () => {},
    );
  }, []);

  const { selection, clearSelection, lockSelection } = useSelection(
    containerRef as RefObject<HTMLElement | null>,
  );
  const requestCommentFocus = useCallback(
    (commentId: string, origin: 'creation' | 'jump' = 'jump') =>
      setRequestedCommentFocus({ commentId, token: Date.now(), origin }),
    [],
  );

  // Comment state and operations
  const {
    activeCommentId,
    setActiveCommentId,
    comments,
    cleanMarkdown,
    html,
    missingAnchors,
    newOrphanIds,
    commentCounts,
    resolvedCommentCounts,
    commentIdsByFile,
    agentCommentCounts,
    commentCount,
    handleAddComment,
    handleResolve,
    handleUnresolve,
    handleDelete,
    handleEdit,
    handleReply,
    handleEditReply,
    handleDeleteReply,
    handleBulkDelete,
    handleBulkResolve,
    handleBulkDeleteResolved,
    handleCopyAgentPrompt,
    handleHighlightClick,
    handleSidebarActivate,
    handleAnchorChange,
    handleReanchorToSelection,
    handleJumpToNext,
    handleJumpToPrev,
  } = useComments({
    rawMarkdown,
    rawMarkdownRef,
    setRawMarkdown,
    saveFile,
    author,
    enableResolve: settings.enableResolve,
    tabs,
    activeFilePath,
    viewerRef,
    rawViewRef,
    showToast,
    clearSelection,
    setAutoExpandForm,
    requestCommentFocus,
  });

  // Review frontier: when the active file's open comments cross to zero, advance
  // the diff reference to the current content so the diff resets for the next
  // round. Gated on the resolve feature so the "resolved" story is always true.
  const prevOpenCountRef = useRef(commentCount);
  const advancedForEpisodeRef = useRef(false);
  const frontierFileRef = useRef(activeFilePath);
  const prevResolveEnabledRef = useRef(settings.enableResolve);
  useEffect(() => {
    const fileChanged = frontierFileRef.current !== activeFilePath;
    const resolveEnabledChanged = prevResolveEnabledRef.current !== settings.enableResolve;
    const prevOpenCount = prevOpenCountRef.current;
    frontierFileRef.current = activeFilePath;
    prevOpenCountRef.current = commentCount;
    prevResolveEnabledRef.current = settings.enableResolve;

    // A new open comment starts a fresh episode.
    if (commentCount > 0) advancedForEpisodeRef.current = false;

    if (
      shouldAdvanceFrontier({
        resolveEnabled: settings.enableResolve,
        hasReference: currentReference != null,
        prevOpenCount,
        openCount: commentCount,
        alreadyAdvanced: advancedForEpisodeRef.current,
        fileChanged,
        resolveEnabledChanged,
      })
    ) {
      advancedForEpisodeRef.current = true;
      const prevRef = captureReference('review');
      showToast('All comments resolved. Diff reset.', 'info', {
        label: 'Undo',
        onClick: () => restoreReference(prevRef),
      });
    }
  }, [
    commentCount,
    activeFilePath,
    currentReference,
    settings.enableResolve,
    captureReference,
    restoreReference,
    showToast,
  ]);

  // A rail can exist in this view at all: rendered mode, not showing a diff
  // snapshot. Whether it actually fits is layered on via geometry.railFits /
  // railShown below. Derived once so the many rail-surface call sites
  // (railAllowed, the surface toggles, the focus-routing effects, the density
  // strip, the margin layer render) cannot silently diverge when rail
  // eligibility changes.
  const railCapable = viewMode === 'rendered' && !(diffEnabled && currentSnapshot);
  const railAllowed = railCapable && sidebarVisible && !focusMode;
  // The anchored rail earns its gutter width only once it has a card to
  // place. List density always reserves — its panel is intentional even when
  // empty. Anchored + zero non-resolved comments collapses the empty margin
  // instead of parking a wide dead gutter next to the prose. The rail itself
  // stays mounted (railShown is unaffected, so chrome and routing are
  // unchanged); only the sheet width drops and re-centers, and colWidth is
  // held constant so the first comment slides the gutter open without
  // reflowing the text.
  const railHasContent =
    railDensity === 'list' || comments.some((c) => getEffectiveStatus(c) !== 'resolved');
  const geometry = usePageGeometry(
    containerRef as RefObject<HTMLElement | null>,
    railAllowed,
    viewMode === 'rendered',
    DOC_WIDTH_COLS[settings.docWidth],
    railHasContent,
  );
  const railShown = geometry.railShown;

  // The comments drawer is the fallback comment surface wherever the rail
  // cannot show: raw view, diff mode, or a rendered view too narrow to fit
  // it. Close it automatically once the rail becomes available again, so
  // the two surfaces never show at the same time.
  const [drawerOpen, setDrawerOpen] = useState(false);
  useEffect(() => {
    if (railShown) setDrawerOpen(false);
  }, [railShown]);

  // Guarantees a comment surface is open for callers that need one to exist
  // right now (the viewer context menu's Edit/Reply/Jump to Sidebar actions
  // set an activeCommentId or requestedEditor that only a mounted surface
  // consumes). Bare setSidebarVisible(true) is not enough: at a narrow width
  // the rail cannot render at all regardless of sidebarVisible, so the
  // request would strand until some later surface mount fired it
  // unprompted. Mirrors the rail-can-show predicate the drawer fallback and
  // the Cmd+\ shortcut already use.
  const ensureCommentSurface = useCallback(() => {
    if (railCapable && geometry.railFits) {
      setSidebarVisibleGuarded(true);
    } else {
      setDrawerOpen(true);
    }
  }, [railCapable, geometry.railFits, setSidebarVisibleGuarded]);

  // Shared decision behind both comment-surface toggles: the Cmd+\ shortcut
  // and the command palette's "Toggle comments rail" command. Toggle the
  // rail where it can show; otherwise fall back to the comments drawer,
  // since that is the only comment surface left at a width the rail can't
  // fit. Defined once so the two triggers cannot diverge (a bug found in
  // review: the palette command used to call toggleSidebarPane() directly
  // and skip the drawer fallback entirely).
  const toggleCommentsSurface = useCallback(() => {
    if (!railCapable || !geometry.railFits) {
      setDrawerOpen((p) => !p);
    } else {
      toggleSidebarPane();
    }
  }, [railCapable, geometry.railFits, toggleSidebarPane]);

  // The highlight popover is the single-thread comment surface for
  // rail-hidden contexts: a click on a highlight, or a comment created while
  // hidden, opens one thread inline instead of routing through the drawer.
  const [popoverCommentId, setPopoverCommentId] = useState<string | null>(null);

  // Creation while the rail is hidden (rendered view, form only exists
  // there): open the popover on the new comment instead of leaving it with
  // no focus surface. Skip while the drawer is open: the drawer's own
  // focus-forwarding handles that case, so the popover doesn't open
  // underneath the drawer overlay.
  useEffect(() => {
    if (!requestedCommentFocus) return;
    if (!drawerOpen && !railShown && railCapable) {
      setPopoverCommentId(requestedCommentFocus.commentId);
      setRequestedCommentFocus(null);
    }
  }, [requestedCommentFocus, drawerOpen, railShown, railCapable]);

  // Invariant: every focus request must reach a visible surface. The rail
  // (either density), the open drawer, and the creation popover consume
  // their own cases above and below; the remaining state is rail hidden,
  // drawer closed, and no popover possible (raw view or diff mode), reached
  // via jump-to-ask flows. Open the drawer and leave the request set: the
  // drawer forwards it to the list surface once open, which consumes it.
  useEffect(() => {
    if (!requestedCommentFocus) return;
    if (!drawerOpen && !railShown && !railCapable) {
      setDrawerOpen(true);
    }
  }, [requestedCommentFocus, drawerOpen, railShown, railCapable]);

  // Close the popover once the rail can show its own surface, or when the
  // file changes out from under it.
  useEffect(() => {
    if (railShown) setPopoverCommentId(null);
  }, [railShown]);
  useEffect(() => {
    setPopoverCommentId(null);
  }, [activeFilePath]);
  // A deleted comment (or one an agent rewrite removed) must not leave a
  // stale id behind: if the same id ever reappeared (undo, rewrite), the
  // popover would pop back open unprompted.
  useEffect(() => {
    setPopoverCommentId((prev) =>
      prev !== null && !comments.some((c) => c.id === prev) ? null : prev,
    );
  }, [comments]);

  // In Anchored density a newly created comment's card is already at its
  // anchor; activating it would pin it and shove the cluster, so creation
  // requests are consumed without activation. Jump-to-ask and palette
  // jumps still activate so the document scrolls to the anchor.
  useEffect(() => {
    if (!requestedCommentFocus) return;
    if (railShown && railDensity === 'anchored') {
      if (
        requestedCommentFocus.origin !== 'creation' &&
        requestedCommentFocus.commentId !== activeCommentId
      ) {
        handleSidebarActivate(requestedCommentFocus.commentId);
      }
      setRequestedCommentFocus(null);
    }
  }, [requestedCommentFocus, railShown, railDensity, activeCommentId, handleSidebarActivate]);

  // Wraps the base highlight-click handler (which only sets activeCommentId)
  // with the popover trigger: when the rail can't show, a click on a
  // highlight opens the single-thread popover.
  const handleHighlightClickWithPopover = useCallback(
    (commentId: string) => {
      handleHighlightClick(commentId);
      if (!railShown) setPopoverCommentId(commentId);
    },
    [handleHighlightClick, railShown],
  );

  // Resolved comments have no highlight marks and would render as fake
  // orphans in the margin; they live in the List surface instead.
  const marginComments = useMemo(
    () => comments.filter((c) => getEffectiveStatus(c) !== 'resolved'),
    [comments],
  );
  const marginLayout = useMarginLayout(
    containerRef as RefObject<HTMLElement | null>,
    pageRef as RefObject<HTMLElement | null>,
    marginComments,
    activeCommentId,
    railShown,
    highlightPaintTick,
  );

  const densityEnabled = railCapable;
  const commentTicks = useCommentTicks(containerRef, comments, densityEnabled, highlightPaintTick);

  // Toast when an agent rewrite (or any edit) orphans comments. Debounce so
  // rapid successive edits collapse into one notification. Use refs — not
  // effect-cleanup — to hold the pending timer, so unrelated re-renders that
  // transition newOrphanIds to an empty Set don't cancel the in-flight toast.
  const orphanToastTimerRef = useRef<number | null>(null);
  const orphanToastCountRef = useRef(0);
  useEffect(() => {
    if (newOrphanIds.size === 0) return;
    orphanToastCountRef.current += newOrphanIds.size;
    if (orphanToastTimerRef.current !== null) return;
    orphanToastTimerRef.current = window.setTimeout(() => {
      const count = orphanToastCountRef.current;
      orphanToastTimerRef.current = null;
      orphanToastCountRef.current = 0;
      showToast(
        count === 1
          ? '1 comment lost its anchor. Look for the flagged card in the comments rail.'
          : `${count} comments lost their anchor. Look for the flagged cards in the comments rail.`,
        'info',
      );
    }, 500);
  }, [newOrphanIds, showToast]);
  useEffect(
    () => () => {
      if (orphanToastTimerRef.current !== null) {
        window.clearTimeout(orphanToastTimerRef.current);
      }
    },
    [],
  );

  // Combined handoff: snapshot + copy agent prompt
  const handleHandoff = useCallback(
    (filePaths: string[]) => {
      // Build snapshot entries for background files so every handed-off file
      // gets a diff baseline, not just the active tab.
      const extra = new Map<string, string>();
      for (const p of filePaths) {
        if (p === activeFilePath) continue;
        const tab = tabs.find((t) => t.filePath === p);
        if (tab) extra.set(p, tab.rawMarkdown);
      }
      captureReference('handoff', extra.size > 0 ? extra : undefined);
      handleCopyAgentPrompt(filePaths);
    },
    [captureReference, handleCopyAgentPrompt, activeFilePath, tabs],
  );

  const { sessions: reviewSessions, refresh: refreshReviewSessions } = useReviewSession();

  // Mirrors the snapshot logic in handleHandoff so multi-file review sessions
  // get diff baselines for every involved tab, not just the active one.
  const handleReviewHandoffSuccess = useCallback(
    (session: { filePaths: string[] }) => {
      const extra = new Map<string, string>();
      for (const p of session.filePaths) {
        if (p === activeFilePath) continue;
        const tab = tabs.find((t) => t.filePath === p);
        if (tab) extra.set(p, tab.rawMarkdown);
      }
      captureReference('handoff', extra.size > 0 ? extra : undefined);
    },
    [tabs, activeFilePath, captureReference],
  );

  // Strip `?review=<id>` from the address bar once a review resolves, so
  // a page reload doesn't re-open the tabs of a completed review and so
  // bookmarks don't carry a stale session ID.
  const handleReviewResolved = useCallback(() => {
    refreshReviewSessions();
    stripReviewParamFromUrl();
  }, [refreshReviewSessions]);

  // --- Agent-ask state ---
  const activeSession = useMemo(
    () => findActiveSessionForFile(reviewSessions, activeFilePath),
    [reviewSessions, activeFilePath],
  );
  const agentAsks = useMemo(
    () => selectAgentAsks(comments, activeSession?.id ?? null),
    [comments, activeSession?.id],
  );


  // Derive per-session agent metadata from comment markers across all open
  // tabs (not just the active file):
  // - agentNamesBySession: first agent-initiated comment author. Used by
  //   ReviewBanner for the agent-row label.
  // - pendingAsksBySession: agent questions still awaiting a reply, for ANY
  //   open session (mdr_ask works on both origins). Drives the banner's
  //   awaiting-reply state, the toast, and the tab-title badge.
  const { agentNamesBySession, pendingAsksBySession } = useMemo(() => {
    const names = new Map<string, string>();
    const pending = new Map<
      string,
      Array<{ commentId: string; filePath: string; author: string }>
    >();
    if (reviewSessions.length === 0) return { agentNamesBySession: names, pendingAsksBySession: pending };

    const commentsByFile = new Map<string, typeof comments>();
    if (activeFilePath) commentsByFile.set(activeFilePath, comments);
    for (const tab of tabs) {
      if (commentsByFile.has(tab.filePath)) continue;
      try {
        commentsByFile.set(tab.filePath, parseComments(tab.rawMarkdown).comments);
      } catch { /* skip */ }
    }

    for (const session of reviewSessions) {
      let firstAuthor: string | undefined;
      const sessionAsks: Array<{ commentId: string; filePath: string; author: string }> = [];
      for (const filePath of session.filePaths) {
        const fileParsedComments = commentsByFile.get(filePath);
        if (!fileParsedComments) continue;
        for (const c of fileParsedComments) {
          if (c.agentInitiated !== true || c.sessionId !== session.id) continue;
          if (!firstAuthor && c.author) firstAuthor = c.author;
        }
        for (const ask of selectAgentAsks(fileParsedComments, session.id)) {
          sessionAsks.push({ commentId: ask.id, filePath, author: ask.author ?? 'Agent' });
        }
      }
      if (session.origin === 'agent') names.set(session.id, firstAuthor ?? 'Agent');
      if (sessionAsks.length > 0) pending.set(session.id, sessionAsks);
    }
    return { agentNamesBySession: names, pendingAsksBySession: pending };
  }, [reviewSessions, comments, tabs, activeFilePath]);

  // Jump to a session's first pending agent question, switching tabs first
  // when the question lives on a non-active file.
  const handleJumpToAsk = useCallback(
    (sessionId: string) => {
      const asks = pendingAsksBySession.get(sessionId);
      if (!asks || asks.length === 0) return;
      const target = asks.find((a) => a.filePath === activeFilePath) ?? asks[0];
      if (target.filePath !== activeFilePath) {
        switchTab(target.filePath);
        // Let the tab's comments render before requesting card focus.
        setTimeout(() => requestCommentFocus(target.commentId), 150);
      } else {
        requestCommentFocus(target.commentId);
      }
    },
    [pendingAsksBySession, activeFilePath, switchTab, requestCommentFocus],
  );

  // Pending-question count per session for the banner; total for the title.
  const pendingAskCountsBySession = useMemo(() => {
    const map = new Map<string, number>();
    for (const [sid, asks] of pendingAsksBySession) map.set(sid, asks.length);
    return map;
  }, [pendingAsksBySession]);

  // Tab-title badge: surface pending agent questions to a user who has the
  // tab backgrounded (the in-page toast and banner are invisible there), and
  // show the open file name so multiple md-redline tabs are distinguishable.
  const baseTitleRef = useRef<string | null>(null);
  useEffect(() => {
    if (baseTitleRef.current === null) baseTitleRef.current = document.title;
    const appName = baseTitleRef.current;
    const fileName = activeFilePath ? (activeFilePath.split('/').pop() ?? '') : '';
    const base = fileName ? `${fileName} · ${appName}` : appName;
    let total = 0;
    for (const asks of pendingAsksBySession.values()) total += asks.length;
    document.title =
      total > 0 ? `(${total} question${total === 1 ? '' : 's'}) ${base}` : base;
  }, [pendingAsksBySession, activeFilePath]);

  // Toast on new agent ask (debounced). `lastSeenAskIdsRef` accumulates all
  // ask IDs seen for the entire browser-tab lifetime (across file tabs and
  // sessions), so switching to a tab whose asks were already seen earlier
  // does not refire the toast. We rely on browser-tab reload to clear it —
  // that's intentional, asks-from-yesterday warrant a re-notification.
  const lastSeenAskIdsRef = useRef<Set<string>>(new Set());
  const askToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const didMountRef = useRef(false);

  useEffect(() => {
    let newSessionId: string | null = null;
    let newCount = 0;
    let author = 'Agent';
    let fileBase = '';
    const newlySeen: string[] = [];
    for (const [sid, asks] of pendingAsksBySession) {
      for (const ask of asks) {
        if (lastSeenAskIdsRef.current.has(ask.commentId)) continue;
        newlySeen.push(ask.commentId);
        newSessionId = sid;
        newCount += 1;
        author = ask.author;
        fileBase = ask.filePath.split('/').pop() ?? '';
      }
    }
    // Union (not replace) so cross-tab visits don't reset the seen set and
    // re-toast the same asks the user saw on the previous tab.
    for (const id of newlySeen) lastSeenAskIdsRef.current.add(id);

    if (!didMountRef.current) {
      didMountRef.current = true;
      return; // first run — populate the ref but do not toast
    }

    if (!newSessionId) return;

    if (askToastTimerRef.current) clearTimeout(askToastTimerRef.current);
    const sessionId = newSessionId;
    const count = newCount;
    askToastTimerRef.current = setTimeout(() => {
      showToast(
        count === 1
          ? `${author} has a question${fileBase ? ` on ${fileBase}` : ''}`
          : `${author} has ${count} questions${fileBase ? ` on ${fileBase}` : ''}`,
        'info',
        { label: 'View', onClick: () => handleJumpToAsk(sessionId) },
      );
    }, 500);
  }, [pendingAsksBySession, showToast, handleJumpToAsk]);

  const handleDiffToggle = useCallback(() => {
    if (!diffEnabled) {
      setDiffEnabled(true);
      setDiffPending(false);
    } else {
      setDiffEnabled(false);
    }
  }, [diffEnabled, setDiffEnabled]);

  const handleMarkReviewed = useCallback(() => {
    const prevRef = captureReference('review');
    showToast('Diff reset.', 'info', {
      label: 'Undo',
      onClick: () => restoreReference(prevRef),
    });
  }, [captureReference, restoreReference, showToast]);

  const mermaidBlocks = useMemo(() => collectMermaidBlocks(cleanMarkdown), [cleanMarkdown]);
  const viewerNeedsTheme = mermaidBlocks.length > 0;

  // Mermaid rendering — hoisted here so both MarkdownViewer and the fullscreen modal
  // can share the same pre-rendered SVG map without double-rendering.
  const persistedTheme = usePersistedTheme();
  const mermaidFullscreen = useMermaidFullscreen();
  const openMermaidFullscreenState = mermaidFullscreen.open;
  const renderedDiffVisible = Boolean(diffEnabled && currentSnapshot && diffLines);
  const mermaidRendererEnabled =
    mermaidFullscreen.isOpen || (viewMode === 'rendered' && !renderedDiffVisible);
  const mermaidSvgMap = useMermaidRenderer(
    cleanMarkdown,
    persistedTheme || 'light',
    mermaidRendererEnabled,
  );

  // Bridge useMermaidFullscreen into the modal-state machine so Escape / palette
  // guards that key on activeModal also work for the fullscreen modal.
  useEffect(() => {
    if (mermaidFullscreen.isOpen) setActiveModal('mermaidFullscreen');
    else if (activeModal === 'mermaidFullscreen') setActiveModal(null);
    // activeModal is intentionally excluded: including it would re-fire on every
    // modal change and stomp newly-opened modals back to null.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mermaidFullscreen.isOpen]);

  const activeMermaidBlock = useMemo(() => {
    if (!mermaidFullscreen.activeSource) return null;
    return findCurrentMermaidBlock(
      mermaidBlocks,
      mermaidFullscreen.activeSource,
      mermaidFullscreen.activeBlockIndex ?? 0,
      mermaidFullscreen.activeIdentity,
    );
  }, [
    mermaidBlocks,
    mermaidFullscreen.activeSource,
    mermaidFullscreen.activeBlockIndex,
    mermaidFullscreen.activeIdentity,
  ]);

  const handleOpenMermaidFullscreen = useCallback(
    (source: string, blockIndex: number) => {
      const block =
        mermaidBlocks[blockIndex]?.source === source
          ? mermaidBlocks[blockIndex]
          : findCurrentMermaidBlock(mermaidBlocks, source, blockIndex);
      openMermaidFullscreenState(source, blockIndex, block ? getMermaidBlockIdentity(block) : null);
    },
    [mermaidBlocks, openMermaidFullscreenState],
  );

  // Look up the SVG for the active source.
  const activeMermaidSvg = useMemo(() => {
    if (!activeMermaidBlock) return null;
    return mermaidSvgMap.get(activeMermaidBlock.source)?.svg ?? null;
  }, [activeMermaidBlock, mermaidSvgMap]);

  // Auto-close the fullscreen modal and show a toast when the active diagram
  // source is removed from the markdown.
  useEffect(() => {
    if (!mermaidFullscreen.isOpen) return;
    if (!mermaidFullscreen.activeSource) return;
    if (!activeMermaidBlock) {
      mermaidFullscreen.close();
      showToast('Diagram was removed from the document.', 'info');
    }
    // mermaidFullscreen is a new object each render; individual fields are listed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    activeMermaidBlock,
    mermaidFullscreen.isOpen,
    mermaidFullscreen.activeSource,
    mermaidFullscreen.close,
    showToast,
  ]);

  // Heading tracking / table of contents
  const { tocHeadings, activeHeadingId, setActiveHeadingId, spyDisabledRef, scrollSpyRafRef } =
    useHeadingTracking(containerRef, viewerRef, html);

  const handleHeadingNavigate = useCallback(
    (id: string) => {
      cancelAnimationFrame(scrollSpyRafRef.current);
      spyDisabledRef.current = true;
      setActiveHeadingId(id);

      if (viewMode === 'raw') {
        rawViewRef.current?.scrollToHeading(id);
        return;
      }

      const el = containerRef.current?.querySelector(`#${CSS.escape(id)}`);
      el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    },
    [setActiveHeadingId, viewMode, scrollSpyRafRef, spyDisabledRef],
  );

  const breadcrumbChain = useMemo(
    () => headingChain(tocHeadings, activeHeadingId),
    [tocHeadings, activeHeadingId],
  );

  // Clear transient state on tab switch
  const prevFilePathRef = useRef(activeFilePath);
  useEffect(() => {
    if (prevFilePathRef.current !== activeFilePath) {
      prevFilePathRef.current = activeFilePath;
      setActiveCommentId(null);
      setDiffEnabled(false);
      setDiffPending(false);
      clearSelection();
    }
  }, [activeFilePath, setDiffEnabled, clearSelection, setActiveCommentId]);

  // Override agent-supplied reply timestamps with the file's mtime. LLM agents
  // can't reliably know "now," so without this they hallucinate timestamps
  // that look like reasonable ISO-8601 strings but are hours stale. Returns
  // the corrected content (or the original if no override was needed).
  const correctReplyTimestamps = useCallback(
    (oldContent: string, newContent: string, mtime: number | undefined): string => {
      try {
        const { comments: oldComments } = parseComments(oldContent);
        const { comments: newComments } = parseComments(newContent);
        const newReplyIds = findNewReplyIds(oldComments, newComments);
        if (newReplyIds.size === 0) return newContent;
        const fallbackIso =
          mtime != null ? new Date(mtime).toISOString() : new Date().toISOString();
        return backfillReplyTimestamps(newContent, newReplyIds, fallbackIso);
      } catch {
        return newContent;
      }
    },
    [],
  );

  // File watcher — live reload from server SSE (Feature 8: detect status transitions)
  const onExternalChange = useCallback(
    (content: string, mtime?: number) => {
      // Detect comment changes before updating so we can show toast/diff hints.
      let cleanContentChanged = false;
      try {
        const { comments: oldComments, cleanMarkdown: oldClean } = parseComments(
          rawMarkdownRef.current,
        );
        const { comments: newComments, cleanMarkdown: newClean } = parseComments(content);
        cleanContentChanged = oldClean !== newClean;
        const newById = new Map(newComments.map((c) => [c.id, c]));

        let deletedCount = 0;
        let resolvedCount = 0;
        for (const oldC of oldComments) {
          const newC = newById.get(oldC.id);
          if (!newC) {
            deletedCount++;
            continue;
          }
          if (settings.enableResolve) {
            const oldStatus = getEffectiveStatus(oldC);
            const newStatus = getEffectiveStatus(newC);
            if (oldStatus === 'open' && newStatus === 'resolved') {
              resolvedCount++;
            }
          }
        }
        const newReplyCount = findNewReplyIds(oldComments, newComments).size;

        // Accumulate across rapid events so the toast coalesces
        accResolvedRef.current += resolvedCount;
        accDeletedRef.current += deletedCount;
        accRepliesRef.current += newReplyCount;

        const r = accResolvedRef.current;
        const d = accDeletedRef.current;
        const rp = accRepliesRef.current;
        if (r > 0 || d > 0 || rp > 0) {
          const parts: string[] = [];
          if (r > 0) parts.push(`${r} resolved`);
          if (d > 0) parts.push(`${d} addressed`);
          if (rp > 0) parts.push(`${rp} ${rp > 1 ? 'replies' : 'reply'} added`);
          const diffAction =
            cleanContentChanged && currentSnapshotRef.current
              ? {
                  label: 'View diff',
                  // Stay in whatever view the user is in — diff overlay
                  // works in both raw and rendered now.
                  onClick: () => {
                    setDiffEnabled(true);
                    setDiffPending(false);
                  },
                }
              : undefined;
          showToast(`${parts.join(', ')} externally`, 'info', diffAction);
        }
      } catch {
        // Ignore parse errors — still update the content
      }

      const nextContent = correctReplyTimestamps(rawMarkdownRef.current, content, mtime);

      // Update content directly via updateTab (NOT setRawMarkdown which marks
      // dirty:true). External changes already match disk, so dirty must be false.
      // Also synchronously update rawMarkdownRef so back-to-back user edits
      // (e.g. add-comment right after SSE) read the latest content, not stale state.
      rawMarkdownRef.current = nextContent;
      if (activeFilePath) {
        updateTab(activeFilePath, {
          rawMarkdown: nextContent,
          ...(mtime != null ? { mtime } : {}),
          dirty: false,
        });
      }

      // Persist the corrected timestamps back to disk so reloads see the right
      // values. Debounced to avoid a write-watch-write bounce when an agent
      // makes rapid edits: each agent write triggers an SSE event → backfill →
      // save → SSE event, which changes the file under the agent's feet and
      // causes "Error editing file" on its next edit. A 2s debounce lets the
      // agent finish its batch of edits before we write the timestamps.
      //
      // Uses a direct fetch instead of saveFile() because the save queue shows
      // a "Save failed" toast on 409 CONFLICT. Since the agent modifies the
      // file between the SSE event and the debounced save, 409s are expected
      // and benign — the next SSE event will re-trigger the backfill.
      if (nextContent !== content && activeFilePath) {
        if (backfillTimerRef.current) clearTimeout(backfillTimerRef.current);
        const pathToSave = activeFilePath;
        const contentToSave = nextContent;
        const mtimeToSave = mtime;
        backfillTimerRef.current = setTimeout(async () => {
          backfillTimerRef.current = null;
          try {
            const res = await fetch('/api/file', {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ path: pathToSave, content: contentToSave, expectedMtime: mtimeToSave }),
            });
            // On success, sync the tab's mtime to the post-backfill value so
            // the next user-initiated save doesn't 409 against the stale
            // pre-backfill mtime. The backfill's own write is suppressed by
            // the server's lastWrittenContent cache, so no SSE event will
            // deliver this mtime — we have to read it from the response.
            if (res.ok) {
              const data = await readJsonResponse<{ mtime?: number }>(res);
              if (data?.mtime != null) {
                updateTab(pathToSave, { mtime: data.mtime });
              }
            }
            // 409s are expected and benign here (see comment above) — ignore.
          } catch {
            // Network errors: the next SSE event will re-trigger the backfill.
          }
        }, 2000);
      }

      // Flag the diff button when content changed and a snapshot exists
      if (cleanContentChanged && currentSnapshotRef.current) {
        setDiffPending(true);
      }
    },
    [
      activeFilePath,
      correctReplyTimestamps,
      setDiffEnabled,
      settings.enableResolve,
      showToast,
      updateTab,
    ],
  );

  // Keep a stable ref so the visibility-restore effect can call it without
  // adding it to its dependency array (which would cause reconnect churn).
  const onExternalChangeRef = useRef(onExternalChange);
  onExternalChangeRef.current = onExternalChange;

  useFileWatcher({ filePath: activeFilePath, onExternalChange });

  // Watch background tabs for external changes so they stay fresh during handoff.
  // The active tab is handled by useFileWatcher above; this covers the rest.
  // Keyed by path list so connections only churn when tabs open/close/switch.
  const backgroundPathsKey = tabs
    .map((t) => t.filePath)
    .filter((p) => p && p !== activeFilePath)
    .join('\0');

  useEffect(() => {
    if (!pageVisible) return;
    const paths = backgroundPathsKey ? backgroundPathsKey.split('\0') : [];
    if (paths.length === 0) return;

    // Single multiplexed SSE connection for all background tabs to avoid
    // exhausting the browser's per-origin HTTP/1.1 connection limit (6).
    // Also closed when the browser tab is hidden so multiple browser tabs
    // to the same server don't exhaust the limit.
    const params = paths.map((p) => `path=${encodeURIComponent(p)}`).join('&');
    const es = new EventSource(`/api/watch?${params}`);
    es.addEventListener('change', (e) => {
      try {
        const { content, path, mtime } = JSON.parse(e.data);
        const snapshot = getTabSnapshot(path);
        // Skip dirty background tabs entirely. The user has unsaved local
        // edits we'd otherwise overwrite (in memory AND on disk via the
        // saveFileAt below). They should resolve the conflict by switching
        // to the tab and reloading explicitly.
        if (snapshot?.dirty === true) return;
        // Backfill agent-supplied reply timestamps the same way the active-tab
        // handler does, so background files don't show stale times when the
        // user switches to them. No toast — background tabs aren't visible.
        const oldContent = snapshot?.rawMarkdown ?? '';
        const nextContent = correctReplyTimestamps(oldContent, content, mtime);
        updateTab(path, {
          rawMarkdown: nextContent,
          ...(mtime != null ? { mtime } : {}),
        });
        if (nextContent !== content) {
          saveFileAt(path, nextContent);
        }
      } catch {
        // ignore malformed events
      }
    });

    return () => es.close();
  }, [
    backgroundPathsKey,
    correctReplyTimestamps,
    getTabSnapshot,
    pageVisible,
    saveFileAt,
    updateTab,
  ]);

  // When the browser tab becomes visible again, fetch the active file and
  // route through onExternalChange so the user gets toast/blue-dot notifications
  // for changes that happened while SSE was disconnected.
  const wasHiddenRef = useRef(false);
  useEffect(() => {
    if (!pageVisible) {
      wasHiddenRef.current = true;
      return;
    }
    if (wasHiddenRef.current && activeFilePath) {
      wasHiddenRef.current = false;
      const controller = new AbortController();
      fetch(`/api/file?path=${encodeURIComponent(activeFilePath)}`, {
        signal: controller.signal,
      })
        .then((res) => (res.ok ? res.json() : null))
        .then((data: { content?: string; mtime?: number } | null) => {
          if (!data?.content) return;
          if (data.content !== rawMarkdownRef.current) {
            onExternalChangeRef.current(data.content, data.mtime);
          }
        })
        .catch((err) => {
          if (err instanceof DOMException && err.name === 'AbortError') return;
          // Network error — fall back to silent reload
          reloadFile();
        });
      return () => controller.abort();
    }
  }, [pageVisible, activeFilePath, reloadFile]);

  // Fetch the server's homeDir on mount so the trust prompt can show paths
  // in tilde-shortened form. Independent of the initial-file effect below
  // because that one short-circuits on URL params and we still want homeDir.
  useEffect(() => {
    let cancelled = false;
    fetch('/api/config')
      .then((r) => (r.ok ? readJsonResponse<{ homeDir?: string }>(r) : null))
      .then((data) => {
        if (cancelled || !data) return;
        if (typeof data.homeDir === 'string') {
          setHomeDir(data.homeDir);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // Open files referenced by ?review=<sessionId> in URL on first load.
  // The session itself is discovered via useReviewSession's poll; this
  // effect just makes sure the relevant tabs are open.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const reviewId = params.get('review');
    if (!reviewId) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/review-sessions/${reviewId}`);
        if (!res.ok) return;
        const session = (await res.json()) as { filePaths: string[] };
        if (cancelled) return;
        for (let i = 0; i < session.filePaths.length; i++) {
          if (i === 0) {
            openTab(session.filePaths[i]);
          } else {
            openTabInBackground(session.filePaths[i]);
          }
        }
        const firstFile = session.filePaths[0];
        if (firstFile) {
          const lastSlash = firstFile.lastIndexOf('/');
          if (lastSlash > 0) {
            setExplorerDir(firstFile.slice(0, lastSlash));
          }
        }
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [openTab, openTabInBackground]);

  // Load initial file/dir from URL params, CLI arg, or restored session
  const initialLoadRef = useRef(false);
  useEffect(() => {
    if (initialLoadRef.current) return;
    initialLoadRef.current = true;
    const params = new URLSearchParams(window.location.search);
    const urlFile = params.get('file');
    const urlDir = params.get('dir');

    if (urlFile) {
      openTab(urlFile);
      addRecentFile(urlFile);
      // Also point the explorer at the file's parent dir so the user can
      // browse siblings, rather than falling back to the server's cwd.
      const lastSlash = urlFile.lastIndexOf('/');
      if (lastSlash > 0) {
        setExplorerDir(urlFile.slice(0, lastSlash));
      }
      window.history.replaceState({}, '', window.location.pathname);
      return;
    }
    if (urlDir) {
      setExplorerDir(urlDir);
      setExplorerVisible(true);
      window.history.replaceState({}, '', window.location.pathname);
      return;
    }
    if (savedSession && savedSession.openTabs.length > 0) return;
    fetch('/api/config')
      .then((r) => {
        if (!r.ok) throw new Error();
        return readJsonResponse<{ initialFile?: string; initialDir?: string }>(r);
      })
      .then((data) => {
        if (!data) return;
        if (data.initialFile) {
          openTab(data.initialFile);
          // Same as the urlFile path: point the explorer at the file's
          // parent dir so siblings are browsable.
          const lastSlash = data.initialFile.lastIndexOf('/');
          if (lastSlash > 0) {
            setExplorerDir(data.initialFile.slice(0, lastSlash));
          }
        }
        if (data.initialDir) {
          setExplorerDir(data.initialDir);
          setExplorerVisible(true);
        }
      })
      .catch(() => {});
  }, [openTab, addRecentFile, setExplorerVisible, savedSession]);

  const handleOpenFile = useCallback(
    (path: string) => {
      if (path.trim()) {
        openTab(path.trim());
        addRecentFile(path.trim());
      }
    },
    [openTab, addRecentFile],
  );

  const revealInFinder = useCallback(
    (path: string) => {
      fetch('/api/reveal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path }),
      })
        .then((r) => {
          if (!r.ok) showToast('Could not reveal file', 'error');
        })
        .catch(() => {
          showToast('Could not reveal file', 'error');
        });
    },
    [showToast],
  );

  const handleExplorerOpenFile = useCallback(
    (path: string) => {
      openTab(path.trim());
      addRecentFile(path.trim());
    },
    [openTab, addRecentFile],
  );

  const { handlePositions, onHandleMouseDown } = useDragHandles({
    viewerRef,
    scrollContainerRef: containerRef,
    pageRef,
    activeCommentId,
    comments,
    onAnchorChange: handleAnchorChange,
  });

  // Stable ref for selection to use in keyboard handler without re-creating it
  const selectionRef = useRef(selection);
  selectionRef.current = selection;

  // Context menu handlers
  const {
    ctxMenuItems,
    explorerCtxMenuItems,
    tabCtxMenuItems,
    sidebarCtxMenuItems,
    handleViewerContextMenu,
    handleExplorerContextMenu,
    handleTabContextMenu,
    handleSidebarContextMenu,
  } = useContextMenuItems({
    comments,
    enableResolve: settings.enableResolve,
    templates: settings.templates,
    handleResolve,
    handleUnresolve,
    handleDelete,
    handleAddComment,
    setActiveCommentId,
    ensureCommentSurface,
    selectionRef,
    lockSelection,
    setAutoExpandForm,
    triggerEdit,
    triggerReply,
    viewerRef,
    handleExplorerOpenFile,
    openTabInBackground,
    addRecentFile,
    revealInFinder,
    revealLabel,
    setExplorerDir,
    setExplorerVisible: setExplorerVisibleGuarded,
    tabs,
    closeTab,
    closeOtherTabs,
    closeAllTabs,
    closeTabsToRight,
    viewerCtxMenu,
    explorerCtxMenu,
    tabCtxMenu,
    sidebarCtxMenu,
  });

  // --- Keyboard shortcuts ---
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      const target = e.target as HTMLElement;
      const isInput =
        target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;

      // While the Mermaid fullscreen modal is open, the modal owns the
      // keyboard. Even Cmd+K / Cmd+, would otherwise open the palette /
      // settings *behind* the fullscreen overlay (lower z-index), leaving
      // hidden modal state active and disabling the fullscreen guard for
      // subsequent shortcuts.
      if (activeModal === 'mermaidFullscreen') return;

      // Cmd+K : Open command palette (works even in inputs)
      if (mod && e.key === 'k') {
        e.preventDefault();
        toggleModal('commandPalette');
        return;
      }

      // Cmd+, : Open settings (works even in inputs)
      if (mod && e.key === ',') {
        e.preventDefault();
        toggleModal('settings');
        return;
      }

      // Cmd+Shift+O : Toggle outline (must come before Cmd+O)
      if (mod && e.shiftKey && e.key.toLowerCase() === 'o') {
        e.preventDefault();
        if (explorerVisible && leftPanelView === 'outline') {
          setExplorerVisibleGuarded(false);
        } else {
          setExplorerVisibleGuarded(true);
          setLeftPanelView('outline');
        }
        return;
      }

      // Cmd+O : Open file
      if (mod && e.key === 'o') {
        e.preventDefault();
        openFilePicker();
        return;
      }

      // Cmd+B : Toggle file explorer
      if (mod && e.key === 'b') {
        e.preventDefault();
        toggleExplorerPane();
        return;
      }

      // Cmd+F : Find in document
      if (mod && e.key === 'f') {
        e.preventDefault();
        setActiveModal('search');
        setSearchFocusTrigger((t) => t + 1);
        return;
      }

      // Cmd+\ : Toggle the rail where it can show; otherwise fall back to
      // the comments drawer, since that is the only comment surface left.
      if (mod && e.key === '\\') {
        e.preventDefault();
        toggleCommentsSurface();
        return;
      }

      // Cmd+. : Toggle focus mode
      if (mod && e.key === '.') {
        e.preventDefault();
        toggleFocusMode();
        return;
      }

      // Cmd+Enter : Expand comment form when text is selected (Feature 3)
      if (mod && e.key === 'Enter' && !isInput && selectionRef.current && viewMode === 'rendered') {
        e.preventDefault();
        lockSelection();
        setAutoExpandForm(true);
        return;
      }

      // Cmd+Shift+M : Start commenting on selection
      if (mod && e.shiftKey && e.key.toLowerCase() === 'm') {
        e.preventDefault();
        if (selectionRef.current) {
          lockSelection();
        }
        return;
      }

      // Cmd+Shift+[ / ] : Switch tabs (matches VS Code / Safari)
      if (mod && e.shiftKey && !isInput && activeModal !== 'commandPalette') {
        if (e.code === 'BracketLeft') {
          e.preventDefault();
          switchTabByOffset(-1);
          return;
        }

        if (e.code === 'BracketRight') {
          e.preventDefault();
          switchTabByOffset(1);
          return;
        }
      }

      // Keys below only work outside inputs and when the command palette is
      // closed. (The Mermaid fullscreen modal already short-circuited above.)
      if (isInput || activeModal === 'commandPalette') return;

      // ? : Toggle keyboard shortcuts help
      if (e.key === '?') {
        e.preventDefault();
        toggleModal('shortcuts');
        return;
      }

      if (mod || e.shiftKey || e.altKey) return;

      const key = e.key.toLowerCase();

      // Escape : Close search bar
      if (key === 'escape' && showSearch) {
        handleSearchClose();
        return;
      }

      // N / P : Jump to next / previous comment
      if (key === 'n') {
        e.preventDefault();
        handleJumpToNext();
        return;
      }
      if (key === 'p') {
        e.preventDefault();
        handleJumpToPrev();
        return;
      }

      // j / k : Navigate comments in sidebar (vim-style)
      if (key === 'j') {
        e.preventDefault();
        handleJumpToNext();
        return;
      }
      if (key === 'k') {
        e.preventDefault();
        handleJumpToPrev();
        return;
      }

      // A/X : Resolve active comment (only when resolve enabled)
      if ((key === 'a' || key === 'x') && activeCommentId && settings.enableResolve) {
        const comment = comments.find((c) => c.id === activeCommentId);
        if (comment && getEffectiveStatus(comment) === 'open') {
          e.preventDefault();
          handleResolve(activeCommentId);
        }
        return;
      }

      // U : Unresolve/reopen active comment (only when resolve enabled)
      if (key === 'u' && activeCommentId && settings.enableResolve) {
        const comment = comments.find((c) => c.id === activeCommentId);
        if (comment && getEffectiveStatus(comment) === 'resolved') {
          e.preventDefault();
          handleUnresolve(activeCommentId);
        }
        return;
      }

      // D : Delete active comment
      if (key === 'd' && activeCommentId) {
        e.preventDefault();
        handleDelete(activeCommentId);
        return;
      }
    };

    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [
    lockSelection,
    handleJumpToNext,
    handleJumpToPrev,
    handleAddComment,
    handleDelete,
    handleResolve,
    handleUnresolve,
    viewMode,
    activeCommentId,
    comments,
    settings.enableResolve,
    activeModal,
    toggleModal,
    handleSearchClose,
    explorerVisible,
    leftPanelView,
    openFilePicker,
    setExplorerVisibleGuarded,
    setLeftPanelView,
    switchTabByOffset,
    showSearch,
    setActiveModal,
    setSearchFocusTrigger,
    toggleExplorerPane,
    toggleCommentsSurface,
    toggleFocusMode,
  ]);

  useEffect(() => {
    const handleCopy = (e: ClipboardEvent) => {
      const fallbackText = getCopySelectionFallbackText({
        nativeSelectionText: window.getSelection()?.toString() ?? '',
        viewerSelectionText: selectionRef.current?.text ?? null,
        activeElement: document.activeElement as HTMLElement | null,
        viewMode,
      });
      if (!fallbackText || !e.clipboardData) return;

      // The viewer paints its own selection highlight, which clears the native
      // browser selection range. Restore expected copy behavior from app state.
      e.preventDefault();
      e.clipboardData.setData('text/plain', fallbackText);
    };

    document.addEventListener('copy', handleCopy);
    return () => document.removeEventListener('copy', handleCopy);
  }, [viewMode]);

  // Command palette commands — split into categories for manageable dependency arrays
  const navigationCommands = useMemo(
    (): Command[] => [
      {
        id: 'next-comment',
        label: 'Jump to next comment',
        shortcut: 'N / J',
        section: 'Navigation',
        onExecute: handleJumpToNext,
      },
      {
        id: 'prev-comment',
        label: 'Jump to previous comment',
        shortcut: 'P / K',
        section: 'Navigation',
        onExecute: handleJumpToPrev,
      },
      {
        id: 'prev-tab',
        label: 'Previous tab',
        shortcut: prevTabShortcut,
        section: 'Tabs',
        onExecute: () => switchTabByOffset(-1),
      },
      {
        id: 'next-tab',
        label: 'Next tab',
        shortcut: nextTabShortcut,
        section: 'Tabs',
        onExecute: () => switchTabByOffset(1),
      },
      {
        id: 'find',
        label: 'Find in document',
        shortcut: `${modKey}+F`,
        section: 'Navigation',
        onExecute: () => {
          setActiveModal('search');
          setSearchFocusTrigger((t) => t + 1);
        },
      },
    ],
    [handleJumpToNext, handleJumpToPrev, switchTabByOffset, setActiveModal, setSearchFocusTrigger],
  );

  const viewCommands = useMemo((): Command[] => {
    const cmds: Command[] = [
      {
        id: 'toggle-sidebar',
        label: 'Toggle comments rail',
        shortcut: `${modKey}+\\`,
        section: 'View',
        onExecute: () => toggleCommentsSurface(),
      },
      {
        id: 'toggle-focus-mode',
        label: 'Toggle focus mode',
        shortcut: `${modKey}+.`,
        section: 'View',
        onExecute: () => toggleFocusMode(),
      },
      {
        id: 'view-rendered',
        label: 'Switch to rendered view',
        section: 'View',
        onExecute: () => setViewMode('rendered'),
      },
      {
        id: 'doc-width-narrow',
        label: 'Document width: Narrow',
        section: 'View',
        onExecute: () => updateDocWidth('narrow'),
      },
      {
        id: 'doc-width-default',
        label: 'Document width: Default',
        section: 'View',
        onExecute: () => updateDocWidth('default'),
      },
      {
        id: 'doc-width-wide',
        label: 'Document width: Wide',
        section: 'View',
        onExecute: () => updateDocWidth('wide'),
      },
      {
        id: 'view-raw',
        label: 'Switch to raw markdown',
        section: 'View',
        onExecute: () => setViewMode('raw'),
      },
      {
        id: 'toggle-explorer',
        label: 'Toggle file explorer sidebar',
        shortcut: `${modKey}+B`,
        section: 'View',
        onExecute: () => toggleExplorerPane(),
      },
      {
        id: 'toggle-outline',
        label: 'Toggle document outline sidebar',
        shortcut: `${modKey}+Shift+O`,
        section: 'View',
        onExecute: () => {
          if (explorerVisible && leftPanelView === 'outline') {
            setExplorerVisibleGuarded(false);
          } else {
            setExplorerVisibleGuarded(true);
            setLeftPanelView('outline');
          }
        },
      },
    ];
    if (currentSnapshot) {
      cmds.push({
        id: 'toggle-diff-overlay',
        label: diffEnabled ? 'Hide diff' : 'Show diff',
        section: 'View',
        onExecute: handleDiffToggle,
      });
    }
    cmds.push({
      id: 'open-diagram-fullscreen',
      label: 'Open diagram in fullscreen',
      section: 'View',
      onExecute: () => {
        const blocks = document.querySelectorAll<HTMLElement>('.mermaid-block');
        if (blocks.length === 0) return;
        const center = window.innerHeight / 2;
        let best: HTMLElement | null = null;
        let bestDist = Infinity;
        for (const b of blocks) {
          const rect = b.getBoundingClientRect();
          const blockCenter = rect.top + rect.height / 2;
          const dist = Math.abs(blockCenter - center);
          if (dist < bestDist) {
            bestDist = dist;
            best = b;
          }
        }
        if (!best) return;
        const btn = best.querySelector<HTMLButtonElement>('.mermaid-block-expand');
        const source = btn?.dataset.mermaidSource;
        const blockIndex = Number(btn?.dataset.mermaidBlockIndex ?? '0');
        if (source) handleOpenMermaidFullscreen(source, blockIndex);
      },
    });
    return cmds;
  }, [
    setViewMode,
    updateDocWidth,
    setExplorerVisibleGuarded,
    setLeftPanelView,
    explorerVisible,
    leftPanelView,
    currentSnapshot,
    diffEnabled,
    handleDiffToggle,
    handleOpenMermaidFullscreen,
    toggleFocusMode,
    toggleExplorerPane,
    toggleCommentsSurface,
  ]);

  const fileCommands = useMemo((): Command[] => {
    const cmds: Command[] = [
      { id: 'reload-file', label: 'Reload file', section: 'File', onExecute: reloadFile },
      {
        id: 'open-file',
        label: 'Open file',
        shortcut: `${modKey}+O`,
        section: 'File',
        onExecute: openFilePicker,
      },
    ];
    if (diffChunkCount > 0) {
      cmds.push({
        id: 'mark-reviewed',
        label: 'Mark reviewed',
        section: 'File',
        onExecute: handleMarkReviewed,
      });
    }
    return cmds;
  }, [reloadFile, openFilePicker, handleMarkReviewed, diffChunkCount]);

  const generalCommands = useMemo(
    (): Command[] => [
      {
        id: 'open-settings',
        label: 'Open settings',
        shortcut: `${modKey}+,`,
        section: 'General',
        onExecute: () => setActiveModal('settings'),
      },
      {
        id: 'keyboard-shortcuts',
        label: 'Keyboard shortcuts',
        shortcut: '?',
        section: 'General',
        onExecute: () => setActiveModal('shortcuts'),
      },
      {
        id: 'theme-system',
        label: 'Theme: System',
        section: 'Theme',
        onExecute: () => setTheme('system'),
      },
      ...ALL_THEMES.map((t) => ({
        id: `theme-${t.key}`,
        label: `Theme: ${t.label}`,
        section: 'Theme',
        onExecute: () => setTheme(t.key),
      })),
    ],
    [setTheme, setActiveModal],
  );

  const commentCommands = useMemo((): Command[] => {
    const cmds: Command[] = [];
    if (settings.enableResolve && commentCount > 0) {
      cmds.push({
        id: 'resolve-all',
        label: 'Resolve all open comments',
        section: 'Comments',
        onExecute: handleBulkResolve,
      });
    }
    if (commentCount > 0) {
      cmds.push({
        id: 'delete-all',
        label: 'Delete all comments',
        section: 'Comments',
        onExecute: handleBulkDelete,
      });
      cmds.push({
        id: 'copy-agent-prompt',
        label: 'Hand off to agent (copy instructions)',
        section: 'Comments',
        onExecute: () => activeFilePath && handleHandoff([activeFilePath]),
      });
    }
    if (activeCommentId) {
      if (settings.enableResolve) {
        const activeComment = comments.find((c) => c.id === activeCommentId);
        if (activeComment) {
          const status = getEffectiveStatus(activeComment);
          if (status === 'open') {
            cmds.push({
              id: 'resolve-active',
              label: 'Resolve active comment',
              shortcut: 'A',
              section: 'Comments',
              onExecute: () => handleResolve(activeCommentId),
            });
          }
          if (status === 'resolved') {
            cmds.push({
              id: 'unresolve-active',
              label: 'Reopen active comment',
              shortcut: 'U',
              section: 'Comments',
              onExecute: () => handleUnresolve(activeCommentId),
            });
          }
        }
      }
      cmds.push({
        id: 'delete-active',
        label: 'Delete active comment',
        shortcut: 'D',
        section: 'Comments',
        onExecute: () => handleDelete(activeCommentId),
      });
    }
    return cmds;
  }, [
    commentCount,
    settings.enableResolve,
    handleBulkDelete,
    handleBulkResolve,
    handleHandoff,
    activeFilePath,
    activeCommentId,
    comments,
    handleResolve,
    handleUnresolve,
    handleDelete,
  ]);

  const headingCommands = useMemo(
    (): Command[] =>
      tocHeadings.map((h) => ({
        id: `heading-${h.id}`,
        label: `${'\u2003'.repeat(h.level - 1)}${h.text}`,
        section: 'Headings' as const,
        onExecute: () => handleHeadingNavigate(h.id),
      })),
    [tocHeadings, handleHeadingNavigate],
  );

  // Cycles through pending questions on repeat invocations instead of
  // always landing on the first one.
  const askCycleIndexRef = useRef(0);
  const agentAskCommands = useMemo((): Command[] => {
    const cmds: Command[] = [];
    if (agentAsks.length > 0) {
      cmds.push({
        id: 'jump-next-agent-question',
        label:
          agentAsks.length === 1
            ? 'Jump to agent question'
            : `Jump to next agent question (${agentAsks.length} pending)`,
        section: 'Comments',
        onExecute: () => {
          const ask = agentAsks[askCycleIndexRef.current % agentAsks.length];
          askCycleIndexRef.current = (askCycleIndexRef.current + 1) % agentAsks.length;
          if (ask) requestCommentFocus(ask.id);
        },
      });
    }
    return cmds;
  }, [agentAsks, requestCommentFocus]);

  const paletteCommands = useMemo(
    () => [
      ...navigationCommands,
      ...viewCommands,
      ...fileCommands,
      ...generalCommands,
      ...commentCommands,
      ...agentAskCommands,
      ...headingCommands,
    ],
    [
      navigationCommands,
      viewCommands,
      fileCommands,
      generalCommands,
      commentCommands,
      agentAskCommands,
      headingCommands,
    ],
  );

  // The directory the trust prompt would grant if the user clicks. For the
  // toolbar's access-denied state, this is the parent dir of the active tab's
  // file. Computed here so the Toolbar can render the path in its prompt.
  const accessDeniedDir =
    errorKind === 'access-denied' && activeFilePath
      ? (() => {
          const lastSlash = activeFilePath.lastIndexOf('/');
          return lastSlash > 0 ? activeFilePath.slice(0, lastSlash) : null;
        })()
      : null;

  // Optimistic sent IDs: updated immediately when a batch is sent, before
  // the server round-trip completes. Merged with the server's sentCommentIds
  // so the "Sent" badges appear instantly on click.
  const [optimisticSentIds, setOptimisticSentIds] = useState<string[]>([]);
  const handleBatchSent = useCallback(
    (ids: string[]) => {
      setOptimisticSentIds((prev) => [...prev, ...ids]);
      refreshReviewSessions();
    },
    [refreshReviewSessions],
  );

  const sentCommentIds = useMemo(() => {
    const serverIds = reviewSessions.flatMap((s) => s.sentCommentIds);
    if (optimisticSentIds.length === 0) return serverIds;
    return [...new Set([...serverIds, ...optimisticSentIds])];
  }, [reviewSessions, optimisticSentIds]);

  // Clear optimistic IDs when the review session ends
  useEffect(() => {
    if (reviewSessions.length === 0 && optimisticSentIds.length > 0) {
      setOptimisticSentIds([]);
    }
  }, [reviewSessions, optimisticSentIds]);

  // Tab badges answer "does this file have open comments", so they include
  // agent-initiated ones. The handoff button keeps the sendable-only map.
  const tabCommentCounts = useMemo(() => {
    const merged = new Map<string, number>();
    for (const [path, count] of commentCounts) {
      merged.set(path, count + (agentCommentCounts.get(path) ?? 0));
    }
    return merged;
  }, [commentCounts, agentCommentCounts]);

  return (
    <div className="h-screen flex bg-surface-secondary">
      {/* Full-height left sidebar: expanded panel or slim icon rail. It owns
          the window's left edge top to bottom (the chrome row starts to its
          right). Hidden entirely in focus mode. */}
      {!focusMode && (
          <>
            <div
              className={`relative border-r border-border bg-surface-secondary shrink-0 overflow-hidden ${
                isDragging ? '' : 'transition-[width] duration-200 ease-in-out'
              }`}
              style={{ width: explorerVisible ? explorerWidth : 40 }}
            >
              {/* Logo pinned to one spot so it never shifts between the
                  expanded and collapsed states. */}
              <div className="absolute top-0 left-0 w-10 h-11 flex items-center justify-center z-10 pointer-events-none">
                <AppLogo />
              </div>

              {/* Expanded panel. Fixed width so its content clips during the
                  width animation instead of reflowing. Mounted only while
                  open (the container keeps animating). */}
              {explorerVisible && (
              <div
                className="h-full flex flex-col"
                style={{ width: explorerWidth }}
                data-sidebar-panel
              >
              {/* Identity row: the pinned logo sits at its left; close at the
                  right. h-11 matches the chrome row so the hairline under
                  both aligns across the window. */}
              <div className="h-11 border-b border-transparent flex items-center justify-end pr-2 shrink-0">
                <button
                  onClick={() => setExplorerVisible(false)}
                  className="shrink-0 p-1 rounded-md text-content-muted hover:text-content-secondary hover:bg-tint transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                  title="Close panel"
                  aria-label="Close panel"
                >
                  <svg
                    className="w-3.5 h-3.5"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2}
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
              {/* View tabs */}
              <div className="h-10 flex items-center pl-1 pr-2 shrink-0">
                <div className="flex items-center gap-0.5">
                  <button
                    onClick={() => setLeftPanelView('explorer')}
                    className={`px-2.5 py-1.5 rounded text-xs font-medium transition-colors ${
                      leftPanelView === 'explorer'
                        ? 'bg-surface-inset text-content'
                        : 'text-content-muted hover:text-content-secondary hover:bg-tint/50'
                    }`}
                    title="File explorer"
                  >
                    <svg
                      className="w-3.5 h-3.5 inline-block mr-1 -mt-0.5"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={2}
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M3.75 9.776c.112-.017.227-.026.344-.026h15.812c.117 0 .232.009.344.026m-16.5 0a2.25 2.25 0 00-1.883 2.542l.857 6a2.25 2.25 0 002.227 1.932H19.05a2.25 2.25 0 002.227-1.932l.857-6a2.25 2.25 0 00-1.883-2.542m-16.5 0V6A2.25 2.25 0 016 3.75h3.879a1.5 1.5 0 011.06.44l2.122 2.12a1.5 1.5 0 001.06.44H18A2.25 2.25 0 0120.25 9v.776"
                      />
                    </svg>
                    Explorer
                  </button>
                  <button
                    onClick={() => setLeftPanelView('outline')}
                    className={`px-2.5 py-1.5 rounded text-xs font-medium transition-colors ${
                      leftPanelView === 'outline'
                        ? 'bg-surface-inset text-content'
                        : 'text-content-muted hover:text-content-secondary hover:bg-tint/50'
                    }`}
                    title="Document outline"
                  >
                    <svg
                      className="w-3.5 h-3.5 inline-block mr-1 -mt-0.5"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={2}
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M8.25 6.75h12M8.25 12h12m-12 5.25h12M3.75 6.75h.007v.008H3.75V6.75zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zM3.75 12h.007v.008H3.75V12zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm-.375 5.25h.007v.008H3.75v-.008zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z"
                      />
                    </svg>
                    Outline
                  </button>
                </div>
              </div>
              {/* Panel content */}
              {leftPanelView === 'explorer' ? (
                <FileExplorer
                  initialDir={explorerDir}
                  activeFilePath={activeFilePath}
                  homeDir={homeDir}
                  onOpenFile={handleExplorerOpenFile}
                  onClose={() => setExplorerVisible(false)}
                  onContextMenu={handleExplorerContextMenu}
                  onTrustFolder={handleTrustFolder}
                  hideHeader
                />
              ) : (
                <TableOfContents
                  headings={tocHeadings}
                  activeHeadingId={activeHeadingId}
                  onHeadingClick={handleHeadingNavigate}
                />
              )}
              {/* Settings pinned at the sidebar's bottom corner */}
              <div className="shrink-0 border-t border-border-subtle flex items-center px-2 py-1">
                <IconButton
                  size="md"
                  onClick={() => setActiveModal('settings')}
                  title={`Settings (${getPrimaryModifierLabel()}+,)`}
                >
                  <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 010 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 010-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28z"
                    />
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
                    />
                  </svg>
                </IconButton>
              </div>
            </div>

            )}

            {/* Collapsed icon rail: sits under the pinned logo, mounted only
                while collapsed. */}
            {!explorerVisible && (
            <div
              data-sidebar-rail
              className="absolute inset-y-0 left-0 w-10 flex flex-col items-center pt-11 pb-1 gap-1.5"
            >
            <IconButton
              size="md"
              onClick={() => {
                setExplorerVisible(true);
                setLeftPanelView('explorer');
              }}
              title={`Show Explorer (${getPrimaryModifierLabel()}+B)`}
            >
              <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M3.75 9.776c.112-.017.227-.026.344-.026h15.812c.117 0 .232.009.344.026m-16.5 0a2.25 2.25 0 00-1.883 2.542l.857 6a2.25 2.25 0 002.227 1.932H19.05a2.25 2.25 0 002.227-1.932l.857-6a2.25 2.25 0 00-1.883-2.542m-16.5 0V6A2.25 2.25 0 016 3.75h3.879a1.5 1.5 0 011.06.44l2.122 2.12a1.5 1.5 0 001.06.44H18A2.25 2.25 0 0120.25 9v.776"
                />
              </svg>
            </IconButton>
            <IconButton
              size="md"
              onClick={() => {
                setExplorerVisible(true);
                setLeftPanelView('outline');
              }}
              title="Show Outline"
            >
              <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M8.25 6.75h12M8.25 12h12m-12 5.25h12M3.75 6.75h.007v.008H3.75V6.75zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zM3.75 12h.007v.008H3.75V12zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm-.375 5.25h.007v.008H3.75v-.008zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z"
                />
              </svg>
            </IconButton>
            <div className="flex-1" />
            <IconButton
              size="md"
              onClick={() => setActiveModal('settings')}
              title={`Settings (${getPrimaryModifierLabel()}+,)`}
            >
              <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 010 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 010-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28z"
                />
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
                />
              </svg>
            </IconButton>
            </div>
            )}
            </div>
            {explorerVisible && (
              <div
                className="w-px shrink-0 cursor-col-resize hover:bg-primary/30 active:bg-primary/50 transition-colors relative group"
                onMouseDown={(e) => onResizeStart('explorer', e)}
              >
                <div className="absolute inset-y-0 -left-1 -right-1" />
              </div>
            )}
          </>
        )}

      {/* Main column: chrome row, document, status bar */}
      <div className="flex-1 min-w-0 flex flex-col">
      <ReviewBanner
        sessions={reviewSessions}
        commentCounts={commentCounts}
        agentCommentCounts={agentCommentCounts}
        onHandoffSuccess={handleReviewHandoffSuccess}
        onResolved={handleReviewResolved}
        onBatchSent={handleBatchSent}
        showToast={showToast}
        commentIdsByFile={commentIdsByFile}
        agentNamesBySession={agentNamesBySession}
        pendingAskCountsBySession={pendingAskCountsBySession}
        onJumpToAsk={handleJumpToAsk}
      />
      <Toolbar
        error={error}
        errorKind={errorKind}
        accessDeniedDir={accessDeniedDir}
        homeDir={homeDir}
        isLoading={isLoading}
        commentsSurfaceVisible={railShown || drawerOpen}
        author={author}
        onAuthorChange={setAuthor}
        onToggleSidebar={toggleCommentsSurface}
        onTrustFolder={handleTrustFolder}
        tabs={
          <TabBar
            embedded
            tabs={tabs}
            activeFilePath={activeFilePath}
            commentCounts={tabCommentCounts}
            resolvedCommentCounts={resolvedCommentCounts}
            onSwitchTab={switchTab}
            onCloseTab={closeTab}
            onOpenFile={openFilePicker}
            onTabContextMenu={handleTabContextMenu}
          />
        }
      />

      <>
        <div className="flex-1 flex min-h-0 relative">

          {/* Markdown viewer */}
          <div
            className="flex-1 min-h-0 min-w-0 relative panel-center bg-surface-secondary"
            data-prose-font={settings.proseFont}
          >
            {showSearch && (
              <SearchBar
                query={searchQuery}
                onQueryChange={handleSearchQueryChange}
                matchCount={searchMatchCount}
                activeIndex={activeSearchIndex}
                onNext={handleSearchNext}
                onPrev={handleSearchPrev}
                onClose={handleSearchClose}
                focusTrigger={searchFocusTrigger}
              />
            )}
            <div className="h-full flex flex-col">
              <PanelToolbar
                viewMode={viewMode}
                onViewModeChange={(mode) => {
                  setViewMode(mode);
                  if (mode === 'raw') {
                    clearSelection();
                    if (diffChunkCount > 0) {
                      setDiffEnabled(true);
                      setDiffPending(false);
                    }
                  }
                }}
                searchActive={showSearch}
                onSearch={() => {
                  if (showSearch) {
                    handleSearchClose();
                  } else {
                    setActiveModal('search');
                    setSearchFocusTrigger((t) => t + 1);
                  }
                }}
                commentCounts={commentCounts}
                activeFilePath={activeFilePath}
                onCopyAgentPrompt={handleHandoff}
                hasDiffSnapshot={currentSnapshot != null}
                diffEnabled={diffEnabled}
                diffPending={diffPending}
                diffChunkCount={diffChunkCount}
                referenceLabel={
                  diffEnabled && currentReference && diffChunkCount > 0
                    ? formatReferenceLabel(currentReference)
                    : undefined
                }
                onDiffToggle={handleDiffToggle}
                onDiffPrev={() => {
                  if (viewMode === 'raw') rawViewRef.current?.diffPrev();
                  else renderedDiffRef.current?.prev();
                }}
                onDiffNext={() => {
                  if (viewMode === 'raw') rawViewRef.current?.diffNext();
                  else renderedDiffRef.current?.next();
                }}
                onMarkReviewed={handleMarkReviewed}
                onCopyDocument={handleCopyDocument}
                copyFeedback={copyFeedback}
                breadcrumb={
                  railCapable ? (
                    <SectionBreadcrumb
                      chain={breadcrumbChain}
                      containerRef={containerRef}
                      onJump={handleHeadingNavigate}
                    />
                  ) : undefined
                }
                railControls={
                  railShown ? (
                    <RailDensityControl
                      density={railDensity}
                      onDensityChange={setRailDensity}
                      openCount={commentCount}
                    />
                  ) : undefined
                }
              />
              {viewMode === 'raw' ? (
                <RawView
                  ref={rawViewRef}
                  scrollContainerRef={containerRef}
                  rawMarkdown={rawMarkdown}
                  searchQuery={showSearch ? searchQuery : undefined}
                  searchActiveIndex={activeSearchIndex}
                  onSearchCount={handleSearchCount}
                  activeCommentId={activeCommentId}
                  diffSnapshot={currentSnapshot}
                  diffEnabled={diffEnabled}
                  diffLines={diffLines}
                  oldCleanToRawLine={oldCleanToRawLine}
                  newCleanToRawLine={newCleanToRawLine}
                />
              ) : (
                <div className="relative flex-1 min-h-0">
                  <div
                    ref={containerRef}
                    className="h-full overflow-y-auto pt-3 relative"
                  >
                    <div
                      ref={pageRef}
                      data-doc-page
                      className="doc-sheet bg-surface mx-auto relative pt-6 pb-[50vh] motion-safe:transition-[width] motion-safe:duration-150"
                      style={{
                        width: geometry.pageWidth,
                        maxWidth: 'calc(100% - 24px)',
                        minHeight: railShown
                          ? `max(100%, ${marginLayout.layerHeight + 120}px)`
                          : '100%',
                      }}
                    >
                      <div
                        className="motion-safe:transition-[width] motion-safe:duration-150"
                        style={{ marginLeft: PAD_L, width: geometry.colWidth }}
                      >
                        {diffEnabled && currentSnapshot && diffLines ? (
                          // key on activeFilePath forces a remount when the user
                          // switches files while the diff overlay is on, so the
                          // mount-time auto-scroll-to-first-chunk fires for each
                          // file's diff. Without this, the [] effect in
                          // RenderedDiffView only runs for the first file viewed.
                          <RenderedDiffView
                            key={activeFilePath ?? ''}
                            ref={renderedDiffRef}
                            rawMarkdown={rawMarkdown}
                            diffSnapshot={currentSnapshot}
                            diffLines={diffLines}
                          />
                        ) : (
                          <>
                            {viewerNeedsTheme ? (
                              <ThemedMarkdownViewer
                                ref={viewerRef}
                                html={html}
                                cleanMarkdown={cleanMarkdown}
                                comments={comments}
                                activeCommentId={activeCommentId}
                                selectionText={selection?.text ?? null}
                                selectionOffset={selection?.offset ?? null}
                                onHighlightClick={handleHighlightClickWithPopover}
                                // Fragment arg is intentionally ignored in v1; openTab
                                // takes only the path. See spec §3 non-goals.
                                onLocalLinkClick={openTab}
                                onContextMenu={handleViewerContextMenu}
                                enableResolve={settings.enableResolve}
                                searchQuery={showSearch ? searchQuery : undefined}
                                searchActiveIndex={activeSearchIndex}
                                onSearchCount={handleSearchCount}
                                sentCommentIds={sentCommentIds}
                                mermaidSvgMap={mermaidSvgMap}
                                onOpenMermaidFullscreen={handleOpenMermaidFullscreen}
                                onHighlightsPainted={handleHighlightsPainted}
                              />
                            ) : (
                              <MarkdownViewer
                                ref={viewerRef}
                                html={html}
                                cleanMarkdown={cleanMarkdown}
                                comments={comments}
                                activeCommentId={activeCommentId}
                                selectionText={selection?.text ?? null}
                                selectionOffset={selection?.offset ?? null}
                                onHighlightClick={handleHighlightClickWithPopover}
                                // Fragment arg is intentionally ignored in v1; openTab
                                // takes only the path. See spec §3 non-goals.
                                onLocalLinkClick={openTab}
                                onContextMenu={handleViewerContextMenu}
                                enableResolve={settings.enableResolve}
                                searchQuery={showSearch ? searchQuery : undefined}
                                searchActiveIndex={activeSearchIndex}
                                onSearchCount={handleSearchCount}
                                sentCommentIds={sentCommentIds}
                                mermaidSvgMap={mermaidSvgMap}
                                onOpenMermaidFullscreen={handleOpenMermaidFullscreen}
                                onHighlightsPainted={handleHighlightsPainted}
                              />
                            )}
                            <DragHandles
                              startPos={handlePositions?.start ?? null}
                              endPos={handlePositions?.end ?? null}
                              onMouseDown={onHandleMouseDown}
                            />
                          </>
                        )}
                      </div>
                      {railShown && (
                        <CommentsRail
                          density={railDensity}
                          scrollRef={containerRef as RefObject<HTMLElement | null>}
                          layout={marginLayout}
                          anchoredComments={marginComments}
                          allComments={comments}
                          activeCommentId={activeCommentId}
                          missingAnchors={missingAnchors}
                          sentCommentIds={sentCommentIds}
                          onActivate={handleSidebarActivate}
                          onReply={handleReply}
                          onResolve={settings.enableResolve ? handleResolve : undefined}
                          onUnresolve={settings.enableResolve ? handleUnresolve : undefined}
                          onDelete={handleDelete}
                          onEdit={handleEdit}
                          onEditReply={handleEditReply}
                          onDeleteReply={handleDeleteReply}
                          onBulkDelete={handleBulkDelete}
                          onBulkResolve={handleBulkResolve}
                          onBulkDeleteResolved={handleBulkDeleteResolved}
                          onContextMenu={handleSidebarContextMenu}
                          selectionText={selection?.text ?? null}
                          selectionOffset={selection?.offset ?? null}
                          onReanchorToSelection={handleReanchorToSelection}
                          requestedEditor={requestedEditor}
                          requestedFocus={requestedCommentFocus}
                          onFocusHandled={() => setRequestedCommentFocus(null)}
                        />
                      )}
                      {popoverCommentId &&
                        !railShown &&
                        (() => {
                          const c = comments.find((x) => x.id === popoverCommentId);
                          if (!c) return null;
                          return (
                            <CommentPopover
                              comment={c}
                              pageRef={pageRef as RefObject<HTMLElement | null>}
                              onClose={() => setPopoverCommentId(null)}
                              sent={sentCommentIds.includes(c.id)}
                              anchorMissing={missingAnchors.has(c.id)}
                              onReply={handleReply}
                              onResolve={settings.enableResolve ? handleResolve : undefined}
                              onUnresolve={settings.enableResolve ? handleUnresolve : undefined}
                              onDelete={handleDelete}
                              onEdit={handleEdit}
                              onEditReply={handleEditReply}
                              onDeleteReply={handleDeleteReply}
                            />
                          );
                        })()}
                    </div>
                  </div>
                  <DensityStrip ticks={commentTicks} onJump={handleSidebarActivate} />
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Floating comment form (disabled in raw/diff view) */}
        {selection && viewMode === 'rendered' && (
          <CommentForm
            selection={selection}
            autoExpand={autoExpandForm}
            onSubmit={(anchor, text, ctxBefore, ctxAfter, hintOffset) => {
              handleAddComment(anchor, text, ctxBefore, ctxAfter, hintOffset);
              setAutoExpandForm(false);
            }}
            onCancel={() => {
              clearSelection();
              setAutoExpandForm(false);
            }}
            onLock={lockSelection}
          />
        )}
      </>

      {/* Toast notification (Feature 8) */}
      <Toast
        message={toast.message}
        visible={toast.visible}
        onDismiss={dismissToast}
        action={toast.action}
        kind={toast.kind}
      />

      {/* Comments drawer: the comment surface wherever the rail can't show */}
      <CommentsDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        comments={comments}
        activeCommentId={activeCommentId}
        missingAnchors={missingAnchors}
        selectionText={selection?.text ?? null}
        selectionOffset={selection?.offset ?? null}
        onReanchorToSelection={handleReanchorToSelection}
        onActivate={handleSidebarActivate}
        onResolve={handleResolve}
        onUnresolve={handleUnresolve}
        onDelete={handleDelete}
        onEdit={handleEdit}
        onReply={handleReply}
        onEditReply={handleEditReply}
        onDeleteReply={handleDeleteReply}
        onBulkDelete={handleBulkDelete}
        onBulkResolve={handleBulkResolve}
        onBulkDeleteResolved={handleBulkDeleteResolved}
        onContextMenu={handleSidebarContextMenu}
        requestedEditor={requestedEditor}
        requestedFocus={drawerOpen ? requestedCommentFocus : null}
        onFocusHandled={() => setRequestedCommentFocus(null)}
        sentCommentIds={sentCommentIds}
      />

      {/* Command palette */}
      <CommandPalette
        commands={paletteCommands}
        open={activeModal === 'commandPalette'}
        onClose={() => setActiveModal(null)}
      />

      {/* File opener */}
      <FileOpener
        open={activeModal === 'fileOpener'}
        onClose={() => setActiveModal(null)}
        onOpenFile={(path) => {
          handleOpenFile(path);
          setActiveModal(null);
        }}
        recentFiles={recentFiles}
        activeFilePath={activeFilePath}
        onClearRecent={clearRecentFiles}
      />

      {/* Mermaid fullscreen modal */}
      <MermaidFullscreenModal
        open={mermaidFullscreen.isOpen}
        source={activeMermaidBlock?.source ?? mermaidFullscreen.activeSource}
        blockIndex={activeMermaidBlock?.index ?? mermaidFullscreen.activeBlockIndex}
        svgHtml={activeMermaidSvg}
        cleanMarkdown={cleanMarkdown}
        comments={comments}
        activeCommentId={activeCommentId}
        onClose={mermaidFullscreen.close}
        onAddComment={(anchor, text, ctxBefore, ctxAfter, hintOffset) => {
          // The hint offset coming out of the modal is in canvas-text-content
          // coordinates and isn't meaningful in markdown space, so we ignore
          // it and instead point insertComment at the anchor's position
          // INSIDE this diagram's source block.
          //
          // insertComment expects the hint in plain-text coordinates (the
          // text produced by stripInlineFormatting, which strips fenced-code
          // delimiters), not raw clean-markdown coordinates. If we pass a
          // raw source position, pickBestOccurrence ranks it against
          // plain-text positions and can prefer a nearby prose occurrence —
          // the comment then ends up filed against the prose, and
          // commentsForDiagram filters it out of the diagram panel.
          let adjustedHint = hintOffset;
          if (activeMermaidBlock) {
            // Point insertComment at the active fenced block as it exists now.
            // The fullscreen modal may stay open while earlier diagrams are
            // inserted or removed, so the original source-order index can drift.
            const anchorInSource = activeMermaidBlock.source.indexOf(anchor);
            const cleanHint =
              activeMermaidBlock.sourceStart + (anchorInSource >= 0 ? anchorInSource : 0);
            const { toPlainOffset } = stripInlineFormatting(cleanMarkdown);
            adjustedHint = toPlainOffset(cleanHint);
          }
          handleAddComment(anchor, text, ctxBefore, ctxAfter, adjustedHint);
        }}
        onReply={handleReply}
        onResolve={settings.enableResolve ? handleResolve : undefined}
        onUnresolve={settings.enableResolve ? handleUnresolve : undefined}
        onDelete={handleDelete}
        onEdit={handleEdit}
        onEditReply={handleEditReply}
        onDeleteReply={handleDeleteReply}
        onActivateComment={setActiveCommentId}
        panelWidth={mermaidPanelWidth}
        onPanelResizeStart={(e) => onResizeStart('mermaidPanel', e)}
        isResizing={isDragging}
      />

      {/* Context menus */}
      {viewerCtxMenu.isOpen && (
        <ContextMenu
          items={ctxMenuItems}
          position={viewerCtxMenu.position}
          onClose={viewerCtxMenu.close}
        />
      )}
      {explorerCtxMenu.isOpen && (
        <ContextMenu
          items={explorerCtxMenuItems}
          position={explorerCtxMenu.position}
          onClose={explorerCtxMenu.close}
        />
      )}
      {tabCtxMenu.isOpen && (
        <ContextMenu
          items={tabCtxMenuItems}
          position={tabCtxMenu.position}
          onClose={tabCtxMenu.close}
        />
      )}
      {sidebarCtxMenu.isOpen && (
        <ContextMenu
          items={sidebarCtxMenuItems}
          position={sidebarCtxMenu.position}
          onClose={sidebarCtxMenu.close}
        />
      )}

      {/* Settings panel */}
      <SettingsPanel
        open={activeModal === 'settings'}
        onClose={() => setActiveModal(null)}
        author={author}
        onAuthorChange={setAuthor}
      />
      <KeyboardShortcutsPanel
        open={activeModal === 'shortcuts'}
        onClose={() => setActiveModal(null)}
        resolveEnabled={settings.enableResolve}
      />

      <ConfirmDialog
        open={pendingClose !== null}
        title="Unsaved changes"
        message="This file has unsaved changes that will be lost. Close anyway?"
        confirmLabel="Close"
        cancelLabel="Cancel"
        onConfirm={executePendingClose}
        onCancel={() => setPendingClose(null)}
      />

      {/* Keyboard shortcuts hint */}
      <div className="h-6 bg-surface-secondary border-t border-border flex items-center px-4 gap-4 text-[10px] text-content-secondary shrink-0">
        <span>
          <kbd className="px-1 py-0.5 bg-surface rounded border border-border-subtle text-content-secondary font-mono">
            {modKey}+K
          </kbd>{' '}
          Commands
        </span>
        {focusMode && (
          <button
            type="button"
            data-focus-chip
            onClick={exitFocusMode}
            title="Exit focus mode"
            className="px-2 py-0.5 rounded-full bg-primary-bg text-primary-text text-[10px] font-medium hover:bg-primary-bg-strong transition-colors cursor-pointer"
          >
            Focus
          </button>
        )}
        <span className="ml-auto">
          <kbd className="px-1 py-0.5 bg-surface rounded border border-border-subtle text-content-secondary font-mono">
            ?
          </kbd>{' '}
          Shortcuts
        </span>
      </div>
      </div>
    </div>
  );
}
