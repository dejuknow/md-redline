// @vitest-environment jsdom

import { describe, it, expect, beforeEach } from 'vitest';
import { rangeFromPaintedSelection, resolveSelectionMarkdown } from './copy-as-markdown';

beforeEach(() => {
  document.body.innerHTML = '';
});

/** Render-shaped HTML: blocks carry the span the pipeline annotates them with. */
function mount(html: string): HTMLElement {
  document.body.innerHTML = `<div id="prose">${html}</div>`;
  return document.getElementById('prose')!;
}

describe('resolveSelectionMarkdown', () => {
  const source =
    'The migration runs in **three phases**, starting now.\n\nSecond paragraph here.\n';

  it('slices the file itself when the selection covers a whole block', () => {
    const container = mount(
      '<p data-src-start="0" data-src-end="52">The migration runs in <strong>three phases</strong>, starting now.</p>',
    );
    const p = container.querySelector('p')!;
    const range = document.createRange();
    range.selectNodeContents(p);

    const result = resolveSelectionMarkdown(range, container, source);
    expect(result).not.toBeNull();
    expect(result!.exact).toBe(true);
    // Byte-identical to the document, delimiters and all.
    expect(result!.markdown).toBe(source.slice(0, 52));
  });

  it('rebuilds from the fragment when the selection is ragged', () => {
    const container = mount(
      '<p data-src-start="0" data-src-end="52">The migration runs in <strong>three phases</strong>, starting now.</p>',
    );
    const strong = container.querySelector('strong')!;
    const text = container.querySelector('p')!.lastChild!;
    const range = document.createRange();
    range.setStart(strong.firstChild!, 6); // mid-way through "three phases"
    range.setEnd(text, 10); // ', starting'

    const result = resolveSelectionMarkdown(range, container, source);
    expect(result).not.toBeNull();
    expect(result!.exact).toBe(false);
    // Exactly what was highlighted, with its formatting, and nothing more.
    expect(result!.markdown).toBe('**phases**, starting');
  });

  it('slices both blocks when the selection spans two of them exactly', () => {
    const container = mount(
      '<p data-src-start="0" data-src-end="52">First</p>' +
        '<p data-src-start="54" data-src-end="77">Second paragraph here.</p>',
    );
    const [first, second] = Array.from(container.querySelectorAll('p'));
    const range = document.createRange();
    range.setStart(first.firstChild!, 0);
    range.setEnd(second.firstChild!, second.textContent!.length);

    const result = resolveSelectionMarkdown(range, container, source);
    expect(result!.exact).toBe(true);
    expect(result!.markdown).toBe(source.slice(0, 77));
  });

  it('refuses to slice when the blocks are out of source order', () => {
    // GFM footnotes render their definitions at the end of the document
    // whatever their position in the file, so DOM order and source order come
    // apart. Slicing from the first block's start to the last one's end would
    // hand back a stretch of the file the reader never highlighted, and drop
    // one they did.
    const footnoted = 'Para A.\n\n[^1]: Note text.\n\nPara B with ref[^1].\n';
    const container = mount(
      '<p data-src-start="0" data-src-end="7">Para A.</p>' +
        '<p data-src-start="27" data-src-end="47">Para B with ref.</p>' +
        '<li data-src-start="9" data-src-end="25">Note text.</li>',
    );
    const first = container.querySelector('p')!;
    const footnote = container.querySelector('li')!;
    const range = document.createRange();
    range.setStart(first.firstChild!, 0);
    range.setEnd(footnote.firstChild!, footnote.textContent!.length);

    const result = resolveSelectionMarkdown(range, container, footnoted);
    expect(result).not.toBeNull();
    expect(result!.exact).toBe(false);
    expect(result!.markdown).not.toBe(footnoted.slice(0, 25));
    // Whatever it hands back is built from what was on screen, so the body
    // paragraph the reader highlighted is in it.
    expect(result!.markdown).toContain('Para B with ref');
  });

  it('returns null for a collapsed selection', () => {
    const container = mount('<p data-src-start="0" data-src-end="52">Text</p>');
    const range = document.createRange();
    range.setStart(container.querySelector('p')!.firstChild!, 2);
    range.collapse(true);
    expect(resolveSelectionMarkdown(range, container, source)).toBeNull();
  });

  it('rebuilds when a block carries no span, rather than giving up', () => {
    // Frontmatter, mermaid and blocks inside a blockquote are deliberately
    // unannotated; they still have to copy as something.
    const container = mount('<div class="doc-frontmatter">title: x</div>');
    const div = container.querySelector('div')!;
    const range = document.createRange();
    range.selectNodeContents(div);

    const result = resolveSelectionMarkdown(range, container, source);
    expect(result).not.toBeNull();
    expect(result!.exact).toBe(false);
    expect(result!.markdown).toContain('title: x');
  });
});

describe('rangeFromPaintedSelection', () => {
  it('spans from the first painted mark to the last', () => {
    const container = mount(
      '<p data-src-start="0" data-src-end="52">The <mark class="selection-highlight">migration</mark> runs ' +
        '<mark class="selection-highlight">here</mark> now.</p>',
    );
    const range = rangeFromPaintedSelection(container)!;
    expect(range.toString()).toBe('migration runs here');
  });

  it('returns null when nothing is painted', () => {
    expect(rangeFromPaintedSelection(mount('<p>Nothing selected</p>'))).toBeNull();
  });
});
