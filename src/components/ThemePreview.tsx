import type { ThemeDef } from '../lib/themes';

function isDarkHex(hex: string): boolean {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 128;
}

/**
 * Miniature page preview for a theme: sheet background, fake text lines,
 * a highlighter stroke, and an accent stroke, built from the theme's
 * swatch colors [bg, accent, highlight]. Ink is derived from the sheet's
 * luminance since ThemeDef carries no text color.
 */
export function ThemePreview({ t, compact = false }: { t: ThemeDef; compact?: boolean }) {
  const [bg, accent, highlight] = t.colors;
  const ink = isDarkHex(bg) ? 'rgba(255, 255, 255, 0.65)' : 'rgba(0, 0, 0, 0.6)';
  return (
    <div
      aria-hidden
      className={`shrink-0 rounded border border-border-subtle overflow-hidden ${
        compact ? 'w-9 h-6' : 'w-16 h-10'
      }`}
      style={{ backgroundColor: bg }}
    >
      <div className={compact ? 'px-1 pt-1 space-y-0.5' : 'px-1.5 pt-1.5 space-y-1'}>
        <div className="h-[3px] rounded-full" style={{ backgroundColor: ink, width: '70%' }} />
        <div
          className="h-[3px] rounded-full"
          style={{ backgroundColor: highlight, width: '45%' }}
        />
        <div
          className="h-[3px] rounded-full"
          style={{ backgroundColor: ink, width: '85%', opacity: 0.55 }}
        />
        {!compact && (
          <div className="h-[3px] rounded-full" style={{ backgroundColor: accent, width: '30%' }} />
        )}
      </div>
    </div>
  );
}
