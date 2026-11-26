import { useEffect, useState } from 'react';
import { getPathBasename } from '../lib/path-utils';
import type { ReviewSession } from '../hooks/useReviewSession';
import { MoreReviewActions, type RowAction } from './ReviewHeaderMenus';

const actionBase =
  'h-7 shrink-0 whitespace-nowrap rounded-md text-[13px] font-medium transition-colors disabled:opacity-40';
const QUIET_ACTION = `${actionBase} px-2 text-content-secondary hover:text-content hover:bg-tint`;
const SECONDARY_ACTION = `${actionBase} px-[11px] border border-border bg-surface text-content hover:bg-tint`;
const PRIMARY_ACTION = `${actionBase} px-3 bg-primary text-on-primary hover:bg-primary-hover`;

function ActionButton({
  action,
  className,
  inert,
}: {
  action: RowAction;
  className: string;
  inert: boolean;
}) {
  return (
    <button
      type="button"
      className={className}
      onClick={action.onClick}
      disabled={action.disabled}
      aria-disabled={inert || undefined}
      title={action.title}
      aria-label={action.ariaLabel}
    >
      {action.label}
    </button>
  );
}

interface SessionRowProps {
  indicator: React.ReactNode;
  status: React.ReactNode;
  /** The pending-question jump. Stays out of the More menu when compact. */
  chip?: React.ReactNode;
  quiet?: RowAction;
  secondary?: RowAction;
  primary?: RowAction;
  /** Moves the quiet and secondary actions into a More menu. */
  compact: boolean;
  /** The header's single line: the status truncates instead of wrapping. */
  inline: boolean;
  /**
   * Rendered before the actions (the header's Other reviews button). Not one
   * of this review's actions, so `actionsInert` leaves it working.
   */
  leading?: React.ReactNode;
  /**
   * The actions take no clicks and read as disabled: the header row this
   * review took over while the pointer still rests where the last one was.
   */
  actionsInert?: boolean;
  /** Told when the compact row's More review actions menu opens or closes. */
  onMenuOpenChange?: (open: boolean) => void;
}

// Swallows a click (a press, or Enter or Space on a focused button) before it
// reaches an inert row's actions.
const swallowClick = (e: React.MouseEvent) => {
  e.preventDefault();
  e.stopPropagation();
};
// Keeps a press from focusing an inert action.
const preventFocus = (e: React.MouseEvent) => e.preventDefault();

/**
 * The shared shape of every review row: status on the left, actions on the
 * right in the order chip, quiet, secondary, primary, so the jump to a
 * waiting question comes first and the primary is last.
 */
export function SessionRow({
  indicator,
  status,
  chip,
  quiet,
  secondary,
  primary,
  compact,
  inline,
  leading,
  actionsInert = false,
  onMenuOpenChange,
}: SessionRowProps) {
  const overflow = [quiet, secondary].filter((a): a is RowAction => a !== undefined);
  return (
    <div
      className={
        inline
          ? 'min-w-0 flex-1 flex items-center gap-2'
          : 'flex flex-wrap items-center justify-between gap-2 py-1'
      }
    >
      <div className="min-w-0 flex items-center gap-2 text-[13px]">
        <span className="shrink-0 flex items-center">{indicator}</span>
        <span data-row-status className={inline ? 'min-w-0 truncate' : 'min-w-0'}>
          {status}
        </span>
      </div>
      <div data-row-end className="ml-auto shrink-0 flex items-center gap-2">
        {leading}
        <div
          data-row-actions
          className={`flex items-center gap-2${actionsInert ? ' pointer-events-none' : ''}`}
          aria-disabled={actionsInert || undefined}
          onClickCapture={actionsInert ? swallowClick : undefined}
          onMouseDownCapture={actionsInert ? preventFocus : undefined}
        >
          {chip}
          {compact
            ? overflow.length > 0 && (
                <MoreReviewActions items={overflow} onOpenChange={onMenuOpenChange} />
              )
            : quiet && (
                <ActionButton action={quiet} className={QUIET_ACTION} inert={actionsInert} />
              )}
          {!compact && secondary && (
            <ActionButton action={secondary} className={SECONDARY_ACTION} inert={actionsInert} />
          )}
          {primary && (
            <ActionButton action={primary} className={PRIMARY_ACTION} inert={actionsInert} />
          )}
        </div>
      </div>
    </div>
  );
}

interface AgentSessionRowProps {
  session: ReviewSession;
  agentName: string;
  agentCommentCount: number;
  pendingAskCount: number;
  busy: boolean;
  onDone: (s: ReviewSession) => void;
  onJumpToAsk?: (sessionId: string) => void;
  compact: boolean;
  inline: boolean;
  leading?: React.ReactNode;
  actionsInert?: boolean;
  onMenuOpenChange?: (open: boolean) => void;
}

const AGENT_ACTIVE_WINDOW_MS = 30_000;
const AGENT_TICK_MS = 5_000;

/**
 * Crimson-tinted chip surfacing "the agent is blocked on your answer." It sits
 * with the row's actions in every row variant and never folds into the More
 * menu; this is the persistent cue that outlives the toast.
 */
export function PendingAskChip({ count, onJump }: { count: number; onJump?: () => void }) {
  const label = `${count} question${count === 1 ? '' : 's'} awaiting your reply`;
  const chipClass =
    'h-7 shrink-0 whitespace-nowrap inline-flex items-center rounded-md bg-primary-bg px-2.5 text-[13px] font-medium text-primary-text';
  if (!onJump) {
    return <span className={chipClass}>{label}</span>;
  }
  return (
    <button
      type="button"
      className={`${chipClass} hover:bg-primary-bg-strong transition-colors`}
      onClick={onJump}
      aria-label={`${label}. Jump to the first question.`}
    >
      {label} &rarr;
    </button>
  );
}

/**
 * Agent-origin row. Owns its own 5s ticking timer so the spinner-vs-dot
 * transition stays correct without forcing a re-render of every other row.
 * Mounting this component is the gate that creates the timer: when no
 * agent-origin sessions are open, no timer runs.
 */
export function AgentSessionRow({
  session,
  agentName,
  agentCommentCount,
  pendingAskCount,
  busy,
  onDone,
  onJumpToAsk,
  compact,
  inline,
  leading,
  actionsInert,
  onMenuOpenChange,
}: AgentSessionRowProps) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), AGENT_TICK_MS);
    return () => clearInterval(id);
  }, []);

  // A session with no agent activity yet is one the agent just opened and is
  // about to post into: show the spinner, not the idle dot. The idle dot
  // means "the agent posted a while ago and has gone quiet."
  const isAgentActive = session.lastAgentActivityAt
    ? now - new Date(session.lastAgentActivityAt).getTime() < AGENT_ACTIVE_WINDOW_MS
    : true;
  const awaitingReply = pendingAskCount > 0;

  const handleEndReview = () => {
    if (awaitingReply) {
      const confirmed = window.confirm(
        `${agentName} has ${pendingAskCount} unanswered question${pendingAskCount === 1 ? '' : 's'}. ` +
          'End the review anyway? Unanswered questions will be reported back as unanswered.',
      );
      if (!confirmed) return;
    }
    onDone(session);
  };

  const fileList = (
    <>
      {session.filePaths.map((p, i) => (
        <span key={p}>
          {i > 0 && ', '}
          <code className="rounded bg-current/10 px-1">{getPathBasename(p)}</code>
        </span>
      ))}
    </>
  );

  return (
    <SessionRow
      compact={compact}
      inline={inline}
      leading={leading}
      actionsInert={actionsInert}
      onMenuOpenChange={onMenuOpenChange}
      indicator={
        awaitingReply ? (
          <span
            className="inline-block h-2 w-2 animate-pulse rounded-full bg-warning"
            aria-hidden
          />
        ) : isAgentActive ? (
          <span
            role="status"
            className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-primary border-t-transparent"
            aria-label="Agent is active"
          />
        ) : (
          <span className="inline-block h-2 w-2 rounded-full bg-content-muted" aria-hidden />
        )
      }
      status={
        <>
          {awaitingReply ? (
            <strong>{agentName} is waiting on your reply.</strong>
          ) : (
            <strong>
              {agentName} is reviewing {fileList}.
            </strong>
          )}
          {!awaitingReply && agentCommentCount > 0 && (
            <span className="ml-2 text-content-secondary">
              ({agentCommentCount} comment{agentCommentCount === 1 ? '' : 's'})
            </span>
          )}
        </>
      }
      chip={
        awaitingReply && (
          <PendingAskChip
            count={pendingAskCount}
            onJump={onJumpToAsk ? () => onJumpToAsk(session.id) : undefined}
          />
        )
      }
      quiet={{
        label: 'End review',
        onClick: handleEndReview,
        disabled: busy,
        ariaLabel: `End review with ${agentName}`,
      }}
    />
  );
}
