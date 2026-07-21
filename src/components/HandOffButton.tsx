import { useEffect, useRef, useState } from 'react';
import { IconButton } from './IconButton';
import { Tooltip } from './Tooltip';
import { getPathBasename } from '../lib/path-utils';

const handOffIcon = (
  <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    {/* antenna */}
    <line x1="12" y1="1.5" x2="12" y2="4.5" strokeLinecap="round" />
    <circle cx="12" cy="1.5" r="1" fill="currentColor" stroke="none" />
    {/* head */}
    <rect x="3" y="4.5" width="18" height="17" rx="3" strokeLinejoin="round" />
    {/* eyes */}
    <circle cx="8" cy="11.5" r="2" fill="currentColor" stroke="none" />
    <circle cx="16" cy="11.5" r="2" fill="currentColor" stroke="none" />
    {/* mouth */}
    <line x1="8.5" y1="17.5" x2="15.5" y2="17.5" strokeLinecap="round" />
    {/* ears */}
    <line x1="0.5" y1="13" x2="3" y2="13" strokeLinecap="round" />
    <line x1="21" y1="13" x2="23.5" y2="13" strokeLinecap="round" />
  </svg>
);

const chevronIcon = (
  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
  </svg>
);

interface Props {
  activeFilePath: string;
  commentCounts: Map<string, number>;
  onCopyAgentPrompt: (filePaths: string[]) => void;
}

/**
 * Handoff scope follows the ACTIVE tab, not the whole set of open tabs.
 * Reviewers keep unrelated docs from different projects open at once, so a
 * comment in a background tab must never light up or rename the button while
 * you're reading something else. Nothing is stranded by this: comments live
 * in the file markers and every tab carries its own count badge, so pending
 * work is surfaced by the tab, not the handoff button.
 *
 * States:
 * - Active tab has no sendable comments: quiet disabled icon (even if other
 *   tabs have comments), with a tooltip explaining how to enable.
 * - Active tab has comments, no other tab does: labeled CTA; click hands off
 *   the active file immediately.
 * - Active tab has comments AND other tabs do: same CTA (count is always the
 *   active file), plus a chevron that opens a picker. The picker pre-selects
 *   the active file only; other commented tabs are listed unchecked so you
 *   opt each one in — cross-project tabs are never assumed to belong to this
 *   review.
 */
export function HandOffButton({ activeFilePath, commentCounts, onCopyAgentPrompt }: Props) {
  const [open, setOpen] = useState(false);
  const [chevronHover, setChevronHover] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const ref = useRef<HTMLDivElement>(null);

  const filesWithComments = Array.from(commentCounts.entries())
    .filter(([, count]) => count > 0)
    .map(([path, count]) => ({ path, count }));

  const activeCount = commentCounts.get(activeFilePath) ?? 0;
  const disabled = activeCount === 0;
  const hasOtherFiles = filesWithComments.some((f) => f.path !== activeFilePath);

  // Close on click outside
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const toggle = (path: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  // Disabled rendering: quiet icon-only variant, no dropdown, no click.
  // Tooltip explains how to enable.
  if (disabled) {
    return (
      <div className="relative flex items-center" data-testid="handoff-group">
        <Tooltip text="Add comments first to hand off to an agent">
          <IconButton
            variant="neutral"
            disabled
            title="Add comments first to hand off to an agent"
            data-testid="handoff-button"
          >
            {handOffIcon}
          </IconButton>
        </Tooltip>
      </div>
    );
  }

  // Enabled rendering: labeled accent-tinted CTA. When other tabs also have
  // comments, a chevron segment opens the multi-file picker. Both segments
  // go strong together while the picker is open or the chevron is hovered,
  // so the split still reads as one control.
  const pressed = open || chevronHover;
  const segmentClass = `text-primary-text transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
    pressed ? 'bg-primary-bg-strong' : 'bg-primary-bg hover:bg-primary-bg-strong'
  }`;

  return (
    <div className="relative flex items-center" data-testid="handoff-group" ref={ref}>
      <Tooltip text="Hand off to agent. Copies instructions for this file.">
        <button
          type="button"
          onClick={() => onCopyAgentPrompt([activeFilePath])}
          title="Hand off to agent. Copies instructions for this file."
          data-testid="handoff-button"
          className={`flex items-center gap-1.5 pl-1.5 pr-2 py-1 text-xs font-medium whitespace-nowrap ${
            hasOtherFiles ? 'rounded-l' : 'rounded'
          } ${segmentClass}`}
        >
          <span className="block w-3.5 h-3.5 shrink-0">{handOffIcon}</span>
          <span>Hand off</span>
          <span className="tabular-nums opacity-70">{activeCount}</span>
        </button>
      </Tooltip>

      {hasOtherFiles && (
        <button
          type="button"
          onClick={() => {
            setOpen((p) => {
              // Pre-select the active file only; other commented tabs start
              // unchecked so the reviewer opts each one in.
              if (!p) setSelected(new Set([activeFilePath]));
              return !p;
            });
          }}
          onMouseEnter={() => setChevronHover(true)}
          onMouseLeave={() => setChevronHover(false)}
          title="Hand off other open files too"
          aria-haspopup="true"
          aria-expanded={open}
          data-testid="handoff-chevron"
          className={`ml-px px-1 self-stretch flex items-center rounded-r ${segmentClass}`}
        >
          {chevronIcon}
        </button>
      )}

      {open && (
        <div className="absolute right-0 top-full mt-1 z-50 bg-surface border border-border rounded-lg shadow-lg py-1.5 min-w-[240px]">
          {filesWithComments.map(({ path, count }) => {
            const isSelected = selected.has(path);
            const isActive = path === activeFilePath;
            return (
              <button
                key={path}
                onClick={() => toggle(path)}
                className="w-full px-3 py-1.5 flex items-center gap-2 hover:bg-tint transition-colors"
                title={path}
              >
                <span className="w-3 h-3 shrink-0 flex items-center justify-center">
                  {isSelected && (
                    <svg
                      className="w-3 h-3 text-primary-text"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={2.5}
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M4.5 12.75l6 6 9-13.5"
                      />
                    </svg>
                  )}
                </span>
                <span
                  className={`text-xs truncate flex-1 text-left ${isActive ? 'text-content font-medium' : 'text-content'}`}
                >
                  {getPathBasename(path)}
                  {isActive && <span className="text-content-muted font-normal"> · this file</span>}
                </span>
                <span className="text-[10px] text-content-muted">{count}</span>
              </button>
            );
          })}

          {/* Action button */}
          <div className="border-t border-border-subtle mt-1.5 pt-1.5 px-3 pb-1">
            <button
              onClick={() => {
                const paths = Array.from(selected);
                if (paths.length === 0) return;
                onCopyAgentPrompt(paths);
                setOpen(false);
              }}
              disabled={selected.size === 0}
              className={`w-full text-xs px-2 py-1.5 rounded-md font-medium transition-opacity ${
                selected.size > 0
                  ? 'bg-primary-bg-strong text-primary-text hover:opacity-90'
                  : 'bg-surface-inset text-content-muted cursor-not-allowed'
              }`}
            >
              {selected.size === 0
                ? 'Select files to hand off'
                : `Copy handoff for ${selected.size} file${selected.size !== 1 ? 's' : ''}`}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
