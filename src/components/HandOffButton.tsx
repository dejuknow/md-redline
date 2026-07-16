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
  <svg className="w-2 h-2" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
  </svg>
);

interface Props {
  activeFilePath: string;
  commentCounts: Map<string, number>;
  onCopyAgentPrompt: (filePaths: string[]) => void;
  /**
   * When true, the button renders in a disabled state with an explanatory
   * tooltip rather than being hidden. Used when no comments exist yet. The
   * primary CTA stays visible so users discover the feature, and the tooltip
   * tells them what to do to enable it.
   */
  disabled?: boolean;
}

/**
 * Handoff is md-redline's "submit review", so its prominence is
 * state-reactive: a quiet muted icon while there is nothing to send (the
 * resting toolbar stays calm), blooming into a labeled, count-bearing,
 * accent-tinted CTA the moment comments exist and handoff becomes the
 * user's next step. With comments in multiple files the CTA grows a
 * chevron segment that opens the multi-file picker.
 */
export function HandOffButton({
  activeFilePath,
  commentCounts,
  onCopyAgentPrompt,
  disabled,
}: Props) {
  const [open, setOpen] = useState(false);
  const [chevronHover, setChevronHover] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const ref = useRef<HTMLDivElement>(null);

  const filesWithComments = Array.from(commentCounts.entries())
    .filter(([, count]) => count > 0)
    .map(([path, count]) => ({ path, count }));

  const hasMultipleFiles = filesWithComments.length > 1;
  const activeCount = commentCounts.get(activeFilePath) ?? 0;

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
        <button
          type="button"
          title="Hand off multiple files"
          data-testid="handoff-chevron"
          aria-hidden="true"
          tabIndex={-1}
          className="pl-0 pr-0.5 self-stretch flex items-center rounded-r opacity-0 pointer-events-none text-content-muted"
        >
          {chevronIcon}
        </button>
      </div>
    );
  }

  // Enabled rendering: labeled accent-tinted CTA. Both segments go strong
  // together while the dropdown is open or the chevron is hovered, so the
  // split still reads as one control.
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
            hasMultipleFiles ? 'rounded-l' : 'rounded'
          } ${segmentClass}`}
        >
          <span className="block w-3.5 h-3.5 shrink-0">{handOffIcon}</span>
          <span>Hand off</span>
          {activeCount > 0 && <span className="tabular-nums opacity-70">{activeCount}</span>}
        </button>
      </Tooltip>

      {hasMultipleFiles ? (
        <button
          type="button"
          onClick={() => {
            setOpen((p) => {
              if (!p) setSelected(new Set(filesWithComments.map((f) => f.path)));
              return !p;
            });
          }}
          onMouseEnter={() => setChevronHover(true)}
          onMouseLeave={() => setChevronHover(false)}
          title="Hand off multiple files"
          data-testid="handoff-chevron"
          className={`ml-px px-1 self-stretch flex items-center rounded-r ${segmentClass}`}
        >
          {chevronIcon}
        </button>
      ) : (
        <button
          type="button"
          title="Hand off multiple files"
          data-testid="handoff-chevron"
          aria-hidden="true"
          tabIndex={-1}
          className="pl-0 pr-0.5 self-stretch flex items-center rounded-r opacity-0 pointer-events-none text-content-muted"
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
