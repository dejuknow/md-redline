import { useLayoutEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { MdComment } from '../types';
import { ThreadCard } from './ThreadCard';

interface Props {
  comment: MdComment;
  pageRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  sent: boolean;
  anchorMissing: boolean;
  onReply: (commentId: string, text: string) => void;
  onResolve?: (id: string) => void;
  onUnresolve?: (id: string) => void;
  onDelete: (id: string) => void;
  onEdit: (id: string, newText: string) => void;
  onEditReply: (commentId: string, replyId: string, newText: string) => void;
  onDeleteReply: (commentId: string, replyId: string) => void;
}

const WIDTH = 320;

/**
 * Single-thread comment surface for contexts where the rail can't show
 * (narrow rendered view). Opened by clicking a highlight or by creating a
 * comment while the rail is hidden; see the popover state and its triggers
 * in App.tsx. Closes on Escape, an outside click, the rail becoming
 * available, or the active file changing.
 */
export function CommentPopover({ comment, pageRef, onClose, sent, anchorMissing, ...cb }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  // Position below the comment's topmost mark, page-relative (the popover is
  // absolutely positioned inside the page, so it scrolls with the text).
  useLayoutEffect(() => {
    const page = pageRef.current;
    if (!page) return;
    const mark = Array.from(page.querySelectorAll<HTMLElement>('[data-comment-ids]')).find((el) =>
      (el.dataset.commentIds ?? '').split(',').includes(comment.id),
    );
    const pageRect = page.getBoundingClientRect();
    if (!mark) {
      setPos({ left: Math.max((pageRect.width - WIDTH) / 2, 12), top: 80 });
      return;
    }
    const markRect = mark.getBoundingClientRect();
    const left = Math.min(
      Math.max(markRect.left - pageRect.left, 12),
      pageRect.width - WIDTH - 12,
    );
    setPos({ left, top: markRect.bottom - pageRect.top + 10 });
  }, [comment.id, pageRef]);

  // Esc + outside click close.
  useLayoutEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [onClose]);

  if (!pos) return null;
  return (
    <div
      ref={ref}
      data-comment-popover
      role="dialog"
      aria-label="Comment"
      className="absolute z-30 bg-surface-raised border border-primary-border rounded-lg shadow-lg overlay-panel-enter"
      style={{ left: pos.left, top: pos.top, width: WIDTH }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <ThreadCard
        thread={comment}
        active
        anchorMissing={anchorMissing}
        sent={sent}
        onSelect={() => {}}
        onReply={cb.onReply}
        onResolve={cb.onResolve}
        onUnresolve={cb.onUnresolve}
        onDelete={cb.onDelete}
        onEdit={cb.onEdit}
        onEditReply={cb.onEditReply}
        onDeleteReply={cb.onDeleteReply}
      />
    </div>
  );
}
