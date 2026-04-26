import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { MdComment } from '../types';

/**
 * Pick the SVG <text> element that a comment is anchored to.
 *
 * 1. Prefer an exact textContent match — this covers the common case where the
 *    user selected a complete node label.
 * 2. Otherwise look for substring matches. If only one node contains the
 *    anchor we use it; if multiple do, we disambiguate by checking which
 *    candidate has preceding sibling text matching the comment's
 *    `contextBefore` tail.
 */
function findMatchingTextNode(
  textNodes: SVGTextElement[],
  comment: MdComment,
): { node: SVGTextElement } | null {
  // Prefer exact textContent matches over substring matches, but in either
  // case if there's more than one candidate, fall through to context-based
  // disambiguation. (Repeated labels — same `OK` reply twice in a sequence
  // diagram, two participants with the same name — are common enough that
  // first-match-wins drops the comment on the wrong node.)
  const exact = textNodes.filter((t) => (t.textContent || '').trim() === comment.anchor);
  if (exact.length === 1) return { node: exact[0] };
  if (exact.length > 1) return { node: pickByContext(exact, textNodes, comment) ?? exact[0] };

  const candidates = textNodes.filter((t) => (t.textContent || '').includes(comment.anchor));
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return { node: candidates[0] };
  return { node: pickByContext(candidates, textNodes, comment) ?? candidates[0] };
}

function pickByContext(
  candidates: SVGTextElement[],
  textNodes: SVGTextElement[],
  comment: MdComment,
): SVGTextElement | null {
  const contextTail =
    comment.contextBefore?.trim().split(/\s+/).slice(-3).join(' ').trim() ?? '';
  if (!contextTail) return null;
  for (const cand of candidates) {
    const idx = textNodes.indexOf(cand);
    const preceding = textNodes
      .slice(Math.max(0, idx - 8), idx)
      .map((t) => (t.textContent || '').trim())
      .filter(Boolean)
      .join(' ');
    if (preceding.endsWith(contextTail) || preceding.includes(contextTail)) {
      return cand;
    }
  }
  return null;
}
import {
  MermaidPanZoomCanvas,
  type MermaidPanZoomCanvasHandle,
} from './MermaidPanZoomCanvas';
import { MermaidThreadPanel } from './MermaidThreadPanel';
import { CommentForm } from './CommentForm';
import { IconButton } from './IconButton';
import { useSelection } from '../hooks/useSelection';
import { useSettings } from '../contexts/SettingsContext';
import { getPrimaryModifierLabel } from '../lib/platform';
import {
  commentsForDiagram,
  orderThreadsBySvgPosition,
} from '../lib/mermaid-diagram-comments';
import {
  applyMermaidSvgTextHighlight,
  getMermaidHighlightTheme,
} from '../lib/mermaid-highlights';
import './MermaidFullscreenModal.css';

export interface MermaidFullscreenModalProps {
  open: boolean;
  source: string | null;
  /** 0-based source-order index of the active block. Disambiguates duplicates. */
  blockIndex: number | null;
  svgHtml: string | null;
  /** Full clean markdown — used to attribute comments to a specific diagram block. */
  cleanMarkdown: string;
  comments: MdComment[];
  activeCommentId: string | null;
  onClose: () => void;
  onAddComment: (
    anchor: string,
    text: string,
    contextBefore: string,
    contextAfter: string,
    hintOffset: number,
  ) => void;
  onReply: (commentId: string, text: string) => void;
  onResolve?: (commentId: string) => void;
  onUnresolve?: (commentId: string) => void;
  onDelete: (commentId: string) => void;
  onEdit: (commentId: string, newText: string) => void;
  onEditReply: (commentId: string, replyId: string, newText: string) => void;
  onDeleteReply: (commentId: string, replyId: string) => void;
  onActivateComment: (commentId: string) => void;
  /** Pixel width of the comment panel — wired through `useResizablePanel` so
   * the user can drag to resize, matching the main app's sidebar. */
  panelWidth: number;
  /** Drag start handler from `useResizablePanel`. */
  onPanelResizeStart: (e: React.MouseEvent) => void;
  /** True while the user is dragging — disables the panel's width transition
   * to avoid laggy follow-along. */
  isResizing: boolean;
}

export function MermaidFullscreenModal({
  open,
  source,
  blockIndex,
  svgHtml,
  cleanMarkdown,
  comments,
  activeCommentId,
  onClose,
  onAddComment,
  onReply,
  onResolve,
  onUnresolve,
  onDelete,
  onEdit,
  onEditReply,
  onDeleteReply,
  onActivateComment,
  panelWidth,
  onPanelResizeStart,
  isResizing,
}: MermaidFullscreenModalProps) {
  const canvasRef = useRef<MermaidPanZoomCanvasHandle>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const { settings, updateMermaidFullscreenPanelCollapsed } = useSettings();
  const panelVisible = !settings.mermaidFullscreenPanelCollapsed;
  const modLabel = getPrimaryModifierLabel();
  // Ref to the canvas inner DOM element, used to scope text-selection detection
  // to the diagram surface (so selecting comment-thread text in the side panel
  // doesn't trigger the floating comment form).
  const canvasInnerRef = useRef<HTMLElement | null>(null);

  // Capture the canvas inner element after the modal renders so useSelection
  // has a real container to scope to.
  useLayoutEffect(() => {
    if (!open) {
      canvasInnerRef.current = null;
      return;
    }
    const root = rootRef.current;
    canvasInnerRef.current =
      (root?.querySelector('.mermaid-fullscreen-canvas-inner') as HTMLElement | null) ?? null;
  }, [open, svgHtml]);

  const { selection, clearSelection, lockSelection } = useSelection(canvasInnerRef);

  // Modal stays mounted (returns null) when closed, which means useSelection
  // state survives across opens. Without this, closing while a CommentForm is
  // visible would re-render the same form at the stale rect on next open.
  useEffect(() => {
    if (!open) clearSelection();
  }, [open, clearSelection]);

  // Auto-close when svgHtml is null while open.
  useEffect(() => {
    if (open && svgHtml === null) {
      onClose();
    }
  }, [open, svgHtml, onClose]);

  // Keyboard handlers: Esc, +/-/0 zoom, arrows pan.
  useEffect(() => {
    if (!open) return;
    const PAN_STEP = 60;
    const ZOOM_IN = 1.2;
    const ZOOM_OUT = 1 / 1.2;
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      const inEditable =
        tag === 'INPUT' ||
        tag === 'TEXTAREA' ||
        (e.target as HTMLElement | null)?.isContentEditable;
      if (e.key === 'Escape') {
        // If the user is typing in the comment composer (or any other
        // editable) or has an active selection bubble showing, defer to the
        // composer/useSelection's own Esc handling (which clears the
        // selection / cancels the form). Closing the whole modal here would
        // drop the in-progress draft.
        if (inEditable || selection) return;
        e.stopPropagation();
        onClose();
        return;
      }
      if (inEditable) return;
      if (e.key === '+' || e.key === '=') {
        e.preventDefault();
        canvasRef.current?.zoomBy(ZOOM_IN);
      } else if (e.key === '-' || e.key === '_') {
        e.preventDefault();
        canvasRef.current?.zoomBy(ZOOM_OUT);
      } else if (e.key === '0') {
        e.preventDefault();
        canvasRef.current?.fitToScreen();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        canvasRef.current?.panBy(0, PAN_STEP);
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        canvasRef.current?.panBy(0, -PAN_STEP);
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        canvasRef.current?.panBy(PAN_STEP, 0);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        canvasRef.current?.panBy(-PAN_STEP, 0);
      } else if (e.key === '\\' && (e.metaKey || e.ctrlKey)) {
        // Mirror the main app's Cmd+\ shortcut for the comment panel toggle.
        e.preventDefault();
        updateMermaidFullscreenPanelCollapsed(!settings.mermaidFullscreenPanelCollapsed);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [
    open,
    onClose,
    selection,
    settings.mermaidFullscreenPanelCollapsed,
    updateMermaidFullscreenPanelCollapsed,
  ]);

  // Filter comments for this diagram.
  const threadsForDiagram = useMemo(() => {
    if (!source) return [];
    return commentsForDiagram(source, comments, cleanMarkdown, blockIndex ?? undefined);
  }, [source, comments, cleanMarkdown, blockIndex]);

  // Apply highlights on threads/active changes. Defer the work into a
  // requestAnimationFrame so we run AFTER the SVG has been mounted by
  // MermaidPanZoomCanvas's effect and the browser has computed its layout —
  // applyMermaidSvgTextHighlight calls getBBox(), which returns zeros until
  // the SVG has had a paint cycle.
  useEffect(() => {
    if (!open || !rootRef.current) return;

    let cancelled = false;
    const run = () => {
      if (cancelled || !rootRef.current) return;
      const svg = rootRef.current.querySelector<SVGSVGElement>(
        '.mermaid-fullscreen-canvas-inner svg',
      );
      if (!svg) {
        // SVG not yet mounted — try again next frame.
        rafId = window.requestAnimationFrame(run);
        return;
      }

      // Clear all stale highlights from prior passes.
      svg.querySelectorAll('.mermaid-svg-text-highlight-bg').forEach((rect) => rect.remove());
      svg
        .querySelectorAll<SVGTextElement>(
          '.mermaid-comment-highlight, .mermaid-comment-highlight-active',
        )
        .forEach((t) => {
          t.classList.remove('mermaid-comment-highlight', 'mermaid-comment-highlight-active');
          delete t.dataset.commentIds;
        });

      if (threadsForDiagram.length === 0) return;

      const theme = getMermaidHighlightTheme(getComputedStyle(document.documentElement));
      const textNodes = Array.from(svg.querySelectorAll<SVGTextElement>('text'));

      // Iterate one comment at a time and draw a separate highlight rect per
      // comment, keyed by comment.id. This means two comments anchored to
      // different substrings of the same `<text>` (e.g. "POST" and
      // "/checkout" in "POST /checkout") each get their own visible range,
      // and `data-comment-ids` accumulates ids from every comment that maps
      // to the node so click-to-activate still works for any of them.
      for (const c of threadsForDiagram) {
        const target = findMatchingTextNode(textNodes, c);
        if (!target) continue;
        const t = target.node;
        const text = t.textContent || '';
        const start = text.indexOf(c.anchor);
        if (start === -1) continue;
        const end = start + c.anchor.length;
        const isActive = c.id === activeCommentId;
        t.classList.add('mermaid-comment-highlight');
        if (isActive) t.classList.add('mermaid-comment-highlight-active');
        const existing = t.dataset.commentIds ? t.dataset.commentIds.split(',') : [];
        if (!existing.includes(c.id)) existing.push(c.id);
        t.dataset.commentIds = existing.join(',');
        applyMermaidSvgTextHighlight(t, theme, isActive, start, end, c.id);
      }
    };

    let rafId = window.requestAnimationFrame(run);
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(rafId);
    };
  }, [open, threadsForDiagram, activeCommentId, svgHtml]);

  // Imperatively pan + pulse when the user explicitly clicks a thread in the
  // side panel. We don't drive this from an activeCommentId effect, because
  // submitting a new comment also sets activeCommentId — and the user is
  // already looking at the node they just commented on, so panning back to it
  // would visibly shift the diagram from under them.
  const panToCommentAnchor = (commentId: string) => {
    if (!rootRef.current || !canvasRef.current) return;
    const target = threadsForDiagram.find((c) => c.id === commentId);
    if (!target) return;
    const svg = rootRef.current.querySelector<SVGSVGElement>(
      '.mermaid-fullscreen-canvas-inner svg',
    );
    if (!svg) return;
    // Use the same matcher as the highlight pass so a comment anchored to a
    // duplicate label (e.g. the second `OK` reply in a sequence diagram) pans
    // to the right node, not always to the first.
    const textNodes = Array.from(svg.querySelectorAll<SVGTextElement>('text'));
    const node = findMatchingTextNode(textNodes, target)?.node ?? null;
    if (!node) return;
    canvasRef.current.panToElement(node);
    canvasRef.current.pulseElement(node);
  };

  const handleSelectThread = (commentId: string) => {
    onActivateComment(commentId);
    panToCommentAnchor(commentId);
  };


  // Order threads by their position in the SVG. The DOM read has to happen
  // after `MermaidPanZoomCanvas` inserts the SVG in its effect, which runs
  // *after* this component's useLayoutEffect. We retry on each frame until
  // the SVG appears, then settle. Without the retry, the very first open
  // would always show comments in storage order until something else
  // triggered a re-run.
  const [orderedComments, setOrderedComments] = useState<MdComment[]>(threadsForDiagram);
  useLayoutEffect(() => {
    if (!open) {
      setOrderedComments(threadsForDiagram);
      return;
    }
    let cancelled = false;
    let rafId = 0;
    const tryOrder = () => {
      if (cancelled) return;
      const svg = rootRef.current?.querySelector<SVGSVGElement>(
        '.mermaid-fullscreen-canvas-inner svg',
      ) ?? null;
      if (!svg) {
        rafId = window.requestAnimationFrame(tryOrder);
        return;
      }
      setOrderedComments(
        orderThreadsBySvgPosition(threadsForDiagram, svg).map((t) => t.comment),
      );
    };
    rafId = window.requestAnimationFrame(tryOrder);
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(rafId);
    };
  }, [open, threadsForDiagram, svgHtml]);

  // Click on a highlighted SVG label activates the corresponding comment —
  // mirrors what MarkdownViewer does for the inline view, so users can pick
  // a thread by clicking the diagram itself instead of going to the panel.
  const handleCanvasClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) {
      onClose();
      return;
    }
    const target = e.target as Element | null;
    const labeled = target?.closest<SVGElement>('.mermaid-comment-highlight');
    if (!labeled) return;
    const ids = (labeled as SVGElement & { dataset: DOMStringMap }).dataset.commentIds;
    if (!ids) return;
    const idList = ids.split(',').filter(Boolean);
    if (idList.length === 0) return;

    // When a single text element carries multiple comment highlights (e.g.
    // "POST" and "/checkout" both anchored inside "POST /checkout"), pick the
    // comment whose highlight rect actually contains the click. Each highlight
    // tags its rects with `data-mdr-highlight-for="${textId}-${commentId}"`,
    // so we can hit-test the click coords against those siblings.
    let chosenId = idList[0];
    if (idList.length > 1) {
      const textId = labeled.getAttribute('data-mdr-highlight-id');
      const parent = labeled.parentNode as Element | null;
      if (textId && parent) {
        const rects = parent.querySelectorAll<SVGRectElement>(
          `.mermaid-svg-text-highlight-bg[data-mdr-highlight-for^="${textId}-"]`,
        );
        for (const rect of rects) {
          const r = rect.getBoundingClientRect();
          if (
            e.clientX >= r.left &&
            e.clientX <= r.right &&
            e.clientY >= r.top &&
            e.clientY <= r.bottom
          ) {
            const tag = rect.getAttribute('data-mdr-highlight-for') ?? '';
            const cid = tag.slice(textId.length + 1);
            if (idList.includes(cid)) {
              chosenId = cid;
              break;
            }
          }
        }
      }
    }
    handleSelectThread(chosenId);
  };

  if (!open || !svgHtml) return null;

  return (
    <div
      ref={rootRef}
      className="mermaid-fullscreen-modal"
      role="dialog"
      aria-modal="true"
      aria-label="Diagram fullscreen view"
      onClick={handleCanvasClick}
    >
      <div className="mermaid-fullscreen-shell">
        <div className="mermaid-fullscreen-toolbar">
          <IconButton
            size="md"
            onClick={() => canvasRef.current?.zoomBy(1.2)}
            title="Zoom in (+)"
            aria-label="Zoom in"
          >
            <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
            </svg>
          </IconButton>
          <IconButton
            size="md"
            onClick={() => canvasRef.current?.zoomBy(1 / 1.2)}
            title="Zoom out (−)"
            aria-label="Zoom out"
          >
            <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 12h14" />
            </svg>
          </IconButton>
          <IconButton
            size="md"
            onClick={() => canvasRef.current?.fitToScreen()}
            title="Fit to screen (0)"
            aria-label="Fit to screen"
          >
            <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M7.5 3.75H6A2.25 2.25 0 0 0 3.75 6v1.5M16.5 3.75H18A2.25 2.25 0 0 1 20.25 6v1.5m0 9V18A2.25 2.25 0 0 1 18 20.25h-1.5m-9 0H6A2.25 2.25 0 0 1 3.75 18v-1.5M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z"
              />
            </svg>
          </IconButton>

          <div className="mermaid-fullscreen-toolbar-spacer" />

          <IconButton
            variant="active"
            active={panelVisible}
            size="md"
            onClick={() => updateMermaidFullscreenPanelCollapsed(panelVisible)}
            title={`Toggle comment panel (${modLabel}+\\)`}
            aria-label="Toggle comment panel"
          >
            <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.129.166 2.27.293 3.423.379.35.026.67.21.865.501L12 21l2.755-4.133a1.14 1.14 0 01.865-.501 48.172 48.172 0 003.423-.379c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0012 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018z"
              />
            </svg>
          </IconButton>
          <IconButton
            size="md"
            onClick={onClose}
            title="Close (Esc)"
            aria-label="Close fullscreen view"
          >
            <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
            </svg>
          </IconButton>
        </div>

        <div className="mermaid-fullscreen-body">
          <MermaidPanZoomCanvas
            ref={canvasRef}
            svgHtml={svgHtml}
            contentKey={source ?? ''}
          />
          {/* Resize handle, mirrors `<App>`'s sidebar divider — same hover
              feedback, same drag affordance, only renders while the panel
              is visible so it can't be clicked when the panel is hidden. */}
          {panelVisible && (
            <div
              className="w-px shrink-0 cursor-col-resize hover:bg-primary/30 active:bg-primary/50 transition-colors relative group"
              onMouseDown={onPanelResizeStart}
            >
              <div className="absolute inset-y-0 -left-1 -right-1" />
            </div>
          )}
          <div
            className={`border-l border-border bg-surface-secondary shrink-0 flex flex-col overflow-hidden ${
              panelVisible ? '' : 'w-0 border-l-0'
            } ${isResizing ? '' : 'transition-[width] duration-200 ease-in-out'}`}
            style={panelVisible ? { width: panelWidth } : undefined}
          >
            <MermaidThreadPanel
              threads={orderedComments}
              activeCommentId={activeCommentId}
              onSelectThread={handleSelectThread}
              onReply={onReply}
              onResolve={onResolve}
              onUnresolve={onUnresolve}
              onDelete={onDelete}
              onEdit={onEdit}
              onEditReply={onEditReply}
              onDeleteReply={onDeleteReply}
            />
          </div>
        </div>
      </div>

      {selection && (
        <CommentForm
          selection={selection}
          onSubmit={(anchor, text, ctxBefore, ctxAfter, hintOffset) => {
            onAddComment(anchor, text, ctxBefore, ctxAfter, hintOffset);
            clearSelection();
          }}
          onCancel={clearSelection}
          onLock={lockSelection}
        />
      )}
    </div>
  );
}
