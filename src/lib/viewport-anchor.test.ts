// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  matchViewportAnchor,
  viewportAnchorKey,
  viewportAnchorOrdinal,
  viewportAnchorScrollTop,
} from './viewport-anchor';

describe('viewportAnchorKey', () => {
  it('keys on tag name, text length, and a text prefix', () => {
    const h1 = document.createElement('h1');
    h1.textContent = 'Introduction';
    expect(viewportAnchorKey(h1)).toBe('H1:12:Introduction');
  });

  it('does not collide a heading and a paragraph with identical text', () => {
    // tableScrollKey has no need for this (only tables are keyed), but a
    // viewport anchor can land on any block type, and a heading commonly
    // repeats a nearby paragraph's opening words.
    const h2 = document.createElement('h2');
    h2.textContent = 'Same text';
    const p = document.createElement('p');
    p.textContent = 'Same text';
    expect(viewportAnchorKey(h2)).not.toBe(viewportAnchorKey(p));
  });

  it('differs when the text differs', () => {
    const p1 = document.createElement('p');
    p1.textContent = 'alpha';
    const p2 = document.createElement('p');
    p2.textContent = 'beta';
    expect(viewportAnchorKey(p1)).not.toBe(viewportAnchorKey(p2));
  });

  /** One top-level block from HTML, as the viewer leaves it in its container. */
  function block(html: string): Element {
    const host = document.createElement('div');
    host.innerHTML = html;
    return host.firstElementChild!;
  }

  it('keys a Mermaid diagram by its source, before and after its SVG renders', () => {
    // The shapes MarkdownViewer gives one diagram: the fence while its SVG is
    // still rendering, then the rendered block, whose SVG text carries an id
    // minted per render, then the same diagram rendered again.
    const fence = block('<pre><code class="language-mermaid">graph TD\n  A --> B\n</code></pre>');
    const rendered = (id: number) =>
      block(
        `<div class="mermaid-block"><div class="mermaid-svg"><svg id="mermaid-svg-${id}"><style>#mermaid-svg-${id} .node{fill:red}</style><text>A</text><text>B</text></svg></div>` +
          '<button class="mermaid-block-expand" data-mermaid-source="graph TD\n  A --> B"></button></div>',
      );
    const failed = block(
      '<div class="mermaid-block mermaid-error" data-mermaid-source="graph TD\n  A --> B">Mermaid error: boom</div>',
    );

    const key = viewportAnchorKey(fence);
    expect(key).toBe(viewportAnchorKey(rendered(1)));
    expect(key).toBe(viewportAnchorKey(rendered(2)));
    expect(key).toBe(viewportAnchorKey(failed));
    // Still told apart from a different diagram, and from an ordinary code
    // block holding the same text.
    expect(key).not.toBe(
      viewportAnchorKey(block('<pre><code class="language-mermaid">graph LR</code></pre>')),
    );
    expect(key).not.toBe(viewportAnchorKey(block('<pre><code>graph TD\n  A --> B\n</code></pre>')));
  });
});

describe('viewportAnchorOrdinal', () => {
  it('counts the earlier blocks with the same key', () => {
    expect(viewportAnchorOrdinal(['dup', 'a', 'dup', 'dup'], 0)).toBe(0);
    expect(viewportAnchorOrdinal(['dup', 'a', 'dup', 'dup'], 3)).toBe(2);
  });
});

describe('matchViewportAnchor', () => {
  it('returns the index of the matching current key', () => {
    expect(matchViewportAnchor('b', 0, ['a', 'b', 'c'])).toBe(1);
  });

  it('returns undefined when the anchored content is gone', () => {
    // Correct behavior for a deleted/rewritten anchor is to leave the
    // reader where they are, not to guess at a replacement.
    expect(matchViewportAnchor('z', 0, ['a', 'b', 'c'])).toBeUndefined();
  });

  it('matches the same copy of a duplicated key', () => {
    expect(matchViewportAnchor('dup', 0, ['a', 'dup', 'b', 'dup'])).toBe(1);
    expect(matchViewportAnchor('dup', 1, ['a', 'dup', 'b', 'dup'])).toBe(3);
  });

  it('returns undefined when that copy no longer exists', () => {
    expect(matchViewportAnchor('dup', 1, ['a', 'dup'])).toBeUndefined();
  });
});

describe('viewportAnchorScrollTop', () => {
  /**
   * A scroller at scrollTop 1000 holding one block whose top is 200px above
   * the viewport and which is `height` tall now.
   */
  function layout(height: number) {
    const scroller = document.createElement('div');
    scroller.scrollTop = 1000;
    scroller.getBoundingClientRect = () => ({ top: 0, bottom: 500 }) as DOMRect;
    const blocks = document.createElement('div');
    const p = document.createElement('p');
    p.textContent = 'Anchored';
    p.getBoundingClientRect = () => ({ top: -200, bottom: -200 + height }) as DOMRect;
    blocks.append(p);
    return { scroller, blocks, key: viewportAnchorKey(p) };
  }

  it('puts the block back at its recorded offset', () => {
    const { scroller, blocks, key } = layout(1100);
    // 100px into the block: its top 100px above the viewport.
    expect(viewportAnchorScrollTop(scroller, blocks, { key, ordinal: 0, offset: -100 })).toBe(900);
  });

  it('lands at the end of a block that came back shorter than the offset into it', () => {
    // 800px into what was an 1100px block (a diagram's source), which is now
    // 300px tall (its SVG): the block's end at the viewport top, not 500px
    // past it.
    const { scroller, blocks, key } = layout(300);
    expect(viewportAnchorScrollTop(scroller, blocks, { key, ordinal: 0, offset: -800 })).toBe(1100);
  });
});
