export interface MarginEntry {
  id: string;
  /** Anchor offsetTop in scroll-content pixels; null when the comment is an orphan. */
  anchorTop: number | null;
  /** Measured card height in pixels. */
  height: number;
}

export const MARGIN_GAP = 8;

/**
 * Max distance (px) a non-active card may be lifted above its own anchor
 * by the active card's pin. Past the cap the pinned card moves down by
 * the residual instead, so a cluster never drags cards far from their
 * anchors (crit round 2, item 04).
 */
export const MAX_LIFT = 96;

/**
 * Compute card top positions for margin notes.
 *
 * Orphans stack in a block from 0. Anchored cards sort by anchor position and
 * resolve top-down (push-down on overlap). The active card gets best-effort
 * priority: it pins at its anchor when possible, and cards above compress
 * upward toward the orphan-block floor (capped at MAX_LIFT above each card's
 * own anchor). When they cannot free enough room, the active card shifts down
 * by exactly the residual overflow instead. No two cards ever overlap.
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

  // Active priority: pin the active card at its anchor when possible. Cards
  // above compress upward toward the orphan-block floor (two passes: desired
  // tops walking up, then floor and stacking enforcement walking down). When
  // they cannot free enough room, the active card shifts down by exactly the
  // residual overflow. No two cards ever overlap.
  const idx = activeId ? anchored.findIndex((e) => e.id === activeId) : -1;
  if (idx >= 0) {
    const active = anchored[idx];
    const pinned = Math.max(active.anchorTop, floor);

    // Pass 1 (walking up from the active card): desired tops, ignoring the
    // floor but never lifting a card more than MAX_LIFT above its anchor.
    const desired = new Array<number>(idx);
    let nextTop = pinned;
    for (let i = idx - 1; i >= 0; i--) {
      const ideal = Math.min(anchored[i].anchorTop, nextTop - anchored[i].height - gap);
      desired[i] = Math.max(ideal, anchored[i].anchorTop - MAX_LIFT);
      nextTop = desired[i];
    }

    // Pass 2 (walking down): enforce the floor and re-stack without overlap.
    let prevBottom = floor - gap;
    for (let i = 0; i < idx; i++) {
      const top = Math.max(desired[i], prevBottom + gap);
      tops.set(anchored[i].id, top);
      prevBottom = top + anchored[i].height;
    }

    // The active card sits at its pin unless the group above still intrudes.
    const activeTop = Math.max(pinned, prevBottom + gap);
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
