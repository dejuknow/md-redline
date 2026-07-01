import { useRef, useState } from 'react';
import type { MdComment } from '../types';
import type { MarginLayout } from '../hooks/useMarginLayout';
import { ThreadCard } from './ThreadCard';

interface MarginNotesProps {
  layout: MarginLayout;
  comments: MdComment[];
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
}

/**
 * Absolute layer inside the document scroll container that renders comment
 * threads in the right margin, aligned to their anchors. All geometry comes
 * from useMarginLayout; this component only renders.
 */
export function MarginNotes({
  layout,
  comments,
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
}: MarginNotesProps) {
  const [hoveredId, setHoveredId] = useState<string | null>(null);

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

  if (!layout.active) return null;

  // One connector at a time: the active card wins over the hovered card.
  const connectorId = activeCommentId ?? hoveredId;
  const connectorAnchorTop =
    connectorId !== null ? layout.anchorTops.get(connectorId) : undefined;
  const connectorCardTop = connectorId !== null ? layout.tops.get(connectorId) : undefined;
  const connectorIsActive = connectorId !== null && connectorId === activeCommentId;

  return (
    <div
      data-margin-notes
      className="absolute top-0"
      style={{ right: 24, width: layout.marginWidth, height: layout.layerHeight }}
    >
      {/* Connector: horizontal at the anchor line, vertical along the layer's
          left edge, horizontal into the card. Full opacity when active,
          dimmed when merely hovered. */}
      {connectorAnchorTop !== undefined && connectorCardTop !== undefined && (
        <div style={{ opacity: connectorIsActive ? 1 : 0.5 }}>
          <div
            className="margin-connector absolute"
            style={{ left: -24, width: 24, top: connectorAnchorTop + 10, height: 1 }}
          />
          {Math.abs(connectorCardTop - connectorAnchorTop) > 1 && (
            <div
              className="margin-connector absolute"
              style={{
                left: -24,
                width: 1,
                top: Math.min(connectorAnchorTop + 10, connectorCardTop + 10),
                height: Math.abs(connectorCardTop - connectorAnchorTop),
              }}
            />
          )}
          <div
            className="margin-connector absolute"
            style={{ left: -24, width: 24, top: connectorCardTop + 10, height: 1 }}
          />
        </div>
      )}

      {comments.map((comment) => {
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
            className={`margin-note-enter absolute left-0 right-0 bg-surface-raised border rounded-lg shadow-sm transition-shadow ${
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
            />
          </div>
        );
      })}
    </div>
  );
}
