// @vitest-environment jsdom

/**
 * Repro: a repeated anchor resolves to a LATER occurrence even though the
 * selection's context names the first one.
 *
 * The inputs come from the real selection path, not hand-written: the document
 * is rendered with the options useComments passes by default
 * (renderHtmlComments on, the shipped hidden-comment prefixes), occurrence 1 is
 * selected in the DOM, and resolveSelection supplies text, contextBefore,
 * contextAfter and offset (the hintOffset).
 *
 * Mechanism: a hidden HTML comment (`<!-- vale off -->`) is dropped from the
 * DOM but kept by stripInlineFormatting. Next to occurrence 1 it makes the
 * plain text diverge from the DOM context at the first character, so
 * pickBestOccurrence's prefix score for occurrence 1's contextAfter is 0. A
 * later occurrence followed by the same words matches that context and wins.
 * The hint is correct and plays no part: it only breaks exact score ties.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderMarkdown } from '../markdown/pipeline';
import { DEFAULT_HIDDEN_COMMENT_PREFIXES } from './settings';
import { resolveSelection } from './selection-resolver';
import { insertComment, parseComments, resolveAnchorOffset } from './comment-parser';

if (!Range.prototype.getBoundingClientRect) {
  Range.prototype.getBoundingClientRect = () => ({ toJSON: () => {} }) as DOMRect;
}

beforeEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

const ANCHOR = 'Recommend yes';

const doc = (nextToFirst: string) =>
  `Verdict: **Recommend yes**${nextToFirst} — see the appendix.\n\n` +
  'Verdict: **Recommend yes** — cheaper.\n\n' +
  'Verdict: **Recommend yes** — see the appendix.\n';

/** Selects the k-th rendered occurrence of `anchor` and returns what the UI would send. */
function selectOccurrence(md: string, anchor: string, k: number) {
  const container = document.createElement('div');
  container.innerHTML = renderMarkdown(md, undefined, {
    renderHtmlComments: true,
    hiddenCommentPrefixes: DEFAULT_HIDDEN_COMMENT_PREFIXES,
  });
  document.body.appendChild(container);
  const hits = [...container.querySelectorAll('strong')].filter((el) => el.textContent === anchor);
  expect(hits.length).toBe(3);
  const range = document.createRange();
  range.selectNodeContents(hits[k].firstChild!);
  vi.spyOn(window, 'getSelection').mockReturnValue({
    isCollapsed: false,
    rangeCount: 1,
    getRangeAt: () => range,
    toString: () => range.toString(),
  } as unknown as Selection);
  return resolveSelection(container)!;
}

/** Clean-markdown offset of each `**anchor**` occurrence's text. */
function occurrences(md: string, anchor: string): number[] {
  const out: number[] = [];
  for (let i = md.indexOf(`**${anchor}**`); i !== -1; i = md.indexOf(`**${anchor}**`, i + 1)) {
    out.push(i + 2);
  }
  return out;
}

describe('repeated anchor next to a hidden HTML comment', () => {
  it('control: without the comment, occurrence 1 resolves to occurrence 1', () => {
    const md = doc('');
    const sel = selectOccurrence(md, ANCHOR, 0);
    expect(sel.contextAfter).toBe(' — see the appendix.\nVerdict: Recommend ');
    const got = resolveAnchorOffset(md, ANCHOR, {
      contextBefore: sel.contextBefore,
      contextAfter: sel.contextAfter,
      hintOffset: sel.offset,
    });
    expect(occurrences(md, ANCHOR).indexOf(got!)).toBe(0);
  });

  // it.fails until the defect is fixed (see the linked issue); then drop .fails.
  it.fails('resolveAnchorOffset places occurrence 1 on occurrence 1', () => {
    const md = doc('<!-- vale off -->');
    const sel = selectOccurrence(md, ANCHOR, 0);
    // The DOM context is identical to the control: the comment is hidden.
    expect(sel).toMatchObject({
      text: ANCHOR,
      contextBefore: 'Verdict: ',
      contextAfter: ' — see the appendix.\nVerdict: Recommend ',
      offset: 9,
    });
    const got = resolveAnchorOffset(md, ANCHOR, {
      contextBefore: sel.contextBefore,
      contextAfter: sel.contextAfter,
      hintOffset: sel.offset,
    });
    // occurrences: [11, 76, 115]. Actual: 115, occurrence 3.
    expect(occurrences(md, ANCHOR).indexOf(got!)).toBe(0);
  });

  it.fails('insertComment writes the marker beside occurrence 1', () => {
    const md = doc('<!-- vale off -->');
    const sel = selectOccurrence(md, ANCHOR, 0);
    const out = insertComment(
      md,
      sel.text,
      'why?',
      'User',
      sel.contextBefore,
      sel.contextAfter,
      sel.offset,
      'c1',
    );
    const { comments, cleanMarkdown } = parseComments(out);
    expect(cleanMarkdown).toBe(md);
    const lines = out.split('\n\n');
    // The marker should be in the first paragraph, not the third.
    expect(lines[0]).toContain('"id":"c1"');
    expect(comments).toHaveLength(1);
  });
});
