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
});
