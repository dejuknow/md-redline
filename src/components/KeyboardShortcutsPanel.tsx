import { useEffect } from 'react';
import { isApplePlatform } from '../lib/platform';
import { StyledShortcut } from '../lib/shortcut-label';

interface Props {
  open: boolean;
  onClose: () => void;
  resolveEnabled: boolean;
}

const mod = isApplePlatform() ? '\u2318' : 'Ctrl+';
const shift = isApplePlatform() ? '\u21e7' : 'Shift+';

interface Shortcut {
  keys: string;
  label: string;
  condition?: string;
}

interface Section {
  title: string;
  shortcuts: Shortcut[];
}

const sections: Section[] = [
  {
    title: 'Navigation',
    shortcuts: [
      { keys: 'N / J', label: 'Next comment' },
      { keys: 'P / K', label: 'Previous comment' },
      { keys: `${mod}F`, label: 'Find in document' },
      { keys: `${mod}K`, label: 'Command palette' },
      { keys: `${mod}${shift}[`, label: 'Previous tab' },
      { keys: `${mod}${shift}]`, label: 'Next tab' },
    ],
  },
  {
    title: 'Comments',
    shortcuts: [
      { keys: `${mod}Enter`, label: 'Start commenting on selection' },
      { keys: `${mod}${shift}M`, label: 'Lock selection for commenting' },
      { keys: 'D', label: 'Delete active comment' },
      { keys: 'A / X', label: 'Resolve active comment', condition: 'resolve' },
      { keys: 'U', label: 'Reopen active comment', condition: 'resolve' },
    ],
  },
  {
    title: 'View',
    shortcuts: [
      { keys: `${mod}\\`, label: 'Toggle comment sidebar' },
      { keys: `${mod}B`, label: 'Toggle file explorer' },
      { keys: `${mod}${shift}O`, label: 'Toggle document outline' },
    ],
  },
  {
    title: 'File',
    shortcuts: [
      { keys: `${mod}O`, label: 'Open file' },
      { keys: `${mod},`, label: 'Open settings' },
      { keys: '?', label: 'This help panel' },
    ],
  },
];

export function KeyboardShortcutsPanel({ open, onClose, resolveEnabled }: Props) {
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center" onClick={onClose}>
      <div className="absolute inset-0 bg-black/40" />
      <div
        className="relative w-full max-w-lg bg-surface-raised rounded-xl shadow-2xl border border-border overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-border">
          <h2 className="text-sm font-semibold text-content">Keyboard Shortcuts</h2>
          <button
            onClick={onClose}
            className="text-content-muted hover:text-content transition-colors"
          >
            <svg
              className="w-4 h-4"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-4 max-h-[70vh] overflow-y-auto space-y-5">
          {sections.map((section) => {
            const visibleShortcuts = section.shortcuts.filter(
              (s) => !s.condition || (s.condition === 'resolve' && resolveEnabled),
            );
            if (visibleShortcuts.length === 0) return null;

            return (
              <div key={section.title}>
                <h3 className="text-[10px] font-semibold text-content-muted uppercase tracking-wider mb-2">
                  {section.title}
                </h3>
                <div className="space-y-1">
                  {visibleShortcuts.map((shortcut) => (
                    <div key={shortcut.keys} className="flex items-center justify-between py-1.5">
                      <span className="text-sm text-content">{shortcut.label}</span>
                      <kbd className="text-[11px] px-2 py-0.5 rounded border border-border-subtle text-content-muted bg-surface font-mono min-w-[2rem] text-center">
                        <StyledShortcut text={shortcut.keys} />
                      </kbd>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
