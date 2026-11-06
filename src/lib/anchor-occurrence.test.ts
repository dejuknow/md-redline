// @vitest-environment jsdom

/**
 * A repeated anchor next to an HTML comment the rendered view hides (#206).
 *
 * The inputs come from the real selection path, not hand-written: the document
 * is rendered with the given settings, an occurrence is selected in the DOM,
 * and resolveSelection supplies text, contextBefore, contextAfter and offset
 * (the hintOffset). The same settings go to the anchor search, as the UI
 * passes them.
 *
 * Mechanism: a hidden HTML comment (`<!-- vale off -->`) is dropped from the
 * DOM but kept by stripInlineFormatting. Next to occurrence 1 it made the
 * plain text diverge from the DOM context at the first character, so
 * pickBestOccurrence's prefix score for occurrence 1's contextAfter was 0, and
 * a later occurrence followed by the same words won. The anchor search now
 * ranks occurrences in the plain text without the comments these settings
 * hide.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  findHiddenHtmlComments,
  renderMarkdown,
  type HtmlCommentVisibility,
} from '../markdown/pipeline';
import { DEFAULT_HIDDEN_COMMENT_PREFIXES } from './settings';
import { resolveSelection } from './selection-resolver';
import {
  canPlaceAnchor,
  insertComment,
  parseComments,
  resolveAnchorOffset,
} from './comment-parser';

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

/** The settings useComments passes by default. */
const DEFAULTS: HtmlCommentVisibility = {
  renderHtmlComments: true,
  hiddenCommentPrefixes: DEFAULT_HIDDEN_COMMENT_PREFIXES,
};

/** The source ranges of the comments the rendered view hides, as the UI passes them. */
const hidden = (md: string, visibility: HtmlCommentVisibility = DEFAULTS) =>
  findHiddenHtmlComments(md, visibility);

/** Selects the k-th rendered occurrence of `anchor` and returns what the UI would send. */
function selectOccurrence(
  md: string,
  anchor: string,
  k: number,
  visibility: HtmlCommentVisibility = DEFAULTS,
) {
  const container = document.createElement('div');
  container.innerHTML = renderMarkdown(md, undefined, {
    renderHtmlComments: visibility.renderHtmlComments,
    hiddenCommentPrefixes: [...visibility.hiddenCommentPrefixes],
  });
  document.body.appendChild(container);
  const hits = [...container.querySelectorAll('strong')].filter((el) => el.textContent === anchor);
  expect(hits.length).toBeGreaterThan(k);
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
      hiddenRanges: hidden(md),
    });
    expect(occurrences(md, ANCHOR).indexOf(got!)).toBe(0);
  });

  it('resolveAnchorOffset places occurrence 1 on occurrence 1', () => {
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
      hiddenRanges: hidden(md),
    });
    // occurrences: [11, 76, 115]. Without the settings: 115, occurrence 3.
    expect(occurrences(md, ANCHOR).indexOf(got!)).toBe(0);
  });

  it('insertComment writes the marker beside occurrence 1', () => {
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
      { hiddenRanges: hidden(md) },
    );
    const { comments, cleanMarkdown } = parseComments(out);
    expect(cleanMarkdown).toBe(md);
    const lines = out.split('\n\n');
    // The marker should be in the first paragraph, not the third.
    expect(lines[0]).toContain('"id":"c1"');
    expect(comments).toHaveLength(1);
  });

  /** Selects occurrence k and returns the occurrence the anchor search picks. */
  const resolvesTo = (md: string, k: number, visibility: HtmlCommentVisibility = DEFAULTS) => {
    const sel = selectOccurrence(md, ANCHOR, k, visibility);
    const got = resolveAnchorOffset(md, ANCHOR, {
      contextBefore: sel.contextBefore,
      contextAfter: sel.contextAfter,
      hintOffset: sel.offset,
      hiddenRanges: hidden(md, visibility),
    });
    return occurrences(md, ANCHOR).indexOf(got!);
  };

  it('a hidden comment before the anchor does not move it', () => {
    // The selected occurrence is last, so its contextAfter stops at the end of
    // the document and only contextBefore tells it from occurrence 2.
    const md =
      'Verdict: **Recommend yes** — cheaper.\n\n' +
      'Verdict: **Recommend yes** — see the appendix.\n\n' +
      'Verdict:<!-- vale off --> **Recommend yes** — see the appendix.\n';
    expect(resolvesTo(md, 2)).toBe(2);
  });

  it('an ordinary comment does not move it with Render HTML comments off', () => {
    const off = { ...DEFAULTS, renderHtmlComments: false };
    expect(resolvesTo(doc('<!-- todo: check -->'), 0, off)).toBe(0);
  });

  it('a comment hidden by a custom prefix does not move it', () => {
    const custom = { renderHtmlComments: true, hiddenCommentPrefixes: ['house-style'] };
    expect(resolvesTo(doc('<!-- house-style: skip -->'), 0, custom)).toBe(0);
  });

  it('a rendered comment still resolves to occurrence 1', () => {
    expect(resolvesTo(doc('<!-- todo: check -->'), 0)).toBe(0);
  });

  it('selecting occurrence 3 still resolves to occurrence 3', () => {
    expect(resolvesTo(doc('<!-- vale off -->'), 2)).toBe(2);
  });

  it('a rendered comment beside another occurrence does not pull the selection to it', () => {
    expect(resolvesTo(doc('<!-- todo: check -->'), 2)).toBe(2);
  });

  it('a rendered and a hidden comment together keep occurrence 2 on occurrence 2', () => {
    // Removing every comment would make occurrence 3 match occurrence 2's
    // context better than occurrence 2 itself, whose rendered `todo` stays.
    const md =
      'Verdict: **Recommend yes** — appendix.\n\n' +
      'Verdict: **Recommend yes**<!-- todo --><!-- vale off --> — appendix.\n\n' +
      'Verdict: **Recommend yes**<!-- todo --> — appendix.\n';
    expect(resolvesTo(md, 1)).toBe(1);
  });

  it('a hidden then a rendered comment keep occurrence 1 on occurrence 1', () => {
    const md =
      'Verdict: **Recommend yes**<!-- vale off --><!-- todo --> — appendix.\n\n' +
      'Verdict: **Recommend yes**<!-- todo --> — appendix.\n';
    expect(resolvesTo(md, 0)).toBe(0);
  });

  it('a rendered comment still tells occurrences apart after a long hidden one', () => {
    // The hidden directive shifts plain offsets past the DOM hint, so a false
    // tie between the two occurrences would go to occurrence 1.
    const md =
      `<!-- vale ${'x'.repeat(100)} -->\n\n` +
      'Prefix repeated words to fill forty chars: **Recommend yes**<!-- todo --> — appendix.\n\n' +
      'Prefix repeated words to fill forty chars: **Recommend yes** — appendix.\n';
    expect(resolvesTo(md, 1)).toBe(1);
  });

  it('a `<!--` in a code span is not a comment running to the next `-->`', () => {
    // Read as a comment, the code span's `<!--` would run to `vale off`'s
    // `-->` and hide occurrence 1 along with it. Occurrences 1 and 3 have the
    // same contextBefore, so only the contextAfter without `vale off` tells
    // them apart.
    const md =
      'Use `<!--` to open a comment.\n\n' +
      'Verdict: **Recommend yes**<!-- vale off --> — see the appendix.\n\n' +
      'Verdict: **Recommend yes** — cheaper.\n\n' +
      'Use `<!--` to open a comment.\n\n' +
      'Verdict: **Recommend yes** — see the appendix.\n';
    expect(resolvesTo(md, 0)).toBe(0);
  });

  it('an escaped comment is text, not a hidden comment', () => {
    // `\<!--` renders literally, so the DOM context keeps `<!-- vale off -->`
    // and so must the text it is compared against.
    expect(resolvesTo(doc('\\<!-- vale off -->'), 0)).toBe(0);
  });

  it('a lone `<!--` in prose is text, not a comment running to the next `-->`', () => {
    // Read as a comment, the lone `<!--` would run to `vale off`'s `-->` and
    // swallow it, leaving `vale off` in the text. Occurrences 1 and 3 have the
    // same contextBefore, so only the contextAfter without it tells them apart.
    const filler = 'A filler sentence longer than the forty characters of context.\n\n';
    const md =
      'Type <!-- to start a note.\n\n' +
      filler +
      'Verdict: **Recommend yes**<!-- vale off --> — see the appendix.\n\n' +
      'Verdict: **Recommend yes** — cheaper.\n\n' +
      filler +
      'Verdict: **Recommend yes** — see the appendix.\n';
    expect(resolvesTo(md, 0)).toBe(0);
  });

  it('a hidden comment that spans lines does not move it', () => {
    const md = doc('<!-- vale\n off -->');
    expect(resolvesTo(md, 0)).toBe(0);
    expect(resolvesTo(md.replace(/\n/g, '\r\n'), 0)).toBe(0);
  });

  it('a hidden comment that spans lines in a blockquote does not move it', () => {
    const md =
      '> Verdict: **Recommend yes**<!-- vale\n> off --> — see the appendix.\n\n' +
      '> Verdict: **Recommend yes** — cheaper.\n\n' +
      '> Verdict: **Recommend yes** — see the appendix.\n';
    expect(resolvesTo(md, 0)).toBe(0);
  });

  it('`<!-->` is an empty comment, hidden like any other', () => {
    expect(resolvesTo(doc('<!-->'), 0)).toBe(0);
    expect(resolvesTo(doc('<!--->'), 0)).toBe(0);
  });

  it('a selection across a hidden comment is refused, not placed on another occurrence', () => {
    const md =
      'Verdict: **Recommend<!-- vale off --> yes** — selected.\n\n' +
      'Verdict: **Recommend yes** — other.\n';
    const sel = selectOccurrence(md, ANCHOR, 0);
    expect(sel.text).toBe(ANCHOR);
    expect(canPlaceAnchor(md, sel, hidden(md))).toBe(false);
    const out = insertComment(
      md,
      sel.text,
      'why?',
      'User',
      sel.contextBefore,
      sel.contextAfter,
      sel.offset,
      'c1',
      { hiddenRanges: hidden(md) },
    );
    expect(out).toBe(md);
    // The other occurrence still takes one. occurrences() only sees the
    // unbroken `**Recommend yes**`, so it is index 0 there.
    expect(resolvesTo(md, 1)).toBe(0);
  });

  it('literal text right after a hidden comment resolves to itself, not to the comment', () => {
    const md = 'Text: <!-- vale off -->`<!--` and this is a long unique continuation.\n';
    const container = document.createElement('div');
    container.innerHTML = renderMarkdown(md, undefined, {
      renderHtmlComments: true,
      hiddenCommentPrefixes: DEFAULT_HIDDEN_COMMENT_PREFIXES,
    });
    document.body.appendChild(container);
    const code = container.querySelector('code')!;
    expect(code.textContent).toBe('<!--');
    const range = document.createRange();
    range.selectNodeContents(code.firstChild!);
    vi.spyOn(window, 'getSelection').mockReturnValue({
      isCollapsed: false,
      rangeCount: 1,
      getRangeAt: () => range,
      toString: () => range.toString(),
    } as unknown as Selection);
    const sel = resolveSelection(container)!;
    const got = resolveAnchorOffset(md, sel.text, {
      contextBefore: sel.contextBefore,
      contextAfter: sel.contextAfter,
      hintOffset: sel.offset,
      hiddenRanges: hidden(md),
    });
    expect(got).toBe(md.indexOf('`<!--`') + 1);
  });

  it('comment-like text inside a <textarea> is text, not a hidden comment', () => {
    // The renderer shows it, so the selection inside it is a real occurrence.
    const md = '<textarea><!-- vale Recommend yes --></textarea>\n\n**Recommend yes**\n';
    for (const renderHtmlComments of [true, false]) {
      const visibility = { ...DEFAULTS, renderHtmlComments };
      expect(hidden(md, visibility)).toEqual([]);
      const container = document.createElement('div');
      container.innerHTML = renderMarkdown(md, undefined, {
        renderHtmlComments,
        hiddenCommentPrefixes: DEFAULT_HIDDEN_COMMENT_PREFIXES,
      });
      document.body.replaceChildren(container);
      // The sanitizer drops the <textarea> and keeps its text, bare.
      const textNode = container.firstChild!;
      expect(textNode.nodeType).toBe(Node.TEXT_NODE);
      expect(textNode.textContent).toContain('<!-- vale Recommend yes -->');
      const range = document.createRange();
      const from = textNode.textContent!.indexOf(ANCHOR);
      range.setStart(textNode, from);
      range.setEnd(textNode, from + ANCHOR.length);
      vi.spyOn(window, 'getSelection').mockReturnValue({
        isCollapsed: false,
        rangeCount: 1,
        getRangeAt: () => range,
        toString: () => range.toString(),
      } as unknown as Selection);
      const sel = resolveSelection(container)!;
      const got = resolveAnchorOffset(md, sel.text, {
        contextBefore: sel.contextBefore,
        contextAfter: sel.contextAfter,
        hintOffset: sel.offset,
        hiddenRanges: hidden(md, visibility),
      });
      expect(got).toBe(md.indexOf(ANCHOR));
    }
  });

  it('hidden comments the HTML parser moves out of a table come back in source order', () => {
    // The parser hoists the <div> out of the <table>, so the tree holds
    // comment b before comment a.
    const md = '<table><!-- a --><div><!-- b --></div></table>\n\n**target**\n\n**target**\n';
    const off = { ...DEFAULTS, renderHtmlComments: false };
    const ranges = hidden(md, off);
    expect(ranges.map((r) => md.slice(r.start, r.end))).toEqual(['<!-- a -->', '<!-- b -->']);
    const container = document.createElement('div');
    container.innerHTML = renderMarkdown(md, undefined, {
      renderHtmlComments: false,
      hiddenCommentPrefixes: DEFAULT_HIDDEN_COMMENT_PREFIXES,
    });
    document.body.appendChild(container);
    const first = [...container.querySelectorAll('strong')][0];
    const range = document.createRange();
    range.selectNodeContents(first.firstChild!);
    vi.spyOn(window, 'getSelection').mockReturnValue({
      isCollapsed: false,
      rangeCount: 1,
      getRangeAt: () => range,
      toString: () => range.toString(),
    } as unknown as Selection);
    const sel = resolveSelection(container)!;
    const out = insertComment(
      md,
      sel.text,
      'why?',
      'User',
      sel.contextBefore,
      sel.contextAfter,
      sel.offset,
      'c1',
      { hiddenRanges: ranges },
    );
    expect(out.indexOf('"id":"c1"')).toBeLessThan(out.lastIndexOf('**target**'));
    expect(parseComments(out).comments[0].cleanOffset).toBe(md.indexOf('**target**') + 2);
  });

  it('ranges out of order are ignored rather than misread', () => {
    const md = doc('<!-- vale off -->');
    const sel = selectOccurrence(md, ANCHOR, 2);
    const [a] = hidden(md);
    const got = resolveAnchorOffset(md, ANCHOR, {
      contextBefore: sel.contextBefore,
      contextAfter: sel.contextAfter,
      hintOffset: sel.offset,
      hiddenRanges: [a, { start: 0, end: 4 }],
    });
    expect(occurrences(md, ANCHOR).indexOf(got!)).toBe(2);
  });

  it('without comments, the settings change no choice', () => {
    const md = doc('');
    for (const k of [0, 1, 2]) {
      const sel = selectOccurrence(md, ANCHOR, k);
      const opts = {
        contextBefore: sel.contextBefore,
        contextAfter: sel.contextAfter,
        hintOffset: sel.offset,
      };
      expect(resolveAnchorOffset(md, ANCHOR, { ...opts, hiddenRanges: hidden(md) })).toBe(
        resolveAnchorOffset(md, ANCHOR, opts),
      );
    }
  });
});
