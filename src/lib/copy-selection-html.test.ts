// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { buildRangeHtml } from './copy-selection-html';

function mount(html: string): HTMLElement {
  const container = document.createElement('div');
  container.innerHTML = html;
  document.body.appendChild(container);
  return container;
}

/** Select from the start of the first matching element's text to the end of the last's. */
function rangeAcross(container: HTMLElement, selector: string): Range {
  const els = [...container.querySelectorAll(selector)];
  const first = els[0];
  const last = els[els.length - 1];
  const startText = document.createTreeWalker(first, NodeFilter.SHOW_TEXT).nextNode()!;
  const walker = document.createTreeWalker(last, NodeFilter.SHOW_TEXT);
  let endText: Node = startText;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) endText = n;
  const range = document.createRange();
  range.setStart(startText, 0);
  range.setEnd(endText, (endText.textContent ?? '').length);
  return range;
}

describe('buildRangeHtml', () => {
  it('returns null without a container', () => {
    const container = mount('<p>Plain paragraph</p>');
    expect(buildRangeHtml(rangeAcross(container, 'p'), null)).toBeNull();
  });

  it('returns null for a collapsed range', () => {
    const container = mount('<p>Plain paragraph</p>');
    const range = document.createRange();
    range.setStart(container.querySelector('p')!.firstChild!, 2);
    range.collapse(true);
    expect(buildRangeHtml(range, container)).toBeNull();
  });

  it('keeps inline formatting inside the selection', () => {
    const container = mount('<p>Ship <strong>fast</strong> today</p>');
    const html = buildRangeHtml(rangeAcross(container, 'p'), container) ?? '';
    expect(html).toContain('<strong>fast</strong>');
  });

  it('keeps a wrapper that tightly contains the whole selection', () => {
    const container = mount('<p><a href="https://example.com">the docs</a></p>');
    expect(buildRangeHtml(rangeAcross(container, 'a'), container)).toContain(
      '<a href="https://example.com">the docs</a>',
    );
  });

  it('keeps the heading element when a heading is fully selected', () => {
    const container = mount('<div><h2>Current Strategy</h2></div>');
    expect(buildRangeHtml(rangeAcross(container, 'h2'), container)).toContain(
      '<h2>Current Strategy</h2>',
    );
  });

  it('keeps list structure across items', () => {
    const container = mount('<ul><li>first</li><li>second</li></ul>');
    const html = buildRangeHtml(rangeAcross(container, 'li'), container) ?? '';
    expect(html).toContain('<ul>');
    expect(html).toContain('<li>first</li>');
    expect(html).toContain('<li>second</li>');
  });

  it('re-wraps bare list items when the list itself is outside the range', () => {
    const container = mount('<ul><li>skipped</li><li>second</li><li>third</li></ul>');
    const els = [...container.querySelectorAll('li')].slice(1);
    const range = document.createRange();
    range.setStart(els[0].firstChild!, 0);
    range.setEnd(els[1].firstChild!, els[1].textContent!.length);
    const html = buildRangeHtml(range, container) ?? '';
    expect(html.startsWith('<ul>')).toBe(true);
    expect(html).not.toContain('skipped');
  });

  it('carries ordered-list numbering across when the list itself is outside the range', () => {
    const container = mount('<ol><li>one</li><li>two</li><li>three</li><li>four</li></ol>');
    const els = [...container.querySelectorAll('li')].slice(2);
    const range = document.createRange();
    range.setStart(els[0].firstChild!, 0);
    range.setEnd(els[1].firstChild!, els[1].textContent!.length);
    const html = buildRangeHtml(range, container) ?? '';
    expect(html.startsWith('<ol start="3">')).toBe(true);
    expect(html).not.toContain('one');
  });

  it('honors an existing start attribute on the source list', () => {
    const container = mount('<ol start="5"><li>five</li><li>six</li><li>seven</li></ol>');
    const els = [...container.querySelectorAll('li')].slice(1);
    const range = document.createRange();
    range.setStart(els[0].firstChild!, 0);
    range.setEnd(els[1].firstChild!, els[1].textContent!.length);
    expect(buildRangeHtml(range, container)?.startsWith('<ol start="6">')).toBe(true);
  });

  it('omits the start attribute for an unordered list', () => {
    const container = mount('<ul><li>alpha</li><li>beta</li><li>gamma</li></ul>');
    const els = [...container.querySelectorAll('li')].slice(1);
    const range = document.createRange();
    range.setStart(els[0].firstChild!, 0);
    range.setEnd(els[1].firstChild!, els[1].textContent!.length);
    const html = buildRangeHtml(range, container) ?? '';
    expect(html.startsWith('<ul>')).toBe(true);
    expect(html).not.toContain('start=');
  });

  it('numbers correctly when the selection starts mid-item', () => {
    // Text matching would fail here: the cloned first item holds a partial
    // string, so the offset has to come from the source item structurally.
    const container = mount('<ol><li>one</li><li>two</li><li>three item</li><li>four</li></ol>');
    const items = [...container.querySelectorAll('li')];
    const range = document.createRange();
    range.setStart(items[2].firstChild!, 6); // mid-way into "three item"
    range.setEnd(items[3].firstChild!, items[3].textContent!.length);
    expect(buildRangeHtml(range, container)?.startsWith('<ol start="3">')).toBe(true);
  });

  it('numbers correctly when two items read identically', () => {
    const container = mount('<ol><li>dup</li><li>dup</li><li>tail</li></ol>');
    const items = [...container.querySelectorAll('li')];
    const range = document.createRange();
    range.setStart(items[1].firstChild!, 0);
    range.setEnd(items[2].firstChild!, items[2].textContent!.length);
    expect(buildRangeHtml(range, container)?.startsWith('<ol start="2">')).toBe(true);
  });

  it('keeps a trailing paragraph when the selection runs out of the list', () => {
    const container = mount(
      '<div><ul><li>first</li><li>second</li></ul><p>after the list</p></div>',
    );
    const items = [...container.querySelectorAll('li')];
    const tail = container.querySelector('p')!;
    const range = document.createRange();
    range.setStart(items[1].firstChild!, 0);
    range.setEnd(tail.firstChild!, tail.textContent!.length);
    const html = buildRangeHtml(range, container) ?? '';
    expect(html).toContain('<ul><li>second</li></ul>');
    expect(html).toContain('after the list');
  });

  it('does not re-tag a nested selection with the inner list type', () => {
    const container = mount('<ul><li>alpha<ol><li>x</li><li>y</li></ol></li><li>beta</li></ul>');
    const nested = [...container.querySelectorAll('ol > li')][1];
    const range = document.createRange();
    range.setStart(nested.firstChild!, 0);
    range.setEnd(nested.firstChild!, nested.textContent!.length);
    const html = buildRangeHtml(range, container) ?? '';
    // The outer list keeps its own type; the sublist is numbered from its own
    // items, so "y" pastes as 2 rather than restarting at 1.
    expect(html.startsWith('<ul>')).toBe(true);
    expect(html).toContain('<ol start="2">');
    expect(html).toContain('y');
  });

  it('numbers a nested ordered selection from its own list', () => {
    const container = mount(
      '<ol><li>one<ol><li>n1</li><li>n2</li><li>n3</li></ol></li><li>two</li></ol>',
    );
    const nested = [...container.querySelectorAll('ol ol > li')];
    const range = document.createRange();
    range.setStart(nested[1].firstChild!, 0);
    range.setEnd(nested[2].firstChild!, nested[2].textContent!.length);
    const html = buildRangeHtml(range, container) ?? '';
    // The clone is anchored on the outer item that contains the sublist, so
    // the numbering belongs to the outer list, not a phantom "2." item.
    expect(html).toContain('n2');
    expect(html).toContain('n3');
    expect(html).not.toContain('<li></li>');
  });

  it('does not stamp an outer list with a sublist item index', () => {
    // Selecting from mid-sublist through the end of the section: the clone's
    // top-level list is the OUTER one, so its numbering must come from the
    // outer list's own items, not from "b3 is item 3 of the sublist".
    const container = mount(
      '<div><ol><li>x<ol><li>b1</li><li>b2</li><li>b3</li></ol></li><li>y</li></ol><p>tail</p></div>',
    );
    const b3 = [...container.querySelectorAll('ol ol > li')][2];
    const tail = container.querySelector('p')!;
    const range = document.createRange();
    range.setStart(b3.firstChild!, 0);
    range.setEnd(tail.firstChild!, tail.textContent!.length);
    const html = buildRangeHtml(range, container) ?? '';
    // The outer list starts at its own first item, so it carries no start; the
    // sublist carries the 3 that belongs to it.
    expect(html.startsWith('<ol>')).toBe(true);
    expect(html).toContain('<ol start="3">');
    expect(html).toContain('tail');
  });

  it('numbers a sublist selection that ends flush on its last item', () => {
    // The flush end widens the range past the sublist, lifting the common
    // ancestor above it. The numbering still belongs to the sublist.
    const container = mount('<ul><li>u1<ol><li>n1</li><li>n2</li><li>n3</li></ol></li></ul>');
    const items = [...container.querySelectorAll('ol > li')];
    const range = document.createRange();
    range.setStart(items[1].firstChild!, 0);
    range.setEnd(items[2].firstChild!, items[2].textContent!.length);
    expect(buildRangeHtml(range, container)).toContain('<ol start="2">');
  });

  it('numbers a list wrapped in a blockquote when the selection ends flush', () => {
    const container = mount('<blockquote><ol><li>q1</li><li>q2</li><li>q3</li></ol></blockquote>');
    const items = [...container.querySelectorAll('li')];
    const range = document.createRange();
    range.setStart(items[1].firstChild!, 0);
    range.setEnd(items[2].firstChild!, items[2].textContent!.length);
    expect(buildRangeHtml(range, container)).toContain('<ol start="2">');
  });

  it('leaves the source document untouched', () => {
    const markup = '<ol><li>one</li><li>two</li><li>three</li></ol>';
    const container = mount(markup);
    const items = [...container.querySelectorAll('li')];
    const range = document.createRange();
    range.setStart(items[1].firstChild!, 0);
    range.setEnd(items[2].firstChild!, items[2].textContent!.length);
    buildRangeHtml(range, container);
    expect(container.innerHTML).toBe(markup);
  });

  it('numbers both lists when a selection spans a sublist and its outer list', () => {
    const container = mount(
      '<div><ol><li>x1</li><li>x2</li><li>x3<ol><li>b1</li><li>b2</li></ol></li><li>x4</li></ol><p>tail</p></div>',
    );
    const b2 = [...container.querySelectorAll('ol ol > li')][1];
    const tail = container.querySelector('p')!;
    const range = document.createRange();
    range.setStart(b2.firstChild!, 0);
    range.setEnd(tail.firstChild!, tail.textContent!.length);
    const html = buildRangeHtml(range, container) ?? '';
    // Outer resumes at its own third item, sublist at its own second.
    expect(html.startsWith('<ol start="3">')).toBe(true);
    expect(html).toContain('<ol start="2">');
  });

  it('numbers every level of a deeply nested selection', () => {
    // A two-slot outer/inner model silently drops the middle list here.
    const container = mount(
      '<div><ol><li>a<ol><li>b1</li><li>b2<ol><li>c1</li><li>c2</li><li>c3</li></ol></li></ol></li><li>z</li></ol><p>t</p></div>',
    );
    const c2 = [...container.querySelectorAll('ol ol ol > li')][1];
    const tail = container.querySelector('p')!;
    const range = document.createRange();
    range.setStart(c2.firstChild!, 0);
    range.setEnd(tail.firstChild!, tail.textContent!.length);
    const html = buildRangeHtml(range, container) ?? '';
    // Outer starts at its first item (no attribute), middle resumes at 2, and
    // the innermost resumes at 2.
    expect(html.startsWith('<ol><li>')).toBe(true);
    expect(html.match(/<ol start="2">/g)?.length).toBe(2);
  });

  it('numbers four levels of nesting', () => {
    const container = mount(
      '<ol><li>L1a</li><li>L1b<ol><li>L2a</li><li>L2b<ol><li>L3a</li><li>L3b<ol><li>L4a</li><li>L4b</li></ol></li></ol></li></ol></li></ol>',
    );
    const deepest = [...container.querySelectorAll('ol ol ol ol > li')][1];
    const range = document.createRange();
    range.setStart(deepest.firstChild!, 0);
    range.setEnd(deepest.firstChild!, deepest.textContent!.length);
    const html = buildRangeHtml(range, container) ?? '';
    expect(html.match(/<ol start="2">/g)?.length).toBe(4);
  });

  it('drops the mermaid fullscreen button the viewer injects', () => {
    const container = mount(
      '<div class="mermaid-block"><p>Diagram</p><button class="mermaid-block-expand" data-mermaid-source="graph TD">open</button></div>',
    );
    const range = document.createRange();
    range.selectNodeContents(container.querySelector('.mermaid-block')!);
    const html = buildRangeHtml(range, container) ?? '';
    expect(html).not.toContain('mermaid-block-expand');
    expect(html).toContain('Diagram');
  });

  it('returns null instead of throwing when serialization fails', () => {
    // This runs inside resolveSelection on every mouseup: a throw here would
    // leave the app with no selection at all and the previous one stranded.
    const container = mount('<ol><li>one</li><li>two</li></ol>');
    const items = [...container.querySelectorAll('li')];
    const real = document.createRange();
    real.setStart(items[0].firstChild!, 0);
    real.setEnd(items[1].firstChild!, items[1].textContent!.length);

    const hostile = new Proxy(real, {
      get(target, prop, receiver) {
        if (prop === 'cloneRange') return () => hostile;
        if (prop === 'cloneContents') {
          return () => {
            throw new Error('serialization blew up');
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as Range;

    expect(() => buildRangeHtml(hostile, container)).not.toThrow();
    expect(buildRangeHtml(hostile, container)).toBeNull();
    // The transient tag must not survive the failure either.
    expect(container.querySelector('[data-mdr-copy-list]')).toBeNull();
  });

  it('unwraps the table scroll wrappers the pipeline injects', () => {
    const container = mount(
      '<div class="table-scroll"><div class="table-scroll__viewport"><table><tbody><tr><td>alpha</td></tr></tbody></table></div></div><p>after</p>',
    );
    const cell = container.querySelector('td')!;
    const tail = container.querySelector('p')!;
    const range = document.createRange();
    range.setStart(cell.firstChild!, 0);
    range.setEnd(tail.firstChild!, tail.textContent!.length);
    const html = buildRangeHtml(range, container) ?? '';
    expect(html).not.toContain('table-scroll');
    expect(html.startsWith('<table>')).toBe(true);
    expect(html).toContain('after');
  });

  it('unwraps the frontmatter box the pipeline injects', () => {
    // Same class of wrapper as the table scroll containers: a presentation box
    // around document text. A selection crossing out of it reconstructs the
    // div via cloneContents and would paste an app class into someone else's
    // document.
    const container = mount(
      '<div class="doc-frontmatter"><span class="doc-frontmatter__key">title</span>: Spec</div><p>after</p>',
    );
    const field = container.querySelector('.doc-frontmatter')!;
    const tail = container.querySelector('p')!;
    const range = document.createRange();
    range.setStart(field.lastChild!, 0);
    range.setEnd(tail.firstChild!, tail.textContent!.length);
    const html = buildRangeHtml(range, container) ?? '';
    expect(html).not.toContain('doc-frontmatter');
    expect(html).toContain('after');
  });

  it('keeps table structure', () => {
    const container = mount(
      '<table><tbody><tr><td>Autonomous</td><td>EasyMate</td></tr></tbody></table>',
    );
    const html = buildRangeHtml(rangeAcross(container, 'td'), container) ?? '';
    expect(html).toContain('<td>Autonomous</td>');
    expect(html).toContain('<td>EasyMate</td>');
  });

  it('rebuilds the table around a partial table selection', () => {
    // Stray <tr>/<td> at a fragment's top level are dropped by the HTML
    // fragment parser and their text foster-parented, so the paste would lose
    // the table entirely.
    const container = mount(
      '<table><thead><tr><th>h1</th><th>h2</th></tr></thead><tbody><tr><td>alpha</td><td>beta</td></tr><tr><td>gamma</td><td>delta</td></tr></tbody></table>',
    );
    const cells = [...container.querySelectorAll('td')];
    const range = document.createRange();
    range.setStart(cells[0].firstChild!, 2);
    range.setEnd(cells[2].firstChild!, 3);
    const html = buildRangeHtml(range, container) ?? '';
    expect(html.startsWith('<table>')).toBe(true);
    expect(html).toContain('<tbody>');
    expect(html).toContain('<td>beta</td>');
  });

  it('rebuilds the table around a whole-row selection', () => {
    const container = mount(
      '<table><tbody><tr><td>alpha</td><td>beta</td></tr><tr><td>gamma</td><td>delta</td></tr></tbody></table>',
    );
    const row = container.querySelector('tr')!;
    const range = document.createRange();
    range.selectNodeContents(row);
    const html = buildRangeHtml(range, container) ?? '';
    expect(html.startsWith('<table>')).toBe(true);
    expect(html).toContain('<td>alpha</td>');
  });

  it('clears an inherited start when the selection begins at item one', () => {
    // `0.` is valid CommonMark and the pipeline emits <ol start="0">.
    const container = mount('<ol start="0"><li>z</li><li>a</li><li>b</li></ol>');
    const items = [...container.querySelectorAll('li')];
    const range = document.createRange();
    range.setStart(items[1].firstChild!, 0);
    range.setEnd(items[2].firstChild!, items[2].textContent!.length);
    const html = buildRangeHtml(range, container) ?? '';
    // Items "a" and "b" are 1 and 2 in a list numbered from 0, which is the
    // default numbering, so the inherited start="0" must be cleared entirely.
    expect(html.startsWith('<ol>')).toBe(true);
    expect(html).not.toContain('start=');
  });

  it('copies a value out of one cell as text, not a one-cell table', () => {
    const container = mount('<table><tbody><tr><td>30s</td><td>other</td></tr></tbody></table>');
    const cell = container.querySelector('td')!;
    const range = document.createRange();
    range.selectNodeContents(cell);
    const html = buildRangeHtml(range, container) ?? '';
    expect(html).toBe('30s');
  });

  it('copies a partial cell value as text', () => {
    const container = mount('<table><tbody><tr><td>30s</td><td>other</td></tr></tbody></table>');
    const cell = container.querySelector('td')!;
    const range = document.createRange();
    range.setStart(cell.firstChild!, 0);
    range.setEnd(cell.firstChild!, 2);
    const html = buildRangeHtml(range, container) ?? '';
    expect(html).toBe('30');
  });

  it('keeps a header cell selection as text', () => {
    const container = mount('<table><thead><tr><th>Value</th><th>Unit</th></tr></thead></table>');
    const cell = container.querySelector('th')!;
    const range = document.createRange();
    range.selectNodeContents(cell);
    expect(buildRangeHtml(range, container)).toBe('Value');
  });

  it('still rebuilds when two cells are selected', () => {
    const container = mount('<table><tbody><tr><td>alpha</td><td>beta</td></tr></tbody></table>');
    const cells = [...container.querySelectorAll('td')];
    const range = document.createRange();
    range.setStart(cells[0].firstChild!, 0);
    range.setEnd(cells[1].firstChild!, cells[1].textContent!.length);
    const html = buildRangeHtml(range, container) ?? '';
    expect(html.startsWith('<table>')).toBe(true);
    expect(html).toContain('<td>alpha</td>');
  });

  it('unwraps the app highlight marks', () => {
    const container = mount(
      '<p><mark class="comment-highlight">flagged</mark> and <mark class="search-highlight">found</mark></p>',
    );
    const html = buildRangeHtml(rangeAcross(container, 'p'), container) ?? '';
    expect(html).not.toContain('<mark');
    expect(html).toContain('flagged');
    expect(html).toContain('found');
  });

  it('unwraps the resolved trace marks too', () => {
    // A resolved anchor is still app chrome, not document content: copying a
    // settled passage has to paste the prose, not a <mark> carrying the trace.
    const container = mount(
      '<p><mark class="comment-highlight-resolved">settled</mark> and <mark class="comment-highlight-resolved comment-highlight-resolved-active">current</mark></p>',
    );
    const html = buildRangeHtml(rangeAcross(container, 'p'), container) ?? '';
    expect(html).not.toContain('<mark');
    expect(html).toContain('settled');
    expect(html).toContain('current');
  });

  it('strips viewer chrome that overlaps the selection', () => {
    const container = mount('<p>kept<span data-drag-handle>handle</span> also kept</p>');
    const html = buildRangeHtml(rangeAcross(container, 'p'), container) ?? '';
    expect(html).not.toContain('data-drag-handle');
    expect(html).toContain('kept');
  });

  it('spans block boundaries', () => {
    const container = mount('<div><p>opening line</p><p>closing line</p></div>');
    const html = buildRangeHtml(rangeAcross(container, 'p'), container) ?? '';
    expect(html).toContain('<p>opening line</p>');
    expect(html).toContain('closing line');
  });

  it('does not widen past a partially selected boundary', () => {
    const container = mount('<p>keep this <em>drop that</em></p>');
    const em = container.querySelector('em')!;
    const range = document.createRange();
    range.setStart(container.querySelector('p')!.firstChild!, 0);
    range.setEnd(em.firstChild!, 4);
    const html = buildRangeHtml(range, container) ?? '';
    expect(html).toContain('keep this');
    expect(html).not.toContain('that');
  });
});
