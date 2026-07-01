import type { TocHeading } from '../components/MarkdownViewer';

/**
 * Ancestor chain for the active heading: walk backward collecting the nearest
 * preceding heading of each shallower level, stopping at level 1. The active
 * heading is always the last segment.
 */
export function headingChain(
  tocHeadings: TocHeading[],
  activeId: string | null,
  maxSegments = 3,
): TocHeading[] {
  if (!activeId) return [];
  const idx = tocHeadings.findIndex((h) => h.id === activeId);
  if (idx < 0) return [];
  const chain: TocHeading[] = [tocHeadings[idx]];
  let level = tocHeadings[idx].level;
  for (let i = idx - 1; i >= 0 && level > 1; i--) {
    if (tocHeadings[i].level < level) {
      chain.unshift(tocHeadings[i]);
      level = tocHeadings[i].level;
    }
  }
  return chain.slice(-maxSegments);
}
