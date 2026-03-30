import { useState, useRef, useEffect } from 'react';
import { useTheme } from 'next-themes';

const THEMES = [
  { key: 'light', label: 'Light', colors: ['#ffffff', '#4f46e5', '#f59e0b'] },
  { key: 'dark', label: 'Dark', colors: ['#0f172a', '#818cf8', '#f59e0b'] },
  { key: 'sepia', label: 'Sepia', colors: ['#faf6f1', '#8b5e3c', '#d4a04a'] },
  { key: 'nord', label: 'Nord', colors: ['#2e3440', '#88c0d0', '#ebcb8b'] },
];

export function ThemeSelector() {
  const { theme, setTheme } = useTheme();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        className="text-content-muted hover:text-content-secondary transition-colors p-1 rounded hover:bg-tint"
        title="Switch theme"
      >
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M4.098 19.902a3.75 3.75 0 005.304 0l6.401-6.402M6.75 21A3.75 3.75 0 013 17.25V4.125C3 3.504 3.504 3 4.125 3h5.25c.621 0 1.125.504 1.125 1.125v4.072M6.75 21a3.75 3.75 0 003.75-3.75V8.197M6.75 21h13.125c.621 0 1.125-.504 1.125-1.125v-5.25c0-.621-.504-1.125-1.125-1.125h-4.072M10.5 8.197l2.88-2.88c.438-.439 1.15-.439 1.59 0l3.712 3.713c.44.44.44 1.152 0 1.59l-2.879 2.88M6.75 17.25h.008v.008H6.75v-.008z"
          />
        </svg>
      </button>
      {open && (
        <div className="absolute right-0 mt-1 w-40 bg-surface-raised rounded-lg shadow-lg border border-border overflow-hidden z-50">
          {THEMES.map((t) => (
            <button
              key={t.key}
              onClick={() => {
                setTheme(t.key);
                setOpen(false);
              }}
              className={`w-full text-left px-3 py-2 text-sm flex items-center gap-2 transition-colors ${
                theme === t.key
                  ? 'bg-primary-bg text-primary-text font-medium'
                  : 'text-content-secondary hover:bg-tint'
              }`}
            >
              <div className="flex gap-0.5">
                {t.colors.map((c, i) => (
                  <div
                    key={i}
                    className="w-3 h-3 rounded-full border border-border"
                    style={{ backgroundColor: c }}
                  />
                ))}
              </div>
              {t.label}
              {theme === t.key && (
                <svg
                  className="w-3.5 h-3.5 ml-auto"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                </svg>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
