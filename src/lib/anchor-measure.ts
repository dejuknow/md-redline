/**
 * One pass over painted highlight marks: map each comment id to the topmost
 * mark's offset in scroll-content pixels. Marks (including mermaid SVG text
 * highlights) carry data-comment-ids with comma-separated ids.
 */
export function measureAnchorTops(container: HTMLElement): Map<string, number> {
  const containerRect = container.getBoundingClientRect();
  const tops = new Map<string, number>();
  for (const el of container.querySelectorAll<HTMLElement>('[data-comment-ids]')) {
    const ids = el.dataset.commentIds?.split(',') ?? [];
    const top = el.getBoundingClientRect().top - containerRect.top + container.scrollTop;
    for (const id of ids) {
      const existing = tops.get(id);
      if (existing === undefined || top < existing) tops.set(id, top);
    }
  }
  return tops;
}

/**
 * Page-relative variant: measures painted marks against an element that
 * scrolls together with them, so no scrollTop term is needed. Used by the
 * margin layer now that it lives inside the page.
 */
export function measureAnchorTopsWithin(scope: HTMLElement): Map<string, number> {
  const scopeRect = scope.getBoundingClientRect();
  const tops = new Map<string, number>();
  for (const el of scope.querySelectorAll<HTMLElement>('[data-comment-ids]')) {
    const ids = el.dataset.commentIds?.split(',') ?? [];
    const top = el.getBoundingClientRect().top - scopeRect.top;
    for (const id of ids) {
      const existing = tops.get(id);
      if (existing === undefined || top < existing) tops.set(id, top);
    }
  }
  return tops;
}
