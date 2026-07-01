import { useEffect, useRef, useState } from 'react';
import type { MdComment } from '../types';
import { getEffectiveStatus } from '../types';
import { measureAnchorTops } from '../lib/anchor-measure';

export type TickKind = 'ask' | 'resolved' | 'open';

export interface CommentTick {
  id: string;
  y01: number;
  kind: TickKind;
  label: string;
}

/**
 * Geometry for the density strip: proportional positions of anchored comments
 * within the scroll content. Re-measures on highlight repaint and when the
 * rendered document's height changes (images, mermaid stabilization).
 */
export function useCommentTicks(
  containerRef: React.RefObject<HTMLElement | null>,
  comments: MdComment[],
  enabled: boolean,
  paintTick: number,
): CommentTick[] {
  const [ticks, setTicks] = useState<CommentTick[]>([]);
  const lastHeightRef = useRef<number | null>(null);
  const [remeasureTick, setRemeasureTick] = useState(0);

  useEffect(() => {
    if (!enabled) {
      setTicks((prev) => (prev.length === 0 ? prev : []));
      return;
    }
    const container = containerRef.current;
    if (!container) return;
    const anchorTops = measureAnchorTops(container);
    const scrollHeight = container.scrollHeight || 1;
    const next: CommentTick[] = [];
    for (const c of comments) {
      const top = anchorTops.get(c.id);
      if (top === undefined) continue;
      const kind: TickKind = c.expectsReply
        ? 'ask'
        : getEffectiveStatus(c) === 'resolved'
          ? 'resolved'
          : 'open';
      next.push({
        id: c.id,
        y01: Math.min(Math.max(top / scrollHeight, 0), 1),
        kind,
        label: c.text.slice(0, 60),
      });
    }
    setTicks(next);
  }, [containerRef, comments, enabled, paintTick, remeasureTick]);

  // Late reflow (mermaid stabilization, image loads) shifts anchors after the
  // paint signal; watch the prose wrapper's height, same idiom as margin notes.
  useEffect(() => {
    if (!enabled) return;
    const prose = containerRef.current?.firstElementChild as HTMLElement | null;
    if (!prose) return;
    const ro = new ResizeObserver(() => {
      const h = prose.offsetHeight;
      if (lastHeightRef.current !== h) {
        lastHeightRef.current = h;
        setRemeasureTick((t) => t + 1);
      }
    });
    ro.observe(prose);
    return () => ro.disconnect();
  }, [containerRef, enabled]);

  return ticks;
}
