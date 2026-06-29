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
 * priority: it pins at its anchor and cards above attempt to pack upward
 * toward the orphan-block floor. That attempt is all-or-nothing: if the chain
 * would cross the floor, the cards above fall back to their downward-pass
 * positions and the active card is placed below them instead. No two cards
 * overlap either way.
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

  // Active priority: try to pin the active card at its anchor by packing the
  // cards above it upward. The attempt is all-or-nothing: if the chain would
  // need to cross the orphan-block floor, the cards above keep their
  // downward-pass positions and the active card shifts below them instead.
  // Either way, no two cards ever overlap.
  const idx = activeId ? anchored.findIndex((e) => e.id === activeId) : -1;
  if (idx >= 0) {
    const active = anchored[idx];
    const pinned = Math.max(active.anchorTop, floor);

    const attempt = new Map<string, number>();
    let nextTop = pinned;
    let feasible = true;
    for (let i = idx - 1; i >= 0; i--) {
      const e = anchored[i];
      const top = Math.min(e.anchorTop, nextTop - e.height - gap);
      if (top < floor) {
        feasible = false;
        break;
      }
      attempt.set(e.id, top);
      nextTop = top;
    }

    if (feasible) {
      for (const [id, top] of attempt) tops.set(id, top);
      tops.set(active.id, pinned);
    } else {
      const prev = idx > 0 ? anchored[idx - 1] : null;
      const prevBottom = prev ? tops.get(prev.id)! + prev.height : floor - gap;
      tops.set(active.id, Math.max(pinned, prevBottom + gap));
    }

    let pb = tops.get(active.id)! + active.height;
    for (let i = idx + 1; i < anchored.length; i++) {
      const e = anchored[i];
      const top = Math.max(e.anchorTop, pb + gap);
      tops.set(e.id, top);
      pb = top + e.height;
    }
  }

  return tops;
}
