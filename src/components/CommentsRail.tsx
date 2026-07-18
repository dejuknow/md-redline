import { useEffect, useRef, useState } from 'react';
import type { MdComment } from '../types';
import type { MarginLayout } from '../hooks/useMarginLayout';
import type { RailDensity } from '../hooks/usePaneLayout';
import type { SidebarCommentEditorState } from '../lib/comment-editor-state';
import { GAP, RAIL, PAD_R } from '../lib/page-geometry';
import { ThreadCard } from './ThreadCard';
import {
  CommentListSurface,
  type SidebarContextMenuInfo,
  type SidebarCommentFocusRequest,
} from './CommentListSurface';

interface CommentsRailProps {
  density: RailDensity;
  scrollRef: React.RefObject<HTMLElement | null>;
  layout: MarginLayout;
  anchoredComments: MdComment[];
  allComments: MdComment[];
  activeCommentId: string | null;
  missingAnchors: Set<string>;
  sentCommentIds: string[];
  onActivate: (id: string) => void;
  onReply: (commentId: string, text: string) => void;
  onResolve?: (id: string) => void;
  onUnresolve?: (id: string) => void;
  onDelete: (id: string) => void;
  onEdit: (id: string, newText: string) => void;
  onEditReply: (commentId: string, replyId: string, newText: string) => void;
  onDeleteReply: (commentId: string, replyId: string) => void;
  onBulkDelete: () => void;
  onBulkResolve?: () => void;
  onBulkDeleteResolved?: () => void;
  onContextMenu?: (info: SidebarContextMenuInfo) => void;
  requestedEditor?: SidebarCommentEditorState;
  requestedFocus?: SidebarCommentFocusRequest | null;
  onFocusHandled?: () => void;
  selectionText?: string | null;
  selectionOffset?: number | null;
  onReanchorToSelection?: (commentId: string, newAnchor: string, hintOffset?: number) => void;
}

/**
 * The unified comments rail. Owns the density toggle (Anchored, aligned to
 * document anchors via useMarginLayout; List, a pinned CommentListSurface)
 * and hosts whichever rendering the current density calls for. Width and
 * right offset are fixed constants (RAIL, PAD_R from page-geometry); the
 * caller only decides whether the rail can show at all.
 */
export function CommentsRail(props: CommentsRailProps) {
  const { density, scrollRef } = props;

  // When anchored density has no cards to place, the page geometry collapses
  // the gutter so the rail root now overlaps the prose. It is invisible
  // (transparent, no cards), but an in-flow-sized absolute box still eats
  // pointer events, which would block selecting the very text the reader is
  // about to comment on. Drop pointer events in exactly that state; the first
  // comment restores them (there is a card to interact with again).
  const anchoredEmpty = density === 'anchored' && props.anchoredComments.length === 0;

  // List density pins to the viewport: measure the scroll container height.
  const [viewportHeight, setViewportHeight] = useState(0);
  useEffect(() => {
    if (density !== 'list') return;
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => setViewportHeight(el.clientHeight);
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, [density, scrollRef]);

  return (
    <div
      data-comments-rail
      className={`absolute inset-y-0${anchoredEmpty ? ' pointer-events-none' : ''}`}
      style={{ right: PAD_R, width: RAIL }}
    >
      {density === 'list' ? (
        <div
          className="sticky top-0 flex flex-col py-2"
          style={{ height: viewportHeight || undefined }}
        >
          <div className="flex-1 min-h-0 bg-surface-raised border border-border rounded-lg overflow-hidden">
            <CommentListSurface
              comments={props.allComments}
              activeCommentId={props.activeCommentId}
              missingAnchors={props.missingAnchors}
              onActivate={props.onActivate}
              onResolve={props.onResolve}
              onUnresolve={props.onUnresolve}
              onDelete={props.onDelete}
              onEdit={props.onEdit}
              onReply={props.onReply}
              onEditReply={props.onEditReply}
              onDeleteReply={props.onDeleteReply}
              onBulkDelete={props.onBulkDelete}
              onBulkResolve={props.onBulkResolve}
              onBulkDeleteResolved={props.onBulkDeleteResolved}
              onContextMenu={props.onContextMenu}
              requestedEditor={props.requestedEditor}
              requestedFocus={props.requestedFocus}
              onFocusHandled={props.onFocusHandled}
              sentCommentIds={props.sentCommentIds}
              selectionText={props.selectionText}
              selectionOffset={props.selectionOffset}
              onReanchorToSelection={props.onReanchorToSelection}
            />
          </div>
        </div>
      ) : (
        <AnchoredCards {...props} />
      )}
    </div>
  );
}

/**
 * Density toggle + open count for the rail, rendered in the panel toolbar's
 * right group (not inside the rail: a header floating over the anchored
 * cards occluded them).
 */
export function RailDensityControl({
  density,
  onDensityChange,
  openCount,
}: {
  density: RailDensity;
  onDensityChange: (d: RailDensity) => void;
  openCount: number;
}) {
  return (
    <div data-rail-header className="flex items-center gap-2 mr-1">
      <div role="group" aria-label="Comment layout density" className="flex rounded-md border border-border-subtle overflow-hidden">
        {(['anchored', 'list'] as const).map((d) => (
          <button
            key={d}
            onClick={() => onDensityChange(d)}
            aria-pressed={density === d}
            className={`text-[10px] px-2 py-1 font-medium transition-colors cursor-pointer ${
              density === d
                ? 'bg-primary-bg-strong text-primary-text'
                : 'text-content-secondary hover:bg-tint'
            }`}
          >
            {d === 'anchored' ? 'Anchored' : 'List'}
          </button>
        ))}
      </div>
      <span className="text-[10px] text-content-muted tabular-nums whitespace-nowrap">
        {openCount} open
      </span>
    </div>
  );
}

/**
 * Absolute-free layer that renders comment threads aligned to their document
 * anchors. All geometry comes from useMarginLayout; this component only
 * renders. The rail root already owns absolute positioning and width, so
 * this wrapper is a plain flow element sized to the layout's computed height.
 */
function AnchoredCards({
  layout,
  anchoredComments,
  activeCommentId,
  missingAnchors,
  sentCommentIds,
  onActivate,
  onReply,
  onResolve,
  onUnresolve,
  onDelete,
  onEdit,
  onEditReply,
  onDeleteReply,
  onContextMenu,
  requestedEditor,
}: CommentsRailProps) {
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  // Anchored cards share one active editor at a time, mirroring the List
  // surface: this is what lets an externally requested edit (context menu,
  // agent-ask flow) land on the right card, and what keeps opening one
  // card's editor from leaving another card's editor open underneath it.
  const [activeEditor, setActiveEditor] = useState<SidebarCommentEditorState>(null);

  useEffect(() => {
    if (requestedEditor) setActiveEditor(requestedEditor);
  }, [requestedEditor]);

  useEffect(() => {
    if (!activeEditor) return;
    const comment = anchoredComments.find((candidate) => candidate.id === activeEditor.commentId);
    if (!comment) {
      setActiveEditor(null);
      return;
    }
    if (
      activeEditor.mode === 'reply-edit' &&
      !comment.replies?.some((reply) => reply.id === activeEditor.replyId)
    ) {
      setActiveEditor(null);
    }
  }, [anchoredComments, activeEditor]);

  const openCommentEdit = (commentId: string) => {
    setActiveEditor({ mode: 'comment-edit', commentId, token: Date.now() });
  };
  const openReplyCompose = (commentId: string) => {
    setActiveEditor({ mode: 'reply-compose', commentId, token: Date.now() });
  };
  const openReplyEdit = (commentId: string, replyId: string) => {
    setActiveEditor({ mode: 'reply-edit', commentId, replyId, token: Date.now() });
  };
  const closeEditor = () => {
    setActiveEditor(null);
  };

  // Stable per-card ref callbacks. An inline arrow gets a new identity every
  // render, which makes React detach (null) and reattach (node) the ref on
  // every render; registerCardRef updates state on both paths, so that would
  // loop forever. Memoizing one closure per comment id keeps ref identity
  // stable across renders. Safe because layout.registerCardRef is guaranteed
  // stable for the app's lifetime (useCallback with an empty deps array).
  const refCallbacks = useRef(new Map<string, (node: HTMLDivElement | null) => void>());
  const getCardRef = (id: string) => {
    let cb = refCallbacks.current.get(id);
    if (!cb) {
      cb = (node) => layout.registerCardRef(id, node);
      refCallbacks.current.set(id, cb);
    }
    return cb;
  };

  // Evict callbacks for comments no longer on the rail; without this the
  // map grows for the life of the file. Identity for live ids is untouched.
  useEffect(() => {
    const live = new Set(anchoredComments.map((c) => c.id));
    for (const id of refCallbacks.current.keys()) {
      if (!live.has(id)) refCallbacks.current.delete(id);
    }
  }, [anchoredComments]);

  if (!layout.active) return null;

  // One connector at a time: the active card wins over the hovered card.
  const connectorId = activeCommentId ?? hoveredId;
  const connectorAnchorTop =
    connectorId !== null ? layout.anchorTops.get(connectorId) : undefined;
  const connectorCardTop = connectorId !== null ? layout.tops.get(connectorId) : undefined;
  const connectorIsActive = connectorId !== null && connectorId === activeCommentId;

  return (
    // Absolutely positioned (not `relative`, in-flow) so the sticky
    // RailHeader above it doesn't push card tops down: layout.tops is
    // computed from anchor positions measured against the page, with no
    // knowledge of header height, so this layer's top must stay pinned to
    // the rail root's top edge. The header's translucent, blurred
    // background is intentional here — it floats over the card stack
    // rather than reserving flow space above it.
    <div
      data-margin-notes
      className="absolute inset-x-0 top-0"
      style={{ height: layout.layerHeight }}
    >
      {/* Connector: horizontal at the anchor line, vertical along the layer's
          left edge, horizontal into the card. Full opacity when active,
          dimmed when merely hovered. */}
      {connectorAnchorTop !== undefined && connectorCardTop !== undefined && (
        <div style={{ opacity: connectorIsActive ? 1 : 0.5 }}>
          <div
            className="margin-connector absolute"
            style={{ left: -GAP, width: GAP, top: connectorAnchorTop + 10, height: 1 }}
          />
          {Math.abs(connectorCardTop - connectorAnchorTop) > 1 && (
            <div
              className="margin-connector absolute"
              style={{
                left: -GAP,
                width: 1,
                top: Math.min(connectorAnchorTop + 10, connectorCardTop + 10),
                height: Math.abs(connectorCardTop - connectorAnchorTop),
              }}
            />
          )}
          <div
            className="margin-connector absolute"
            style={{ left: -GAP, width: GAP, top: connectorCardTop + 10, height: 1 }}
          />
        </div>
      )}

      {anchoredComments.map((comment) => {
        const top = layout.tops.get(comment.id);
        if (top === undefined) return null;
        const active = comment.id === activeCommentId;
        return (
          <div
            key={comment.id}
            data-margin-card-id={comment.id}
            ref={getCardRef(comment.id)}
            onMouseEnter={() => setHoveredId(comment.id)}
            onMouseLeave={() => setHoveredId((prev) => (prev === comment.id ? null : prev))}
            className={`margin-note-enter margin-note-pos absolute left-0 right-0 bg-surface-raised border rounded-lg shadow-sm ${
              active ? 'border-primary-border shadow-md' : 'border-border'
            }`}
            style={{ top }}
          >
            <ThreadCard
              thread={comment}
              active={active}
              compact={!active}
              anchorMissing={layout.orphanIds.includes(comment.id) || missingAnchors.has(comment.id)}
              sent={sentCommentIds.includes(comment.id)}
              onSelect={onActivate}
              onReply={onReply}
              onResolve={onResolve}
              onUnresolve={onUnresolve}
              onDelete={onDelete}
              onEdit={onEdit}
              onEditReply={onEditReply}
              onDeleteReply={onDeleteReply}
              onContextMenu={
                onContextMenu ? (id, x, y) => onContextMenu({ commentId: id, x, y }) : undefined
              }
              editor={activeEditor}
              onRequestCommentEdit={openCommentEdit}
              onRequestReplyCompose={openReplyCompose}
              onRequestReplyEdit={openReplyEdit}
              onCloseEditor={closeEditor}
            />
          </div>
        );
      })}
    </div>
  );
}
