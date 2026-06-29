export interface MarginEntry {
  id: string;
  /** Anchor offsetTop in scroll-content pixels; null when the comment is an orphan. */
  anchorTop: number | null;
  /** Measured card height in pixels. */
  height: number;
}

export const MARGIN_GAP = 8;

/**
 * Compute card top positions for margin notes.
 *
 * Orphans stack in a block from 0. Anchored cards sort by anchor position and
 * resolve top-down (push-down on overlap). The active card gets best-effort
 * priority: it pins at its anchor, cards above compress upward toward the
 * orphan-block floor, and if they cannot free enough room the active card and
 * everything below shift down by the remaining overflow. No two cards overlap.
 */
export function resolveCollisions(
  entries: MarginEntry[],
  activeId: string | null,
  gap: number = MARGIN_GAP,
): Map<string, number> {
  const tops = new Map<string, number>();

  const orphans = entries.filter((e) => e.anchorTop === null);
  const anchored = entries
    .filter((e): e is MarginEntry & { anchorTop: number } => e.anchorTop !== null)
    .slice()
    .sort((a, b) => a.anchorTop - b.anchorTop); // stable sort keeps array order on ties

  let cursor = 0;
  for (const o of orphans) {
    tops.set(o.id, cursor);
    cursor += o.height + gap;
  }
  const floor = cursor;

  // Downward pass.
  let prevBottom = floor - gap;
  for (const e of anchored) {
    const top = Math.max(e.anchorTop, prevBottom + gap);
    tops.set(e.id, top);
    prevBottom = top + e.height;
  }

  // Active priority.
  const idx = activeId ? anchored.findIndex((e) => e.id === activeId) : -1;
  if (idx >= 0) {
    const active = anchored[idx];
    const pinned = Math.max(active.anchorTop, floor);

    // Compress the cards above toward the floor to make room for the pin.
    let nextTop = pinned;
    let overflow = 0;
    const above = new Map<string, number>();
    for (let i = idx - 1; i >= 0; i--) {
      const e = anchored[i];
      let top = Math.min(e.anchorTop, nextTop - e.height - gap);
      if (top < floor) {
        // Cannot compress past the floor; accumulate how much room is missing.
        top = floor;
        overflow = Math.max(overflow, floor + e.height + gap - nextTop);
      }
      above.set(e.id, top);
      nextTop = top;
    }
    // A floor collision above means the pin cannot be fully honored: the
    // active card and everything below shift down by the overflow instead
    // of overlapping.
    for (const [id, top] of above) tops.set(id, top);
    let bottom = -Infinity;
    for (let i = 0; i < idx; i++) {
      bottom = Math.max(bottom, tops.get(anchored[i].id)! + anchored[i].height);
    }
    const activeTop = Math.max(pinned + overflow, bottom === -Infinity ? floor : bottom + gap);
    tops.set(active.id, activeTop);

    // Re-run the downward pass below the active card.
    let pb = activeTop + active.height;
    for (let i = idx + 1; i < anchored.length; i++) {
      const e = anchored[i];
      const top = Math.max(e.anchorTop, pb + gap);
      tops.set(e.id, top);
      pb = top + e.height;
    }
  }

  return tops;
}
