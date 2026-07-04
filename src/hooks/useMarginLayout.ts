import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MdComment } from '../types';
import { resolveCollisions, type MarginEntry } from '../lib/margin-layout';
import { measureAnchorTopsWithin } from '../lib/anchor-measure';

export interface MarginLayout {
  active: boolean;
  tops: Map<string, number>;
  anchorTops: Map<string, number>;
  orphanIds: string[];
  registerCardRef: (id: string, node: HTMLDivElement | null) => void;
  layerHeight: number;
}

/**
 * Owns all DOM measurement for margin notes: anchor positions (from painted
 * highlight marks, measured page-relative) and card heights. Width is no
 * longer this hook's concern: the caller decides whether the rail shows
 * (`active`) and its width is a fixed constant (`RAIL` in page-geometry).
 * Pure layout math lives in resolveCollisions.
 */
export function useMarginLayout(
  _scrollRef: React.RefObject<HTMLElement | null>,
  pageRef: React.RefObject<HTMLElement | null>,
  comments: MdComment[],
  activeCommentId: string | null,
  active: boolean,
  paintTick: number,
): MarginLayout {
  const [anchorTops, setAnchorTops] = useState<Map<string, number>>(new Map());
  const [heights, setHeights] = useState<Map<string, number>>(new Map());
  const cardNodes = useRef(new Map<string, HTMLDivElement>());
  const heightObserver = useRef<ResizeObserver | null>(null);
  const [remeasureTick, setRemeasureTick] = useState(0);
  const lastProseHeightRef = useRef<number | null>(null);

  // Anchor measurement: one pass over painted marks per trigger (paint tick,
  // comment set change, or a late-reflow remeasure tick). Measured against
  // the page, which scrolls together with the marks, so no scrollTop term
  // is needed.
  useEffect(() => {
    if (!active) return;
    const page = pageRef.current;
    if (!page) return;
    const next = measureAnchorTopsWithin(page);
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
  }, [active, pageRef, comments, paintTick, remeasureTick]);

  // Mermaid stabilization and image loads can shift prose height after the
  // paint signal already fired. Watch the prose column itself and bump a
  // tick when its height actually changes, so the anchor-measurement effect
  // above re-runs and catches the late reflow.
  useEffect(() => {
    if (!active) return;
    const prose = pageRef.current?.firstElementChild;
    if (!prose) return;
    const ro = new ResizeObserver((entries) => {
      const height = entries[0]?.contentRect.height;
      if (height === undefined || height === lastProseHeightRef.current) return;
      lastProseHeightRef.current = height;
      setRemeasureTick((t) => t + 1);
    });
    ro.observe(prose);
    return () => ro.disconnect();
  }, [active, pageRef]);

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

  return { active, tops, anchorTops, orphanIds, registerCardRef, layerHeight };
}
