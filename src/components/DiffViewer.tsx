import { useMemo } from 'react';
import { computeDiff } from '../lib/diff';
import { parseComments } from '../lib/comment-parser';

interface Props {
  oldRaw: string;
  newRaw: string;
}

export function DiffViewer({ oldRaw, newRaw }: Props) {
  const diff = useMemo(() => {
    const { cleanMarkdown: oldClean } = parseComments(oldRaw);
    const { cleanMarkdown: newClean } = parseComments(newRaw);
    return computeDiff(oldClean, newClean);
  }, [oldRaw, newRaw]);

  const hasChanges = diff.some((l) => l.type !== 'same');

  if (!hasChanges) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-content-muted px-6">
        <svg
          className="w-12 h-12 mb-3 text-content-faint"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={1.5}
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
          />
        </svg>
        <p className="text-sm font-medium text-content-secondary mb-1">No changes detected</p>
        <p className="text-xs text-center leading-relaxed">
          The file content matches your last snapshot.
        </p>
      </div>
    );
  }

  return (
    <div className="font-mono text-sm leading-relaxed">
      {diff.map((line, i) => {
        const bgClass =
          line.type === 'added'
            ? 'bg-diff-added-bg text-diff-added-text'
            : line.type === 'removed'
              ? 'bg-diff-removed-bg text-diff-removed-text line-through'
              : 'text-content-secondary';
        const prefix = line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' ';
        const lineNo =
          line.type === 'removed'
            ? line.oldLineNo
            : line.type === 'added'
              ? line.newLineNo
              : line.oldLineNo;

        return (
          <div key={i} className={`flex ${bgClass}`}>
            <span className="w-10 text-right pr-2 text-content-muted select-none shrink-0 border-r border-border">
              {lineNo}
            </span>
            <span className="w-6 text-center select-none shrink-0 text-content-muted">{prefix}</span>
            <span className="flex-1 whitespace-pre-wrap break-words px-2">
              {line.text || '\u00A0'}
            </span>
          </div>
        );
      })}
    </div>
  );
}
