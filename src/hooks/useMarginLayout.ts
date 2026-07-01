import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MdComment } from '../types';
import { resolveCollisions, type MarginEntry } from '../lib/margin-layout';
import { measureAnchorTops } from '../lib/anchor-measure';

const COLUMN = 672;
const LEFT_OFFSET = 48;
const GUTTER = 24;
const CARD_MAX = 280;

export interface MarginLayout {
  active: boolean;
  marginWidth: number;
  tops: Map<string, number>;
  anchorTops: Map<string, number>;
  orphanIds: string[];
  registerCardRef: (id: string, node: HTMLDivElement | null) => void;
  layerHeight: number;
}

/**
 * Owns all DOM measurement for margin notes: content width (activation,
 * measured inside the container's own padding since the layer lives in the
 * content box, not the border box), anchor positions (from painted highlight
 * marks), and card heights. Pure layout math lives in resolveCollisions.
 */
export function useMarginLayout(
  containerRef: React.RefObject<HTMLElement | null>,
  comments: MdComment[],
  activeCommentId: string | null,
  enabled: boolean,
  paintTick: number,
): MarginLayout {
  const [contentWidth, setContentWidth] = useState(0);
  const [anchorTops, setAnchorTops] = useState<Map<string, number>>(new Map());
  const [heights, setHeights] = useState<Map<string, number>>(new Map());
  const cardNodes = useRef(new Map<string, HTMLDivElement>());
  const heightObserver = useRef<ResizeObserver | null>(null);
  const [remeasureTick, setRemeasureTick] = useState(0);
  const lastProseHeightRef = useRef<number | null>(null);

  // Content width via ResizeObserver (activation + margin width). Content
  // width excludes the container's own horizontal padding (px-8/lg:px-12/
  // xl:px-16), which otherwise overstates how much room the margin layer
  // actually has beside the prose column. Recomputed on every resize because
  // the padding itself changes across breakpoints.
  useEffect(() => {
    if (!enabled) {
      setContentWidth(0);
      return;
    }
    const container = containerRef.current;
    if (!container) return;
    const measure = () => {
      const cs = getComputedStyle(container);
      const pad = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
      setContentWidth(container.clientWidth - pad);
    };
    const ro = new ResizeObserver(measure);
    ro.observe(container);
    measure();
    return () => ro.disconnect();
  }, [containerRef, enabled]);

  // Free margin is the content width left over after the prose column, its
  // left offset, and the gutter between prose and the margin layer. The
  // layer's own `right: 24` inset already sits inside the container's right
  // padding, so it isn't subtracted again here.
  const freeMargin = contentWidth - COLUMN - LEFT_OFFSET - GUTTER;
  const active = enabled && freeMargin >= CARD_MAX;
  const marginWidth = Math.min(CARD_MAX, Math.max(0, freeMargin));

  // Anchor measurement: one pass over painted marks per trigger (paint tick,
  // comment set change, or a late-reflow remeasure tick).
  useEffect(() => {
    if (!active) return;
    const container = containerRef.current;
    if (!container) return;
    const next = measureAnchorTops(container);
    setAnchorTops((prev) => {
      if (prev.size === next.size) {
        let same = true;
        for (const [k, v] of next) {
          if (prev.get(k) !== v) {
            same = false;
            break;
          }
        }
        if (same) return prev;
      }
      return next;
    });
  }, [active, containerRef, comments, paintTick, remeasureTick]);

  // Mermaid stabilization and image loads can shift prose height after the
  // paint signal already fired. Watch the prose wrapper itself and bump a
  // tick when its height actually changes, so the anchor-measurement effect
  // above re-runs and catches the late reflow.
  useEffect(() => {
    if (!active) return;
    const container = containerRef.current;
    const prose = container?.firstElementChild;
    if (!prose) return;
    const ro = new ResizeObserver((entries) => {
      const height = entries[0]?.contentRect.height;
      if (height === undefined || height === lastProseHeightRef.current) return;
      lastProseHeightRef.current = height;
      setRemeasureTick((t) => t + 1);
    });
    ro.observe(prose);
    return () => ro.disconnect();
  }, [active, containerRef]);

  // Card height measurement via one ResizeObserver over registered card nodes.
  const registerCardRef = useCallback((id: string, node: HTMLDivElement | null) => {
    const existing = cardNodes.current.get(id);
    if (existing && heightObserver.current) heightObserver.current.unobserve(existing);
    if (node) {
      cardNodes.current.set(id, node);
      heightObserver.current?.observe(node);
      setHeights((prev) => {
        const h = node.offsetHeight;
        if (prev.get(id) === h) return prev;
        const next = new Map(prev);
        next.set(id, h);
        return next;
      });
    } else {
      cardNodes.current.delete(id);
      setHeights((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Map(prev);
        next.delete(id);
        return next;
      });
    }
  }, []);

  useEffect(() => {
    const ro = new ResizeObserver((entries) => {
      setHeights((prev) => {
        let changed = false;
        const next = new Map(prev);
        for (const entry of entries) {
          for (const [id, node] of cardNodes.current) {
            if (node === entry.target) {
              const h = node.offsetHeight;
              if (next.get(id) !== h) {
                next.set(id, h);
                changed = true;
              }
            }
          }
        }
        return changed ? next : prev;
      });
    });
    heightObserver.current = ro;
    for (const node of cardNodes.current.values()) ro.observe(node);
    return () => {
      ro.disconnect();
      heightObserver.current = null;
    };
  }, []);

  const { tops, orphanIds, layerHeight } = useMemo(() => {
    const entries: MarginEntry[] = comments.map((c) => ({
      id: c.id,
      anchorTop: anchorTops.get(c.id) ?? null,
      height: heights.get(c.id) ?? 120, // estimate until measured
    }));
    const resolved = resolveCollisions(entries, activeCommentId);
    const orphans = entries.filter((e) => e.anchorTop === null).map((e) => e.id);
    let bottom = 0;
    for (const e of entries) {
      const top = resolved.get(e.id);
      if (top !== undefined) bottom = Math.max(bottom, top + e.height);
    }
    return { tops: resolved, orphanIds: orphans, layerHeight: bottom + 24 };
  }, [comments, anchorTops, heights, activeCommentId]);

  return { active, marginWidth, tops, anchorTops, orphanIds, registerCardRef, layerHeight };
}
