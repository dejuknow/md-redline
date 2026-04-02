import { useRef, useEffect } from 'react';

interface Props {
  query: string;
  onQueryChange: (query: string) => void;
  matchCount: number;
  activeIndex: number;
  onNext: () => void;
  onPrev: () => void;
  onClose: () => void;
  focusTrigger: number;
}

export function SearchBar({ query, onQueryChange, matchCount, activeIndex, onNext, onPrev, onClose, focusTrigger }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusTrigger]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) onPrev();
      else onNext();
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <div data-testid="search-bar" className="absolute top-2 right-4 z-20 flex items-center gap-1.5 bg-surface-raised border border-border rounded-lg shadow-lg px-3 py-1.5">
      <svg className="w-3.5 h-3.5 text-content-muted shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
        <circle cx="11" cy="11" r="8" />
        <path strokeLinecap="round" d="m21 21-4.35-4.35" />
      </svg>
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Find..."
        className="w-44 text-sm bg-transparent border-none outline-none text-content placeholder:text-content-muted"
      />
      {query && (
        <span data-testid="search-match-count" className="text-xs text-content-muted tabular-nums whitespace-nowrap">
          {matchCount > 0 ? `${activeIndex + 1} of ${matchCount}` : 'No results'}
        </span>
      )}
      <div className="flex items-center gap-0.5 border-l border-border-subtle pl-1.5 ml-0.5">
        <button
          onClick={onPrev}
          disabled={matchCount === 0}
          className="p-1 rounded text-content-muted hover:text-content-secondary hover:bg-tint disabled:opacity-30 transition-colors"
          title="Previous match (Shift+Enter)"
          aria-label="Previous match"
        >
          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 15l7-7 7 7" />
          </svg>
        </button>
        <button
          onClick={onNext}
          disabled={matchCount === 0}
          className="p-1 rounded text-content-muted hover:text-content-secondary hover:bg-tint disabled:opacity-30 transition-colors"
          title="Next match (Enter)"
          aria-label="Next match"
        >
          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
        </button>
        <button
          onClick={onClose}
          className="p-1 rounded text-content-muted hover:text-content-secondary hover:bg-tint transition-colors"
          title="Close (Escape)"
          aria-label="Close search"
        >
          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>
  );
}
