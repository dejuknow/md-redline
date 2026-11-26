import type { CardDraftProblem, SetAsideCardDraft } from '../hooks/useCardDrafts';

interface Props {
  /** Drafts kept aside in this file, oldest first. The first one is offered. */
  setAside: readonly SetAsideCardDraft[];
  onCopy: (text: string) => void;
  onDiscard: (key: string) => void;
}

function describe({ draft, problem }: SetAsideCardDraft): string {
  const what =
    draft.target.mode === 'reply-compose'
      ? 'An unsent reply'
      : draft.target.mode === 'comment-edit'
        ? 'An unsent edit to a comment'
        : 'An unsent edit to a reply';
  const why: Record<CardDraftProblem, string> = {
    'comment-gone': 'the comment it belongs to is no longer in this file',
    'reply-gone': 'the reply it edits is no longer in this file',
    resolved: 'its comment was resolved. Reopen the comment to finish it',
    changed: 'the text it edits changed since you started',
  };
  return `${what} was kept aside: ${why[problem]}.`;
}

/**
 * A line at the top of the page for a card draft that cannot go back into its
 * card (#213): its comment or reply is gone, its thread was resolved, or the
 * text it edits changed under it. The draft is never put on another card, so
 * this is where its text stays recoverable, until the reader copies it and
 * lets it go, or its card can take it again.
 */
export function CardDraftNotice({ setAside, onCopy, onDiscard }: Props) {
  const first = setAside[0];
  const more = setAside.length - 1;
  // The live region stays mounted, empty, so a notice appearing in it is
  // announced; one mounted with its text already inside often is not.
  return (
    <div role="status" className="contents">
      {first && (
        <div
          data-card-draft-notice
          className="min-h-8 shrink-0 min-w-0 flex items-center gap-3 px-3 py-1 border-b border-border-subtle bg-surface-secondary text-[12px] text-content-secondary"
        >
          <span className="min-w-0 flex-1">
            {describe(first)}
            {more > 0 && <span className="text-content-muted"> ({more} more kept aside)</span>}
          </span>
          <button
            type="button"
            onClick={() => onCopy(first.draft.text)}
            title={first.draft.text}
            className="h-[22px] shrink-0 px-1.5 rounded-md text-primary-text font-medium hover:bg-tint-primary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          >
            Copy
          </button>
          <button
            type="button"
            onClick={() => onDiscard(first.key)}
            className="h-[22px] shrink-0 px-1.5 rounded-md text-content-muted font-medium hover:bg-tint hover:text-content-secondary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          >
            Discard
          </button>
        </div>
      )}
    </div>
  );
}
