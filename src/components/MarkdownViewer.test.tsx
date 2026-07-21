// @vitest-environment jsdom

import { render, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MarkdownViewer, isInsideSvgTextContent, computeTableOverflow } from './MarkdownViewer';
import { renderMarkdown } from '../markdown/pipeline';

describe('computeTableOverflow', () => {
  it('reports no overflow when content fits, with 1px slack for rounding', () => {
    expect(computeTableOverflow(500, 500, 0)).toEqual({
      overflowing: false,
      overflowStart: false,
      overflowEnd: false,
    });
    // max === 1 is within slack (not > 1), so still not overflowing.
    expect(computeTableOverflow(501, 500, 0)).toEqual({
      overflowing: false,
      overflowStart: false,
      overflowEnd: false,
    });
  });

  it('fades only the end edge when scrolled to the far left', () => {
    // scrollWidth 800, clientWidth 500 → max 300; scrollLeft 0.
    expect(computeTableOverflow(800, 500, 0)).toEqual({
      overflowing: true,
      overflowStart: false,
      overflowEnd: true,
    });
  });

  it('fades only the start edge when scrolled to the far right', () => {
    expect(computeTableOverflow(800, 500, 300)).toEqual({
      overflowing: true,
      overflowStart: true,
      overflowEnd: false,
    });
  });

  it('fades both edges when scrolled to the middle', () => {
    expect(computeTableOverflow(800, 500, 150)).toEqual({
      overflowing: true,
      overflowStart: true,
      overflowEnd: true,
    });
  });
});

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

describe('MarkdownViewer comment highlights — markdown-formatted anchor fallback', () => {
  it('highlights a comment anchor that uses markdown bold formatting', async () => {
    // The agent wrote the anchor as "**Hello world**" but the DOM renders it as
    // plain text "Hello world" inside a <strong> element. wrapText must strip
    // the markdown formatting and still find the match.
    const markdown = '# Doc\n\n**Hello world** is the greeting.\n';
    const html = renderMarkdown(markdown);

    const comment = {
      id: 'cmt_bold',
      anchor: '**Hello world**',
      text: 'Nice greeting',
      author: 'Claude',
      timestamp: new Date().toISOString(),
      cleanOffset: 0,
    };

    const { container } = render(
      <MarkdownViewer
        html={html}
        cleanMarkdown={markdown}
        comments={[comment]}
        activeCommentId={null}
        selectionText={null}
        selectionOffset={null}
        onHighlightClick={vi.fn()}
      />,
    );

    await waitFor(() => {
      const mark = container.querySelector('mark.comment-highlight');
      expect(mark).not.toBeNull();
      expect(mark?.textContent).toBe('Hello world');
    });
  });
});

describe('MarkdownViewer comment highlights — mermaid-node anchor fallback', () => {
  it('highlights a Mermaid label even when the anchor includes markdown formatting inside the brackets', async () => {
    // Covers the deepest fallback branch in findMatchRange: Mermaid node
    // syntax where the inner label itself carries markdown markup the SVG
    // strips out (e.g. "E[**Important** Step]" renders as "Important Step").
    const markdown = [
      '# Doc',
      '',
      '```mermaid',
      'flowchart LR',
      '  E[Important Step]',
      '  F[Done]',
      '  E --> F',
      '```',
    ].join('\n');
    const html = renderMarkdown(markdown);

    const comment = {
      id: 'cmt_mermaid_stripped',
      anchor: 'E[**Important** Step]',
      text: 'Drop the emphasis',
      author: 'Claude',
      timestamp: new Date().toISOString(),
      cleanOffset: 0,
    };

    const { container } = render(
      <MarkdownViewer
        html={html}
        cleanMarkdown={markdown}
        comments={[comment]}
        activeCommentId={null}
        selectionText={null}
        selectionOffset={null}
        onHighlightClick={vi.fn()}
      />,
    );

    await waitFor(() => {
      const htmlMark = container.querySelector(
        'mark.comment-highlight, mark.comment-highlight-sent',
      );
      const svgMark = container.querySelector('.mermaid-comment-highlight');
      expect(htmlMark ?? svgMark).not.toBeNull();
    });
  });

  it('highlights a comment anchor written in Mermaid node syntax by extracting the inner label', async () => {
    // The agent wrote the anchor as "E[Clicks Discover Pages]" (Mermaid source syntax).
    // The rendered SVG only contains the inner label text; wrapText must extract it
    // and still place a highlight.
    const markdown = [
      '# Doc',
      '',
      '```mermaid',
      'flowchart LR',
      '  E[Clicks Discover Pages]',
      '  F[Loads results]',
      '  E --> F',
      '```',
    ].join('\n');
    const html = renderMarkdown(markdown);

    const comment = {
      id: 'cmt_mermaid',
      anchor: 'E[Clicks Discover Pages]',
      text: 'Label is too long',
      author: 'Claude',
      timestamp: new Date().toISOString(),
      cleanOffset: 0,
    };

    const { container } = render(
      <MarkdownViewer
        html={html}
        cleanMarkdown={markdown}
        comments={[comment]}
        activeCommentId={null}
        selectionText={null}
        selectionOffset={null}
        onHighlightClick={vi.fn()}
      />,
    );

    await waitFor(() => {
      // The mark may land on either an HTML <mark> (foreignObject) or a mermaid SVG
      // text element. Either way, the rendered label text must appear highlighted.
      const htmlMark = container.querySelector(
        'mark.comment-highlight, mark.comment-highlight-sent',
      );
      const svgMark = container.querySelector('.mermaid-comment-highlight');
      // At least one highlight form must be present.
      expect(htmlMark ?? svgMark).not.toBeNull();
      if (htmlMark) {
        expect(htmlMark.textContent).toContain('Clicks Discover Pages');
      }
    });
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
