import { useState, useEffect, useRef, useCallback } from 'react';
import { StyledShortcut } from '../lib/shortcut-label';

export interface Command {
  id: string;
  label: string;
  shortcut?: string;
  section: string;
  onExecute: () => void;
}

interface Props {
  commands: Command[];
  open: boolean;
  onClose: () => void;
}

export function CommandPalette({ commands, open, onClose }: Props) {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [isKeyboardNav, setIsKeyboardNav] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Filter commands by fuzzy match
  const filtered = query
    ? commands.filter((c) => {
        const q = query.toLowerCase();
        return c.label.toLowerCase().includes(q) || c.section.toLowerCase().includes(q);
      })
    : commands;

  // Group by section
  const sections = new Map<string, Command[]>();
  for (const cmd of filtered) {
    const list = sections.get(cmd.section) || [];
    list.push(cmd);
    sections.set(cmd.section, list);
  }

  // Flat list for keyboard navigation — must match visual (grouped) render order
  const flatList = Array.from(sections.values()).flat();

  // Reset on open
  useEffect(() => {
    if (open) {
      setQuery('');
      setSelectedIndex(0);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  // Clamp selected index
  useEffect(() => {
    if (selectedIndex >= flatList.length) {
      setSelectedIndex(Math.max(0, flatList.length - 1));
    }
  }, [flatList.length, selectedIndex]);

  // Scroll selected item into view
  useEffect(() => {
    if (!listRef.current) return;
    const selected = listRef.current.querySelector('[data-selected="true"]');
    selected?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  const execute = useCallback(
    (cmd: Command) => {
      onClose();
      // Defer execution so the palette closes first
      requestAnimationFrame(() => cmd.onExecute());
    },
    [onClose],
  );

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || (e.key === 'j' && e.ctrlKey)) {
      e.preventDefault();
      setIsKeyboardNav(true);
      setSelectedIndex((i) => (i + 1) % flatList.length);
    } else if (e.key === 'ArrowUp' || (e.key === 'k' && e.ctrlKey)) {
      e.preventDefault();
      setIsKeyboardNav(true);
      setSelectedIndex((i) => (i - 1 + flatList.length) % flatList.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (flatList[selectedIndex]) {
        execute(flatList[selectedIndex]);
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
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/40" />

      {/* Palette */}
      <div
        className="relative w-full max-w-lg bg-surface-raised rounded-xl shadow-2xl border border-border overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Search input */}
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
              d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z"
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
            placeholder="Type a command..."
            className="flex-1 px-3 py-3 text-sm bg-transparent text-content focus:outline-none placeholder:text-content-muted"
          />
          <kbd className="text-[10px] px-1.5 py-0.5 rounded border border-border text-content-muted bg-surface">
            esc
          </kbd>
        </div>

        {/* Command list */}
        <div ref={listRef} className="max-h-72 overflow-y-auto py-1">
          {flatList.length === 0 && (
            <div className="px-4 py-6 text-center text-sm text-content-muted">
              No matching commands
            </div>
          )}
          {Array.from(sections.entries()).map(([section, cmds]) => (
            <div key={section}>
              <div className="px-4 pt-2 pb-1 text-[10px] font-semibold text-content-muted uppercase tracking-wider">
                {section}
              </div>
              {cmds.map((cmd) => {
                const globalIdx = flatList.indexOf(cmd);
                const isSelected = globalIdx === selectedIndex;
                return (
                  <button
                    key={cmd.id}
                    data-selected={isSelected}
                    onClick={() => execute(cmd)}
                    onMouseMove={() => {
                      if (isKeyboardNav) setIsKeyboardNav(false);
                      else setSelectedIndex(globalIdx);
                    }}
                    className={`w-full text-left px-4 py-2 flex items-center justify-between text-sm transition-colors ${
                      isSelected
                        ? 'bg-primary-bg text-primary-text'
                        : 'text-content hover:bg-tint'
                    }`}
                  >
                    <span>{cmd.label}</span>
                    {cmd.shortcut && (
                      <kbd
                        className={`text-[10px] px-1.5 py-0.5 rounded border font-mono ${
                          isSelected
                            ? 'border-primary-border text-primary-text'
                            : 'border-border text-content-muted bg-surface'
                        }`}
                      >
                        <StyledShortcut text={cmd.shortcut} />
                      </kbd>
                    )}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
