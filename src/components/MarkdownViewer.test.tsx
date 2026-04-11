// @vitest-environment jsdom

import { render, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MarkdownViewer, isInsideSvgTextContent } from './MarkdownViewer';
import { renderMarkdown } from '../markdown/pipeline';

describe('isInsideSvgTextContent', () => {
  const SVG_NS = 'http://www.w3.org/2000/svg';

  it('returns true for text nodes inside an SVG <text> element', () => {
    const svg = document.createElementNS(SVG_NS, 'svg');
    const textEl = document.createElementNS(SVG_NS, 'text');
    const tn = document.createTextNode('POST /auth/login');
    textEl.appendChild(tn);
    svg.appendChild(textEl);
    document.body.appendChild(svg);
    expect(isInsideSvgTextContent(tn)).toBe(true);
    svg.remove();
  });

  it('returns true for text nodes inside an SVG <tspan>', () => {
    const svg = document.createElementNS(SVG_NS, 'svg');
    const textEl = document.createElementNS(SVG_NS, 'text');
    const tspan = document.createElementNS(SVG_NS, 'tspan');
    const tn = document.createTextNode('auth');
    tspan.appendChild(tn);
    textEl.appendChild(tspan);
    svg.appendChild(textEl);
    document.body.appendChild(svg);
    expect(isInsideSvgTextContent(tn)).toBe(true);
    svg.remove();
  });

  it('returns false for HTML text nodes inside an SVG <foreignObject>', () => {
    const svg = document.createElementNS(SVG_NS, 'svg');
    const fo = document.createElementNS(SVG_NS, 'foreignObject');
    const div = document.createElement('div');
    const span = document.createElement('span');
    span.className = 'nodeLabel';
    const tn = document.createTextNode('auth');
    span.appendChild(tn);
    div.appendChild(span);
    fo.appendChild(div);
    svg.appendChild(fo);
    document.body.appendChild(svg);
    expect(isInsideSvgTextContent(tn)).toBe(false);
    svg.remove();
  });

  it('returns false for plain HTML text nodes', () => {
    const p = document.createElement('p');
    const tn = document.createTextNode('auth in prose');
    p.appendChild(tn);
    document.body.appendChild(p);
    expect(isInsideSvgTextContent(tn)).toBe(false);
    p.remove();
  });
});

describe('MarkdownViewer selection highlights', () => {
  it('does not leave behind an empty inline code element when selection starts with inline code', async () => {
    const markdown =
      '# PRD: md-redline\n\n## Summary\n\n`md-redline` is a local-first markdown review app built for workflows where humans and AI agents collaborate directly through `.md` files.';

    const html = renderMarkdown(markdown);

    const { container } = render(
      <MarkdownViewer
        html={html}
        cleanMarkdown={markdown}
        comments={[]}
        activeCommentId={null}
        selectionText={'md-redline is a local-first markdown review app built'}
        selectionOffset={null}
        onHighlightClick={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(container.querySelector('mark.selection-highlight')).not.toBeNull();
    });

    const paragraph = Array.from(container.querySelectorAll('.prose p')).find((el) =>
      el.textContent?.includes('local-first markdown review app'),
    );

    expect(paragraph).not.toBeNull();
    expect(paragraph?.innerHTML).not.toContain('<code></code>');

    const leadingCode = paragraph?.querySelector('mark.selection-highlight > code');
    expect(leadingCode?.textContent).toBe('md-redline');
  });
});
