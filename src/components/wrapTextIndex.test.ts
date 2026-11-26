// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import { createWrapTextIndex, wrapText } from './MarkdownViewer';
import { renderMarkdown } from '../markdown/pipeline';
import { sanitizeRenderedMarkdown } from '../lib/sanitize-html';
import { getVisibleTextContent } from '../lib/visible-text';

// The comment highlight pass shares one WrapTextIndex across its wrapText
// calls. The index is only a shortcut: every call must leave exactly the DOM,
// and report exactly the result, that the same call makes without it.

const MARKDOWN = `# Garden notes

Tomatoes need **steady water** and *warm soil*. Check the \`soil probe\` each morning,
then check it again at dusk. Peppers like the same bed.

- Water the **tomato
  bed** first
- Then the pepper bed, then the basil
  - Basil wants light water

| Plant | Spacing | Water |
| --- | --- | --- |
| Tomato | 60cm | daily |
| Pepper | 45cm | daily |

> Rotate crops yearly so the beds stay healthy. Compost in autumn.

\`\`\`js
const bed = { rows: 4, cols: 8 };
\`\`\`

Tomatoes need steady water. Tomatoes need steady water, again.

<span> </span>Raw inline <em></em>html at the top <strong>level</strong> here.

Final paragraph with ~~struck text~~ and a [link to the plan](https://example.com).
`;

const HAND_HTML =
  'Loose top-level text before a block.<p>First <strong>bold <em>nested</em></strong> run.</p>' +
  '<span>inline at the top</span><span>  </span>' +
  '<ul><li>one <code>chip text</code> two</li><li>three</li></ul>' +
  '<svg><defs>hidden defs</defs><text>visible label</text></svg>' +
  '<p>Repeat repeat repeat repeat.</p>Trailing top-level text.';

/** A small deterministic PRNG so every run checks the same anchors. */
function prng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

interface Call {
  text: string;
  hint?: number;
  before?: string;
  after?: string;
}

function callsFor(fullText: string, seed: number, count: number): Call[] {
  const rand = prng(seed);
  const calls: Call[] = [];
  for (let i = 0; i < count; i++) {
    const start = Math.floor(rand() * Math.max(1, fullText.length - 3));
    const len = 2 + Math.floor(rand() * 60);
    const text = fullText.slice(start, start + len);
    if (!text.trim()) continue;
    const mode = Math.floor(rand() * 4);
    calls.push({
      text,
      hint: mode === 0 ? undefined : start + Math.floor(rand() * 10) - 5,
      before: mode === 2 ? fullText.slice(Math.max(0, start - 20), start) : undefined,
      after: mode === 3 ? fullText.slice(start + len, start + len + 20) : undefined,
    });
  }
  // A miss, which must leave both copies alone.
  calls.push({ text: 'text that appears nowhere in the document' });
  return calls;
}

function fresh(html: string): HTMLElement {
  const el = document.createElement('div');
  el.innerHTML = html;
  document.body.appendChild(el);
  return el;
}

/** Returns how many calls ran on a built index, so a test can tell it was used. */
function expectSameAsUnindexed(html: string, seed: number, count: number): number {
  let indexedCalls = 0;
  const plain = fresh(html);
  const fast = fresh(html);
  const index = createWrapTextIndex(fast);
  const calls = callsFor(getVisibleTextContent(plain), seed, count);
  calls.forEach((call, i) => {
    const configure = (mark: HTMLElement) => {
      mark.className = 'comment-highlight';
      mark.dataset.commentIds = `c${i}`;
    };
    const a = wrapText(plain, call.text, configure, call.hint, call.before, call.after);
    if (index.segments) indexedCalls++;
    const b = wrapText(
      fast,
      call.text,
      configure,
      call.hint,
      call.before,
      call.after,
      undefined,
      false,
      index,
    );
    expect(b, `call ${i}: ${JSON.stringify(call.text)}`).toBe(a);
    expect(fast.innerHTML, `call ${i}: ${JSON.stringify(call.text)}`).toBe(plain.innerHTML);
  });
  plain.remove();
  fast.remove();
  return indexedCalls;
}

describe('wrapText with a shared index', () => {
  it('paints a rendered document exactly as the full walk does', () => {
    const html = sanitizeRenderedMarkdown(renderMarkdown(MARKDOWN, '/tmp/notes.md'));
    for (const seed of [1, 2, 3, 4, 5]) {
      // Most calls take the indexed path; the rest fell back after a wrap
      // changed what the index records.
      expect(expectSameAsUnindexed(html, seed, 80)).toBeGreaterThan(40);
    }
  });

  it('matches the full walk where wraps change the top level or drop whitespace', () => {
    for (const seed of [11, 12, 13, 14, 15, 16]) expectSameAsUnindexed(HAND_HTML, seed, 60);
  });

  it('notices a wrap across top-level text that moves an empty node into its mark', () => {
    // The first wrap, inside the paragraph, builds the index. The second runs
    // across two top-level text runs: the <img> (or <br>, or comment) between
    // them moves into the new mark, so the container keeps its child count
    // while both runs change length. The third lands in the second run.
    for (const html of [
      '<p>First paragraph here.</p>\nHello <img src="x.png" alt=""> world, and more after it.',
      '<p>First paragraph here.</p>Start here<br>then the second line<!-- note --> and the third.',
    ]) {
      const plain = fresh(html);
      const fast = fresh(html);
      const index = createWrapTextIndex(fast);
      const text = getVisibleTextContent(plain);
      const tail = text.slice('First paragraph here.'.length);
      const anchors = ['paragraph', tail.slice(3, tail.length - 12), tail.slice(-10, -4)];
      anchors.forEach((anchor, i) => {
        const configure = (mark: HTMLElement) => {
          mark.dataset.commentIds = `c${i}`;
        };
        const a = wrapText(plain, anchor, configure);
        const b = wrapText(
          fast,
          anchor,
          configure,
          undefined,
          undefined,
          undefined,
          undefined,
          false,
          index,
        );
        expect(b, `anchor ${JSON.stringify(anchor)}`).toBe(a);
        expect(fast.innerHTML, `anchor ${JSON.stringify(anchor)}`).toBe(plain.innerHTML);
      });
      plain.remove();
      fast.remove();
    }
  });

  it('paints overlapping and repeated anchors the same way', () => {
    const html = sanitizeRenderedMarkdown(renderMarkdown(MARKDOWN, '/tmp/notes.md'));
    const plain = fresh(html);
    const fast = fresh(html);
    const index = createWrapTextIndex(fast);
    const anchors = [
      'steady water',
      'Tomatoes need steady water',
      'need steady',
      'steady water',
      'tomato\nbed',
      'Pepper | 45cm',
      'chip',
      'soil probe each morning',
    ];
    anchors.forEach((text, i) => {
      const configure = (mark: HTMLElement) => {
        mark.dataset.commentIds = `c${i}`;
      };
      const a = wrapText(plain, text, configure);
      const b = wrapText(
        fast,
        text,
        configure,
        undefined,
        undefined,
        undefined,
        undefined,
        false,
        index,
      );
      expect(b).toBe(a);
      expect(fast.innerHTML).toBe(plain.innerHTML);
    });
  });

  it('builds the index on the first wrap and reuses it after', () => {
    const container = fresh(sanitizeRenderedMarkdown(renderMarkdown(MARKDOWN, '/tmp/notes.md')));
    const index = createWrapTextIndex(container);
    expect(index.segments).toBeNull();
    wrapText(
      container,
      'warm soil',
      () => {},
      undefined,
      undefined,
      undefined,
      undefined,
      false,
      index,
    );
    expect(index.segments).not.toBeNull();
    expect(index.fullText).toBe(getVisibleTextContent(container));
    wrapText(
      container,
      'basil',
      () => {},
      undefined,
      undefined,
      undefined,
      undefined,
      false,
      index,
    );
    expect(index.segments).not.toBeNull();
    expect(index.fullText).toBe(getVisibleTextContent(container));
    container.remove();
  });

  it('is ignored for another container', () => {
    const a = fresh('<p>alpha beta</p>');
    const b = fresh('<p>gamma delta</p>');
    const index = createWrapTextIndex(a);
    expect(
      wrapText(b, 'delta', () => {}, undefined, undefined, undefined, undefined, false, index),
    ).toBe(true);
    expect(b.querySelector('mark')?.textContent).toBe('delta');
    a.remove();
    b.remove();
  });
});
