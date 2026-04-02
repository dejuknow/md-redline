import { useState, useEffect, useRef, useCallback } from 'react';
import type { RecentFile } from '../hooks/useRecentFiles';
import { getApiErrorMessage, readJsonResponse, type ApiErrorPayload } from '../lib/http';

interface Props {
  open: boolean;
  onClose: () => void;
  onOpenFile: (path: string) => void;
  recentFiles: RecentFile[];
  activeFilePath: string | null;
  onClearRecent: () => void;
}

type PickFileResponse = {
  path?: string;
} & ApiErrorPayload;

function looksLikeDirectPath(value: string): boolean {
  return (
    value.startsWith('/') ||
    value.startsWith('~/') ||
    value.startsWith('~\\') ||
    value.startsWith('./') ||
    value.startsWith('.\\') ||
    value.startsWith('../') ||
    value.startsWith('..\\') ||
    /^[a-zA-Z]:[\\/]/.test(value) ||
    value.startsWith('\\\\')
  );
}

export function FileOpener({
  open,
  onClose,
  onOpenFile,
  recentFiles,
  activeFilePath,
  onClearRecent,
}: Props) {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [isKeyboardNav, setIsKeyboardNav] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const filtered = query
    ? recentFiles.filter(
        (f) =>
          f.name.toLowerCase().includes(query.toLowerCase()) ||
          f.path.toLowerCase().includes(query.toLowerCase()),
      )
    : recentFiles;

  // Items: "System file picker..." + recent files
  const SYSTEM_INDEX = 0;
  const itemCount = filtered.length + 1;

  useEffect(() => {
    if (open) {
      setQuery('');
      setSelectedIndex(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  useEffect(() => {
    if (selectedIndex >= itemCount) {
      setSelectedIndex(Math.max(0, itemCount - 1));
    }
  }, [itemCount, selectedIndex]);

  useEffect(() => {
    if (!listRef.current) return;
    const selected = listRef.current.querySelector('[data-selected="true"]');
    selected?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  const handleOpen = useCallback(
    (path: string) => {
      onOpenFile(path);
      onClose();
    },
    [onOpenFile, onClose],
  );

  const handleSystemPicker = useCallback(async () => {
    try {
      const res = await fetch('/api/pick-file');
      const data = await readJsonResponse<PickFileResponse>(res);
      if (!res.ok || !data) {
        throw new Error(getApiErrorMessage(res, data, 'Failed to open system file picker'));
      }
      if (data.path) {
        handleOpen(data.path);
      }
    } catch {
      // Cancelled or failed
    }
  }, [handleOpen]);

  const handleSelect = useCallback(
    (index: number) => {
      if (index === SYSTEM_INDEX) {
        handleSystemPicker();
      } else if (index > SYSTEM_INDEX && index <= filtered.length) {
        handleOpen(filtered[index - 1].path);
      }
    },
    [filtered, SYSTEM_INDEX, handleOpen, handleSystemPicker],
  );

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || (e.key === 'j' && e.ctrlKey)) {
      e.preventDefault();
      setIsKeyboardNav(true);
      setSelectedIndex((i) => (i + 1) % itemCount);
    } else if (e.key === 'ArrowUp' || (e.key === 'k' && e.ctrlKey)) {
      e.preventDefault();
      setIsKeyboardNav(true);
      setSelectedIndex((i) => (i - 1 + itemCount) % itemCount);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (query.trim() && looksLikeDirectPath(query.trim())) {
        // Looks like a path — open it directly
        handleOpen(query.trim());
      } else {
        handleSelect(selectedIndex);
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center pt-[15vh]"
      onClick={onClose}
    >
      <div className="absolute inset-0 bg-black/40" />

      <div
        className="relative w-full max-w-lg bg-surface-raised rounded-xl shadow-2xl border border-border overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Input */}
        <div className="flex items-center px-4 border-b border-border">
          <svg
            className="w-4 h-4 text-content-muted shrink-0"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z"
            />
          </svg>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelectedIndex(0);
            }}
            onKeyDown={handleKeyDown}
            placeholder="File path or name..."
            className="flex-1 px-3 py-3 text-sm bg-transparent text-content focus:outline-none placeholder:text-content-muted"
          />
          <kbd className="text-[10px] px-1.5 py-0.5 rounded border border-border-subtle text-content-muted bg-surface">
            esc
          </kbd>
        </div>

        {/* List */}
        <div ref={listRef} className="max-h-80 overflow-y-auto py-1">
          {/* Actions */}
          <div className={filtered.length > 0 ? 'border-b border-border-subtle mb-1' : ''}>
            <button
              data-selected={selectedIndex === SYSTEM_INDEX}
              onClick={handleSystemPicker}
              onMouseMove={() => {
                if (isKeyboardNav) setIsKeyboardNav(false);
                else setSelectedIndex(SYSTEM_INDEX);
              }}
              className={`w-full text-left px-4 py-2.5 flex items-center gap-3 text-sm transition-colors ${
                selectedIndex === SYSTEM_INDEX
                  ? 'bg-primary-bg text-primary-text'
                  : 'text-content hover:bg-tint'
              }`}
            >
              <svg
                className={`w-4 h-4 shrink-0 ${selectedIndex === SYSTEM_INDEX ? 'text-primary-text' : 'text-content-muted'}`}
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M3.75 9.776c.112-.017.227-.026.344-.026h15.812c.117 0 .232.009.344.026m-16.5 0a2.25 2.25 0 00-1.883 2.542l.857 6a2.25 2.25 0 002.227 1.932H19.05a2.25 2.25 0 002.227-1.932l.857-6a2.25 2.25 0 00-1.883-2.542m-16.5 0V6A2.25 2.25 0 016 3.75h3.879a1.5 1.5 0 011.06.44l2.122 2.12a1.5 1.5 0 001.06.44H18A2.25 2.25 0 0120.25 9v.776"
                />
              </svg>
              System file picker...
            </button>
          </div>

          {/* Recent files */}
          {filtered.length > 0 && (
            <>
              <div className="px-4 pt-2 pb-1 flex items-center justify-between">
                <span className="text-[10px] font-semibold text-content-muted uppercase tracking-wider">
                  Recent
                </span>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onClearRecent();
                  }}
                  className="text-[10px] text-content-muted hover:text-danger transition-colors"
                >
                  Clear
                </button>
              </div>
              {filtered.map((file, i) => {
                const itemIndex = i + 1;
                const isSelected = itemIndex === selectedIndex;
                const isActive = file.path === activeFilePath;
                return (
                  <button
                    key={file.path}
                    data-selected={isSelected}
                    onClick={() => handleOpen(file.path)}
                    onMouseMove={() => {
                      if (isKeyboardNav) setIsKeyboardNav(false);
                      else setSelectedIndex(itemIndex);
                    }}
                    className={`w-full text-left px-4 py-2 flex items-center gap-3 transition-colors ${
                      isSelected
                        ? 'bg-primary-bg text-primary-text'
                        : 'text-content hover:bg-tint'
                    }`}
                  >
                    <svg
                      className={`w-4 h-4 shrink-0 ${isSelected ? 'text-primary-text' : 'text-content-muted'}`}
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={2}
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z"
                      />
                    </svg>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium truncate">
                        {file.name}
                        {isActive && (
                          <span className={`ml-2 text-[10px] font-normal ${isSelected ? 'text-primary-text/70' : 'text-content-muted'}`}>
                            active
                          </span>
                        )}
                      </div>
                      <div className={`text-xs truncate ${isSelected ? 'text-primary-text/60' : 'text-content-muted'}`}>
                        {file.path}
                      </div>
                    </div>
                  </button>
                );
              })}
            </>
          )}

          {/* Empty state when filtering yields no results */}
          {filtered.length === 0 && query && !looksLikeDirectPath(query) && (
            <div className="px-4 py-6 text-center text-sm text-content-muted">
              No matching files
            </div>
          )}

          {/* Path hint when typing a path */}
          {query && looksLikeDirectPath(query) && (
            <div className="px-4 py-3 text-xs text-content-muted border-b border-border-subtle">
              Press <kbd className="px-1 py-0.5 rounded border border-border-subtle bg-surface text-[10px]">Enter</kbd> to open <span className="text-content font-medium">{query}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
