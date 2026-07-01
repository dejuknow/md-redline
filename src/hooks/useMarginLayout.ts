import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MdComment } from '../types';
import { resolveCollisions, type MarginEntry } from '../lib/margin-layout';

const COLUMN = 672;
const LEFT_OFFSET = 48;
const GUTTER = 24;
const RIGHT_PAD = 24;
const CARD_MAX = 280;
export const MIN_CONTAINER_WIDTH = 1048;

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
 * Owns all DOM measurement for margin notes: container width (activation),
 * anchor positions (from painted highlight marks), and card heights.
 * Pure layout math lives in resolveCollisions.
 */
export function useMarginLayout(
  containerRef: React.RefObject<HTMLElement | null>,
  comments: MdComment[],
  activeCommentId: string | null,
  enabled: boolean,
  paintTick: number,
): MarginLayout {
  const [containerWidth, setContainerWidth] = useState(0);
  const [anchorTops, setAnchorTops] = useState<Map<string, number>>(new Map());
  const [heights, setHeights] = useState<Map<string, number>>(new Map());
  const cardNodes = useRef(new Map<string, HTMLDivElement>());
  const heightObserver = useRef<ResizeObserver | null>(null);

  // Container width via ResizeObserver (activation + margin width).
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const ro = new ResizeObserver(() => setContainerWidth(container.clientWidth));
    ro.observe(container);
    setContainerWidth(container.clientWidth);
    return () => ro.disconnect();
  }, [containerRef, enabled]);

  const freeMargin = containerWidth - COLUMN - LEFT_OFFSET - GUTTER - RIGHT_PAD;
  const active = enabled && containerWidth >= MIN_CONTAINER_WIDTH;
  const marginWidth = Math.min(CARD_MAX, Math.max(0, freeMargin));

  // Anchor measurement: one pass over painted marks per trigger.
  useEffect(() => {
    if (!active) return;
    const container = containerRef.current;
    if (!container) return;
    const containerRect = container.getBoundingClientRect();
    const next = new Map<string, number>();
    for (const el of container.querySelectorAll<HTMLElement>('[data-comment-ids]')) {
      const ids = el.dataset.commentIds?.split(',') ?? [];
      const top = el.getBoundingClientRect().top - containerRect.top + container.scrollTop;
      for (const id of ids) {
        const existing = next.get(id);
        if (existing === undefined || top < existing) next.set(id, top);
      }
    }
    setAnchorTops(next);
  }, [active, containerRef, comments, paintTick]);

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
