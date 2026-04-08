import { describe, expect, it } from 'vitest';
import { score } from './scorer';
import type { ExpectedCriteria } from './types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMarker(overrides: Record<string, unknown> = {}): string {
  const data = {
    id: 'c1',
    anchor: 'hello',
    text: 'fix this',
    author: 'User',
    timestamp: '2024-01-01T00:00:00.000Z',
    replies: [],
    ...overrides,
  };
  return `<!-- @comment${JSON.stringify(data)} -->`;
}

function makeExpected(overrides: Partial<ExpectedCriteria> = {}): ExpectedCriteria {
  return {
    totalComments: 1,
    actionableComments: 1,
    comments: [{ id: 'c1', expectedAction: 'address' }],
    contentShouldChange: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('scorer', () => {
  // -----------------------------------------------------------------------
  // 1. Perfect score — all markers removed, content changed, no markers left
  // -----------------------------------------------------------------------
  describe('perfect score', () => {
    it('returns 1.0 overall when all markers removed and content changed', () => {
      const input = `Some text ${makeMarker({ id: 'c1', anchor: 'hello' })}hello world`;
      const output = 'Some text hello world — addressed';
      const expected = makeExpected();

      const result = score('test-case', input, output, expected);

      expect(result.scores.parsing).toBe(1.0);
      expect(result.scores.execution).toBe(1.0);
      expect(result.scores.integrity).toBe(1.0);
      expect(result.overall).toBe(1.0);
      expect(result.case).toBe('test-case');
    });
  });

  // -----------------------------------------------------------------------
  // 2. Parsing dimension
  // -----------------------------------------------------------------------
  describe('parsing score', () => {
    it('scores 1.0 when totalComments is 0', () => {
      const input = 'Clean document';
      const output = 'Clean document';
      const expected = makeExpected({
        totalComments: 0,
        actionableComments: 0,
        comments: [],
        contentShouldChange: false,
      });

      const result = score('no-comments', input, output, expected);
      expect(result.scores.parsing).toBe(1.0);
    });

    it('scores 1.0 when all actionable markers are removed', () => {
      const input = `A ${makeMarker({ id: 'c1', anchor: 'A' })}B ${makeMarker({ id: 'c2', anchor: 'B' })}`;
      const output = 'A B — fixed both';
      const expected = makeExpected({
        totalComments: 2,
        actionableComments: 2,
        comments: [
          { id: 'c1', expectedAction: 'address' },
          { id: 'c2', expectedAction: 'address' },
        ],
      });

      const result = score('all-removed', input, output, expected);
      expect(result.scores.parsing).toBe(1.0);
    });

    it('scores 0.5 when half of actionable markers are removed', () => {
      const m1 = makeMarker({ id: 'c1', anchor: 'A' });
      const m2 = makeMarker({ id: 'c2', anchor: 'B' });
      const input = `A ${m1}B ${m2}`;
      // Agent removed c1 but left c2
      const output = `A B ${makeMarker({ id: 'c2', anchor: 'B' })}`;
      const expected = makeExpected({
        totalComments: 2,
        actionableComments: 2,
        comments: [
          { id: 'c1', expectedAction: 'address' },
          { id: 'c2', expectedAction: 'address' },
        ],
      });

      const result = score('half-removed', input, output, expected);
      expect(result.scores.parsing).toBe(0.5);
    });

    it('scores 0.0 when no actionable markers are removed', () => {
      const m1 = makeMarker({ id: 'c1', anchor: 'hello' });
      const input = `Hello ${m1}world`;
      const output = `Hello ${m1}world — edited`;
      const expected = makeExpected();

      const result = score('none-removed', input, output, expected);
      expect(result.scores.parsing).toBe(0.0);
    });

    it('ignores skip comments when scoring parsing', () => {
      const m1 = makeMarker({ id: 'c1', anchor: 'A' });
      const m2 = makeMarker({ id: 'c2', anchor: 'B' });
      const input = `A ${m1}B ${m2}`;
      // Agent removed c1 (addressable) but left c2 (skip) — perfect parsing
      const output = `A B ${makeMarker({ id: 'c2', anchor: 'B' })}`;
      const expected = makeExpected({
        totalComments: 2,
        actionableComments: 1,
        comments: [
          { id: 'c1', expectedAction: 'address' },
          { id: 'c2', expectedAction: 'skip' },
        ],
      });

      const result = score('skip-ignored', input, output, expected);
      expect(result.scores.parsing).toBe(1.0);
    });

    it('scores 1.0 when there are comments but none are actionable', () => {
      const m1 = makeMarker({ id: 'c1', anchor: 'A' });
      const input = `A ${m1}`;
      const output = `A ${makeMarker({ id: 'c1', anchor: 'A' })}`;
      const expected = makeExpected({
        totalComments: 1,
        actionableComments: 0,
        comments: [{ id: 'c1', expectedAction: 'skip' }],
        contentShouldChange: false,
      });

      const result = score('no-actionable', input, output, expected);
      expect(result.scores.parsing).toBe(1.0);
    });
  });

  // -----------------------------------------------------------------------
  // 3. Execution dimension
  // -----------------------------------------------------------------------
  describe('execution score', () => {
    it('scores 1.0 when content should not change and did not', () => {
      const input = 'Unchanged document content';
      const output = 'Unchanged document content';
      const expected = makeExpected({
        totalComments: 0,
        actionableComments: 0,
        comments: [],
        contentShouldChange: false,
      });

      const result = score('no-change', input, output, expected);
      expect(result.scores.execution).toBe(1.0);
    });

    it('scores 0.0 when content should not change but did', () => {
      const input = 'Original content';
      const output = 'Modified content';
      const expected = makeExpected({
        totalComments: 0,
        actionableComments: 0,
        comments: [],
        contentShouldChange: false,
      });

      const result = score('unexpected-change', input, output, expected);
      expect(result.scores.execution).toBe(0.0);
    });

    it('scores 1.0 when content changed and no assertions are specified', () => {
      const input = `Hello ${makeMarker({ id: 'c1', anchor: 'Hello' })}world`;
      const output = 'Hello world — addressed';
      const expected = makeExpected({ contentShouldChange: true });

      const result = score('changed-no-assertions', input, output, expected);
      expect(result.scores.execution).toBe(1.0);
    });

    it('scores 0.0 when content should change but did not', () => {
      const m1 = makeMarker({ id: 'c1', anchor: 'Hello' });
      const input = `Hello ${m1}world`;
      const output = 'Hello world'; // same clean markdown
      const expected = makeExpected({ contentShouldChange: true });

      const result = score('no-change-when-expected', input, output, expected);
      expect(result.scores.execution).toBe(0.0);
    });

    it('scores based on contentAssertions contains/not_contains', () => {
      const input = `Hello ${makeMarker({ id: 'c1', anchor: 'Hello' })}world`;
      const output = 'Hello brave new world';
      const expected = makeExpected({
        contentShouldChange: true,
        contentAssertions: [
          { type: 'contains', value: 'brave new' },
          { type: 'not_contains', value: 'old' },
        ],
      });

      const result = score('assertions-pass', input, output, expected);
      expect(result.scores.execution).toBe(1.0);
    });

    it('scores 0.0 when all assertions fail', () => {
      const input = `Hello ${makeMarker({ id: 'c1', anchor: 'Hello' })}world`;
      const output = 'Hello old world';
      const expected = makeExpected({
        contentShouldChange: true,
        contentAssertions: [
          { type: 'contains', value: 'brave new' },
          { type: 'not_contains', value: 'old' },
        ],
      });

      const result = score('assertions-fail', input, output, expected);
      expect(result.scores.execution).toBe(0.0);
    });

    it('scores 0.5 when half of assertions pass', () => {
      const input = `Hello ${makeMarker({ id: 'c1', anchor: 'Hello' })}world`;
      const output = 'Hello brave old world';
      const expected = makeExpected({
        contentShouldChange: true,
        contentAssertions: [
          { type: 'contains', value: 'brave' },       // pass
          { type: 'not_contains', value: 'old' },      // fail — "old" is present
        ],
      });

      const result = score('half-assertions', input, output, expected);
      expect(result.scores.execution).toBe(0.5);
    });

    it('evaluates per-comment contentHints', () => {
      const input = `Hello ${makeMarker({ id: 'c1', anchor: 'Hello' })}world`;
      const output = 'Hello improved world';
      const expected = makeExpected({
        contentShouldChange: true,
        comments: [
          {
            id: 'c1',
            expectedAction: 'address',
            contentHints: {
              shouldContain: ['improved'],
              shouldNotContain: ['broken'],
            },
          },
        ],
      });

      const result = score('content-hints-pass', input, output, expected);
      expect(result.scores.execution).toBe(1.0);
    });

    it('content hints for "skip" comments are ignored', () => {
      const input = `A ${makeMarker({ id: 'c1', anchor: 'A' })}`;
      const output = 'A — changed';
      const expected = makeExpected({
        contentShouldChange: true,
        comments: [
          {
            id: 'c1',
            expectedAction: 'skip',
            contentHints: {
              shouldContain: ['will-not-be-found'],
            },
          },
        ],
      });

      const result = score('skip-hints-ignored', input, output, expected);
      // No checks applied → falls back to "content changed" check
      expect(result.scores.execution).toBe(1.0);
    });

    it('combines contentAssertions and contentHints', () => {
      const input = `Hello ${makeMarker({ id: 'c1', anchor: 'Hello' })}world`;
      const output = 'Hello improved world';
      const expected = makeExpected({
        contentShouldChange: true,
        contentAssertions: [
          { type: 'contains', value: 'improved' },  // pass
        ],
        comments: [
          {
            id: 'c1',
            expectedAction: 'address',
            contentHints: {
              shouldContain: ['improved'],            // pass
              shouldNotContain: ['broken'],           // pass
            },
          },
        ],
      });

      const result = score('combined-checks', input, output, expected);
      expect(result.scores.execution).toBe(1.0);
    });
  });

  // -----------------------------------------------------------------------
  // 4. Integrity dimension
  // -----------------------------------------------------------------------
  describe('integrity score', () => {
    it('scores 1.0 when no markers remain in output', () => {
      const input = `Hello ${makeMarker()}world`;
      const output = 'Hello world — fixed';
      const expected = makeExpected();

      const result = score('no-markers', input, output, expected);
      expect(result.scores.integrity).toBe(1.0);
    });

    it('scores 1.0 when remaining markers are valid JSON with required fields', () => {
      const m = makeMarker({ id: 'skip1', anchor: 'test', text: 'note' });
      const input = `Hello ${m}world`;
      const output = `Hello ${m}world`;
      const expected = makeExpected({
        contentShouldChange: false,
        comments: [{ id: 'skip1', expectedAction: 'skip' }],
      });

      const result = score('valid-remaining', input, output, expected);
      expect(result.scores.integrity).toBe(1.0);
    });

    it('scores 0.0 when remaining markers have malformed JSON', () => {
      const input = 'Hello world';
      const output = 'Hello <!-- @comment{not valid json} -->world';
      const expected = makeExpected({
        contentShouldChange: true,
      });

      const result = score('malformed-marker', input, output, expected);
      expect(result.scores.integrity).toBe(0.0);
    });

    it('scores 0.0 when remaining markers are missing essential fields', () => {
      const input = 'Hello world';
      // Valid JSON but missing 'id' field
      const output = 'Hello <!-- @comment{"anchor":"x","text":"y"} -->world';
      const expected = makeExpected({
        contentShouldChange: true,
      });

      const result = score('missing-fields', input, output, expected);
      expect(result.scores.integrity).toBe(0.0);
    });

    it('scores partial when some remaining markers are valid and some are not', () => {
      const validMarker = makeMarker({ id: 'v1', anchor: 'A', text: 'good' });
      const invalidMarker = '<!-- @comment{invalid json} -->';
      const input = 'Hello world';
      const output = `A ${validMarker}B ${invalidMarker}`;
      const expected = makeExpected({
        contentShouldChange: true,
      });

      const result = score('mixed-markers', input, output, expected);
      expect(result.scores.integrity).toBe(0.5);
    });
  });

  // -----------------------------------------------------------------------
  // 5. Weighted overall score
  // -----------------------------------------------------------------------
  describe('overall score weighting', () => {
    it('weights are parsing=0.25, execution=0.50, integrity=0.25', () => {
      // All markers removed (parsing=1.0), content changed (execution=1.0), no markers left (integrity=1.0)
      const input = `Hello ${makeMarker()}world`;
      const output = 'Hello world — fixed';
      const expected = makeExpected();

      const result = score('perfect', input, output, expected);
      expect(result.overall).toBeCloseTo(1.0 * 0.25 + 1.0 * 0.5 + 1.0 * 0.25);
    });

    it('computes correct weighted score for partial results', () => {
      // parsing=0 (marker kept), execution=1 (content changed), integrity=1 (marker valid)
      const m = makeMarker({ id: 'c1', anchor: 'Hello' });
      const input = `Hello ${m}world`;
      const output = `Hello ${m}world — addressed`;
      const expected = makeExpected();

      const result = score('partial', input, output, expected);
      // parsing = 0.0, execution = 1.0, integrity = 1.0
      const expectedOverall = 0.0 * 0.25 + 1.0 * 0.5 + 1.0 * 0.25;
      expect(result.overall).toBeCloseTo(expectedOverall);
      expect(result.overall).toBeCloseTo(0.75);
    });
  });

  // -----------------------------------------------------------------------
  // 6. Details logging
  // -----------------------------------------------------------------------
  describe('details', () => {
    it('includes detail entries for each scoring dimension', () => {
      const input = `Hello ${makeMarker()}world`;
      const output = 'Hello world — fixed';
      const expected = makeExpected();

      const result = score('details-test', input, output, expected);
      expect(result.details.length).toBeGreaterThan(0);
      expect(result.details.some((d) => d.startsWith('parsing:'))).toBe(true);
      expect(result.details.some((d) => d.startsWith('execution:'))).toBe(true);
      expect(result.details.some((d) => d.startsWith('integrity:'))).toBe(true);
    });

    it('includes a warning when actionableComments count mismatches', () => {
      const input = `A ${makeMarker({ id: 'c1', anchor: 'A' })}`;
      const output = 'A — fixed';
      const expected = makeExpected({
        actionableComments: 5, // deliberately wrong
        comments: [{ id: 'c1', expectedAction: 'address' }],
      });

      const result = score('mismatch-warning', input, output, expected);
      expect(result.details.some((d) => d.startsWith('warning:'))).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // 7. Edge cases
  // -----------------------------------------------------------------------
  describe('edge cases', () => {
    it('handles empty input and output', () => {
      const expected = makeExpected({
        totalComments: 0,
        actionableComments: 0,
        comments: [],
        contentShouldChange: false,
      });

      const result = score('empty', '', '', expected);
      expect(result.scores.parsing).toBe(1.0);
      expect(result.scores.execution).toBe(1.0);
      expect(result.scores.integrity).toBe(1.0);
      expect(result.overall).toBe(1.0);
    });

    it('handles multiple comments with mixed actions', () => {
      const m1 = makeMarker({ id: 'c1', anchor: 'A' });
      const m2 = makeMarker({ id: 'c2', anchor: 'B' });
      const m3 = makeMarker({ id: 'c3', anchor: 'C' });
      const input = `A ${m1}B ${m2}C ${m3}`;
      // Agent removed c1 and c3, but kept c2 (which is skip)
      const output = `A B ${makeMarker({ id: 'c2', anchor: 'B' })}C — done`;
      const expected = makeExpected({
        totalComments: 3,
        actionableComments: 2,
        comments: [
          { id: 'c1', expectedAction: 'address' },
          { id: 'c2', expectedAction: 'skip' },
          { id: 'c3', expectedAction: 'address' },
        ],
      });

      const result = score('mixed-actions', input, output, expected);
      expect(result.scores.parsing).toBe(1.0); // both actionable removed
      expect(result.scores.execution).toBe(1.0); // content changed
      expect(result.scores.integrity).toBe(1.0); // remaining marker is valid
    });

    it('truncates long assertion values in details', () => {
      const longValue = 'A'.repeat(100);
      const input = `Hello ${makeMarker({ id: 'c1', anchor: 'Hello' })}world`;
      const output = 'Hello world';
      const expected = makeExpected({
        contentShouldChange: true,
        contentAssertions: [
          { type: 'contains', value: longValue },
        ],
      });

      const result = score('long-assertion', input, output, expected);
      // The detail should contain a truncated version
      const assertionDetail = result.details.find((d) => d.includes('AAAA'));
      expect(assertionDetail).toBeDefined();
      expect(assertionDetail!.length).toBeLessThan(longValue.length + 50);
    });
  });
});
