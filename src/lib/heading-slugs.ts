/**
 * Generate a URL-friendly slug from heading text.
 * Strips non-word characters (except hyphens), collapses whitespace to hyphens,
 * and lowercases everything.
 */
export function slugify(text: string): string {
  const slug = text
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-');
  return slug || 'heading';
}

/**
 * Generate unique slugs for an array of heading texts.
 * Duplicate slugs get `-1`, `-2`, etc. suffixes.
 */
export function uniqueSlugs(texts: string[]): string[] {
  const used = new Set<string>();
  return texts.map((text) => {
    const slug = slugify(text);
    let unique = slug;
    let counter = 1;
    while (used.has(unique)) {
      unique = `${slug}-${counter++}`;
    }
    used.add(unique);
    return unique;
  });
}

/**
 * Assign unique slug IDs to heading elements in a container.
 * Duplicate slugs get `-1`, `-2`, etc. suffixes.
 */
export function assignHeadingIds(container: HTMLElement): void {
  const headingEls = container.querySelectorAll('h1, h2, h3, h4, h5, h6');
  const texts = Array.from(headingEls).map((el) => el.textContent || '');
  const slugs = uniqueSlugs(texts);
  headingEls.forEach((el, i) => {
    el.id = slugs[i];
  });
}
