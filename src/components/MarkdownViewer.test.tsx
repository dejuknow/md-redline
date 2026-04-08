// @vitest-environment jsdom

import { render, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MarkdownViewer } from './MarkdownViewer';
import { renderMarkdown } from '../markdown/pipeline';

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
