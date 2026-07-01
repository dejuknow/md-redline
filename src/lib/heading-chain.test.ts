import { describe, expect, it } from 'vitest';
import { headingChain } from './heading-chain';

const H = (id: string, level: number, text = id) => ({ id, text, level });

const DOC = [
  H('intro', 1, 'Project Specification'),
  H('background', 2, 'Background'),
  H('constraints', 3, 'Technical Constraints'),
  H('goals', 2, 'Goals'),
  H('deep', 4, 'Deep Detail'),
];

describe('headingChain', () => {
  it('returns the ancestor chain ending at the active heading', () => {
    expect(headingChain(DOC, 'constraints').map((h) => h.id)).toEqual([
      'intro',
      'background',
      'constraints',
    ]);
  });

  it('skips missing intermediate levels', () => {
    // deep (h4) follows goals (h2): chain is h1 > h2 > h4
    expect(headingChain(DOC, 'deep').map((h) => h.id)).toEqual(['intro', 'goals', 'deep']);
  });

  it('caps segments keeping the deepest (active last)', () => {
    expect(headingChain(DOC, 'deep', 2).map((h) => h.id)).toEqual(['goals', 'deep']);
  });

  it('returns a single segment for a top-level active heading', () => {
    expect(headingChain(DOC, 'intro').map((h) => h.id)).toEqual(['intro']);
  });

  it('returns empty for null or unknown ids', () => {
    expect(headingChain(DOC, null)).toEqual([]);
    expect(headingChain(DOC, 'nope')).toEqual([]);
    expect(headingChain([], 'intro')).toEqual([]);
  });
});
