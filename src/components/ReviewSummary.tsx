import { useMemo } from 'react';
import type { TabState } from '../hooks/useTabs';
import { parseComments } from '../lib/comment-parser';
import { getEffectiveStatus } from '../types';

interface Props {
  tabs: TabState[];
  activeFilePath: string | null;
  onSwitchToFile: (path: string) => void;
  onClose: () => void;
}

interface FileSummary {
  filePath: string;
  fileName: string;
  open: number;
  resolved: number;
  total: number;
}

export function ReviewSummary({ tabs, activeFilePath, onSwitchToFile, onClose }: Props) {
  const summaries = useMemo(() => {
    const result: FileSummary[] = [];
    for (const tab of tabs) {
      try {
        const { comments } = parseComments(tab.rawMarkdown);
        const counts = { open: 0, resolved: 0 };
        for (const c of comments) {
          const s = getEffectiveStatus(c);
          if (s === 'open') counts.open++;
          else if (s === 'resolved') counts.resolved++;
        }
        result.push({
          filePath: tab.filePath,
          fileName: tab.filePath.split('/').pop() || tab.filePath,
          ...counts,
          total: comments.length,
        });
      } catch {
        result.push({
          filePath: tab.filePath,
          fileName: tab.filePath.split('/').pop() || tab.filePath,
          open: 0,
          resolved: 0,
          total: 0,
        });
      }
    }
    return result;
  }, [tabs]);

  const totalOpen = summaries.reduce((sum, s) => sum + s.open, 0);
  const totalResolved = summaries.reduce((sum, s) => sum + s.resolved, 0);
  const totalComments = summaries.reduce((sum, s) => sum + s.total, 0);

  return (
    <div className="absolute top-12 right-4 z-40 w-80 bg-surface-raised rounded-xl shadow-xl border border-border overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border-subtle bg-surface-secondary">
        <div>
          <h3 className="text-sm font-semibold text-content">Review Summary</h3>
          <p className="text-xs text-content-secondary mt-0.5">
            {totalComments} comment{totalComments !== 1 ? 's' : ''} across {tabs.length} file
            {tabs.length !== 1 ? 's' : ''}
            {totalOpen > 0 && <span className="text-primary-text font-medium"> &middot; {totalOpen} open</span>}
            {totalResolved > 0 && (
              <span className="text-success-text font-medium"> &middot; {totalResolved} resolved</span>
            )}
          </p>
        </div>
        <button
          onClick={onClose}
          className="text-content-muted hover:text-content-secondary transition-colors p-1 rounded hover:bg-surface-inset"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* File list */}
      <div className="max-h-64 overflow-y-auto">
        {summaries.map((s) => (
          <button
            key={s.filePath}
            onClick={() => onSwitchToFile(s.filePath)}
            className={`w-full text-left px-4 py-2.5 flex items-center gap-3 hover:bg-primary-bg transition-colors border-b border-border-subtle last:border-b-0 ${
              s.filePath === activeFilePath ? 'bg-primary-bg' : ''
            }`}
          >
            <div className="flex-1 min-w-0">
              <p
                className={`text-sm truncate ${
                  s.filePath === activeFilePath ? 'font-semibold text-primary-text' : 'font-medium text-content'
                }`}
              >
                {s.fileName}
              </p>
              {s.total === 0 && <p className="text-xs text-content-muted">No comments</p>}
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              {s.open > 0 && (
                <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-status-open-bg text-status-open-text font-medium">
                  {s.open} open
                </span>
              )}
              {s.resolved > 0 && (
                <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-status-resolved-bg text-status-resolved-text font-medium">
                  {s.resolved}
                </span>
              )}
            </div>
          </button>
        ))}
      </div>

      {summaries.length === 0 && (
        <div className="px-4 py-6 text-center">
          <p className="text-sm text-content-muted">No files open</p>
        </div>
      )}
    </div>
  );
}
