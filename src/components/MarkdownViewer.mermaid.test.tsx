// @vitest-environment jsdom

import { render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MarkdownViewer } from './MarkdownViewer';
import { renderMarkdown } from '../markdown/pipeline';
import type { MdComment } from '../types';

// Mock the mermaid-renderer module so we can return a deterministic SVG
// without booting real mermaid (which jsdom can't lay out anyway).
const mockRenderMermaidBlock = vi.fn();
const mockHasMermaidBlocks = vi.fn();

vi.mock('../lib/mermaid-renderer', () => ({
  getMermaidTheme: () => 'default',
  hasMermaidBlocks: (...args: unknown[]) => mockHasMermaidBlocks(...args),
  renderMermaidBlock: (...args: unknown[]) => mockRenderMermaidBlock(...args),
}));

/** SVG mimicking a mermaid sequence-diagram fragment with an edge label
 *  "POST /auth/login" rendered inside a plain <text> element (no foreignObject). */
const SEQUENCE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 100"><g><text x="10" y="20" class="messageText">POST /auth/login</text></g></svg>`;

const SEQUENCE_MARKDOWN = `# Authentication Flow

\`\`\`mermaid
sequenceDiagram
    participant C as Client
    participant S as Server
    C->>S: POST /auth/login
\`\`\`
`;

/** SVG mimicking a mermaid flowchart node, whose label is real HTML inside a
 *  foreignObject, which is the case that DOES get an HTML <mark>. */
const FLOWCHART_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 100"><g><foreignObject width="200" height="40"><div xmlns="http://www.w3.org/1999/xhtml" class="label"><span class="nodeLabel">Validate token</span></div></foreignObject></g></svg>`;

const FLOWCHART_MARKDOWN = `# Token Flow

\`\`\`mermaid
flowchart TD
    A[Validate token] --> B[Done]
\`\`\`
`;

function baseProps() {
  return {
    html: renderMarkdown(SEQUENCE_MARKDOWN),
    cleanMarkdown: SEQUENCE_MARKDOWN,
    comments: [] as MdComment[],
    activeCommentId: null as string | null,
    selectionText: null as string | null,
    selectionOffset: null as number | null,
    onHighlightClick: vi.fn(),
  };
}

async function waitForMermaidText(container: HTMLElement) {
  await waitFor(() => {
    const text = container.querySelector('.mermaid-block svg text');
    if (!text) throw new Error('mermaid text not rendered yet');
  });
  return container.querySelector('.mermaid-block svg text')!;
}

describe('MarkdownViewer: mermaid sequence-diagram comment highlights', () => {
  beforeEach(() => {
    mockHasMermaidBlocks.mockReset();
    mockRenderMermaidBlock.mockReset();
    mockHasMermaidBlocks.mockReturnValue(true);
    mockRenderMermaidBlock.mockResolvedValue({ svg: SEQUENCE_SVG });
  });

  it('does not wrap the SVG <text> content in an HTML <mark> (regression: text used to disappear)', async () => {
    // Historical bug: wrapText inserted an HTML <mark> inside an SVG <text>
    // element, which SVG cannot render — the wrapped characters became
    // invisible. Fix: wrapText detects SVG text ancestors and redirects
    // the highlight to a sibling decoration instead of mutating the text.
    const comment: MdComment = {
      id: 'c-auth',
      anchor: 'auth',
      text: 'test',
      author: 'Test',
      timestamp: '2026-04-11T00:00:00.000Z',
      contextBefore: 'POST /',
      contextAfter: '/login',
    };

    const { container } = render(<MarkdownViewer {...baseProps()} comments={[comment]} />);
    const svgText = await waitForMermaidText(container);

    // The SVG <text>'s visible content is unchanged.
    expect(svgText.textContent).toBe('POST /auth/login');

    // Crucially: there is NO HTML <mark> living inside the SVG <text>.
    // If wrapText ever regresses and injects one, this assertion fails.
    expect(svgText.querySelector('mark')).toBeNull();

    // The <text> element itself carries the highlight class + comment IDs.
    expect(svgText.classList.contains('mermaid-comment-highlight')).toBe(true);
    expect((svgText as SVGElement).dataset.commentIds).toBe('c-auth');
  });

  it('adds the active class when activeCommentId matches the SVG text comment', async () => {
    const comment: MdComment = {
      id: 'c-auth',
      anchor: 'auth',
      text: 'test',
      author: 'Test',
      timestamp: '2026-04-11T00:00:00.000Z',
      contextBefore: 'POST /',
      contextAfter: '/login',
    };

    const { container } = render(
      <MarkdownViewer {...baseProps()} comments={[comment]} activeCommentId="c-auth" />,
    );
    const svgText = await waitForMermaidText(container);

    expect(svgText.classList.contains('mermaid-comment-highlight-active')).toBe(true);
  });

  it('does not add highlight class to text when no comment anchor matches', async () => {
    const { container } = render(<MarkdownViewer {...baseProps()} />);
    const svgText = await waitForMermaidText(container);
    expect(svgText.classList.contains('mermaid-comment-highlight')).toBe(false);
    expect(svgText.querySelector('mark')).toBeNull();
  });

  it('routes selection highlight through the SVG text decoration path without mutating text', async () => {
    const { container } = render(
      <MarkdownViewer {...baseProps()} selectionText="auth" selectionOffset={null} />,
    );
    const svgText = await waitForMermaidText(container);

    // Still no HTML <mark> inside the SVG text.
    expect(svgText.querySelector('mark')).toBeNull();
    expect(svgText.textContent).toBe('POST /auth/login');
  });

  it('leaves a resolved anchor unpainted on an SVG <text> label', async () => {
    // A trace in a diagram would have to be a rect drawn over the label, which
    // is not faint by any reading. Diagrams keep the pre-trace behaviour.
    const comment: MdComment = {
      id: 'c-auth',
      anchor: 'auth',
      text: 'settled',
      author: 'Test',
      timestamp: '2026-04-11T00:00:00.000Z',
      status: 'resolved',
      contextBefore: 'POST /',
      contextAfter: '/login',
    };

    const { container } = render(
      <MarkdownViewer {...baseProps()} comments={[comment]} enableResolve />,
    );
    const svgText = await waitForMermaidText(container);

    expect(svgText.classList.contains('mermaid-comment-highlight')).toBe(false);
    expect((svgText as SVGElement).dataset.commentIds).toBeUndefined();
  });
});

describe('MarkdownViewer: mermaid flowchart foreignObject labels', () => {
  beforeEach(() => {
    mockHasMermaidBlocks.mockReset();
    mockRenderMermaidBlock.mockReset();
    mockHasMermaidBlocks.mockReturnValue(true);
    mockRenderMermaidBlock.mockResolvedValue({ svg: FLOWCHART_SVG });
  });

  function flowchartProps() {
    return {
      ...baseProps(),
      html: renderMarkdown(FLOWCHART_MARKDOWN),
      cleanMarkdown: FLOWCHART_MARKDOWN,
    };
  }

  async function waitForLabel(container: HTMLElement) {
    await waitFor(() => {
      if (!container.querySelector('.mermaid-block foreignObject .nodeLabel')) {
        throw new Error('mermaid label not rendered yet');
      }
    });
    return container.querySelector('.mermaid-block foreignObject .nodeLabel')!;
  }

  it('strips a resolved mark of everything that makes it a click target', async () => {
    // The underline cannot paint here (quirk 2), so a resolved mark left in
    // place is invisible AND still clickable: it opens a popover from blank
    // -looking label text and puts a density tick where there is no trace.
    const comment: MdComment = {
      id: 'c-token',
      anchor: 'Validate token',
      text: 'settled',
      author: 'Test',
      timestamp: '2026-04-11T00:00:00.000Z',
      status: 'resolved',
    };

    const { container } = render(
      <MarkdownViewer {...flowchartProps()} comments={[comment]} enableResolve />,
    );
    await waitForLabel(container);

    await waitFor(() => {
      expect(container.querySelector('.mermaid-block mark.comment-highlight-resolved')).toBeNull();
    });
    expect(
      container.querySelector('.mermaid-block mark.comment-highlight-resolved-active'),
    ).toBeNull();
    // No survivor carries the id list the click and tick paths read.
    for (const el of container.querySelectorAll('.mermaid-block [data-comment-ids]')) {
      expect((el as HTMLElement).dataset.commentIds).toBeUndefined();
    }
  });

  it('still converts an OPEN mark in a foreignObject to the inline-style treatment', async () => {
    // Guards the fix above against over-reach: only the resolved branch is
    // stripped, the open one keeps its id list and gets the mermaid classes.
    const comment: MdComment = {
      id: 'c-token',
      anchor: 'Validate token',
      text: 'live',
      author: 'Test',
      timestamp: '2026-04-11T00:00:00.000Z',
    };

    const { container } = render(
      <MarkdownViewer {...flowchartProps()} comments={[comment]} enableResolve />,
    );
    await waitForLabel(container);

    await waitFor(() => {
      const mark = container.querySelector('.mermaid-block mark.mermaid-comment-highlight');
      expect(mark).not.toBeNull();
      expect((mark as HTMLElement).dataset.commentIds).toBe('c-token');
    });
  });
});
