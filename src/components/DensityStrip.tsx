import type { CommentTick, TickKind } from '../hooks/useCommentTicks';

const KIND_COLOR: Record<TickKind, string> = {
  ask: 'var(--theme-accent)',
  resolved: 'var(--theme-success)',
  open: 'var(--theme-comment-underline)',
};

interface Props {
  ticks: CommentTick[];
  onJump: (id: string) => void;
}

/**
 * Overview ruler pinned to the document panel's right edge: one tick per
 * anchored comment at its proportional position. Purely presentational;
 * geometry comes from useCommentTicks.
 */
export function DensityStrip({ ticks, onJump }: Props) {
  if (ticks.length === 0) return null;
  return (
    <div data-density-strip className="absolute inset-y-0 right-0 w-2 z-10 pointer-events-none">
      {ticks.map((t) => {
        const topPct = (t.y01 * 100).toFixed(3);
        return (
          <button
            key={t.id}
            type="button"
            data-tick-id={t.id}
            // jsdom's CSSOM has no grammar for the CSS min() function and
            // silently drops the whole `top` declaration rather than
            // normalizing it, so tests can't read the position back off
            // style.top. Mirror the computed percentage here as a plain data
            // attribute purely for test observability; rendering still uses
            // the CSS-only pixel-accurate clamp below.
            data-tick-top-pct={topPct}
            title={t.label}
            onClick={() => onJump(t.id)}
            className="absolute left-[2px] right-[2px] h-[3px] rounded-[1px] pointer-events-auto cursor-pointer hover:scale-y-[1.8] transition-transform"
            style={{
              top: `min(${topPct}%, calc(100% - 4px))`,
              backgroundColor: KIND_COLOR[t.kind],
            }}
          />
        );
      })}
    </div>
  );
}
