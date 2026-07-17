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

interface Props {
  activeFilePath: string;
  commentCounts: Map<string, number>;
  onCopyAgentPrompt: (filePaths: string[]) => void;
}

/**
 * Handoff is md-redline's "submit review": the unit it sends is the review
 * session, not the active document. The button's scope always matches its
 * label:
 *
 * - No sendable comments anywhere: quiet disabled icon with an explanatory
 *   tooltip, so the feature stays discoverable.
 * - Exactly one file with comments: labeled CTA, click copies immediately.
 *   If that file is a background tab, the label names it so switching tabs
 *   never makes a pending review look lost.
 * - Multiple files with comments: the label announces the plural scope
 *   ("Hand off 2 files…") and the click opens a picker with every file
 *   pre-selected. Confirm-and-prune, not build-up-from-zero: the picker's
 *   CTA reads the final scope back before anything is copied, so partial
 *   handoff is always deliberate.
 */
export function HandOffButton({ activeFilePath, commentCounts, onCopyAgentPrompt }: Props) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const ref = useRef<HTMLDivElement>(null);

  const filesWithComments = Array.from(commentCounts.entries())
    .filter(([, count]) => count > 0)
    .map(([path, count]) => ({ path, count }));

  const disabled = filesWithComments.length === 0;
  const hasMultipleFiles = filesWithComments.length > 1;

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

  // Enabled rendering: labeled accent-tinted CTA whose label always tells
  // the truth about scope.
  const single = filesWithComments[0];
  const singleIsBackground = !hasMultipleFiles && single.path !== activeFilePath;
  const title = hasMultipleFiles
    ? 'Hand off to agent. Choose files to include.'
    : `Hand off to agent. Copies instructions for ${
        singleIsBackground ? getPathBasename(single.path) : 'this file'
      }.`;

  return (
    <div className="relative flex items-center" data-testid="handoff-group" ref={ref}>
      {/* Suppress the tooltip while the picker is open — it would overlap
          the first file row, and the open picker already says everything. */}
      <Tooltip text={open ? null : title}>
        <button
          type="button"
          onClick={() => {
            if (hasMultipleFiles) {
              setOpen((p) => {
                if (!p) setSelected(new Set(filesWithComments.map((f) => f.path)));
                return !p;
              });
            } else {
              onCopyAgentPrompt([single.path]);
            }
          }}
          title={title}
          aria-haspopup={hasMultipleFiles || undefined}
          aria-expanded={hasMultipleFiles ? open : undefined}
          data-testid="handoff-button"
          className={`flex items-center gap-1.5 pl-1.5 pr-2 py-1 rounded text-xs font-medium whitespace-nowrap text-primary-text transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
            open ? 'bg-primary-bg-strong' : 'bg-primary-bg hover:bg-primary-bg-strong'
          }`}
        >
          <span className="block w-3.5 h-3.5 shrink-0">{handOffIcon}</span>
          {hasMultipleFiles ? (
            <span>Hand off {filesWithComments.length} files…</span>
          ) : (
            <>
              <span>Hand off</span>
              {singleIsBackground && (
                <span className="max-w-[10rem] truncate">{getPathBasename(single.path)}</span>
              )}
              <span className="tabular-nums opacity-70">{single.count}</span>
            </>
          )}
        </button>
      </Tooltip>

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
