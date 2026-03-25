import { useRef, useEffect } from 'react';
import type { TocHeading } from './MarkdownViewer';

interface Props {
  headings: TocHeading[];
  activeHeadingId: string | null;
  onHeadingClick: (id: string) => void;
}

const INDENT: Record<number, string> = {
  1: 'pl-3',
  2: 'pl-6',
  3: 'pl-9',
  4: 'pl-12',
  5: 'pl-12',
  6: 'pl-12',
};

export function TableOfContents({ headings, activeHeadingId, onHeadingClick }: Props) {
  const activeRef = useRef<HTMLButtonElement>(null);

  // Auto-scroll the active heading into view within the TOC panel
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest' });
  }, [activeHeadingId]);

  if (headings.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-content-muted px-4">
        <svg className="w-8 h-8 mb-2 opacity-40" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 6.75h12M8.25 12h12m-12 5.25h12M3.75 6.75h.007v.008H3.75V6.75zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zM3.75 12h.007v.008H3.75V12zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm-.375 5.25h.007v.008H3.75v-.008zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z" />
        </svg>
        <span className="text-[10px]">No headings</span>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto py-1">
      {headings.map((h) => {
        const isActive = h.id === activeHeadingId;
        return (
          <button
            key={h.id}
            ref={isActive ? activeRef : undefined}
            onClick={() => onHeadingClick(h.id)}
            className={`w-full text-left py-1.5 pr-3 text-xs transition-colors ${INDENT[h.level] || 'pl-3'} ${
              isActive
                ? 'bg-primary-bg text-primary-text font-medium'
                : 'text-content hover:bg-surface-inset'
            }`}
            title={h.text}
          >
            <span className="block truncate">{h.text}</span>
          </button>
        );
      })}
    </div>
  );
}
