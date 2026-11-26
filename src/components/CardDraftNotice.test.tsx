// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { createElement } from 'react';
import { CardDraftNotice } from './CardDraftNotice';
import type { SetAsideCardDraft } from '../hooks/useCardDrafts';

afterEach(cleanup);

const aside = (
  key: string,
  mode: 'reply-compose' | 'comment-edit',
  problem: SetAsideCardDraft['problem'],
  text: string,
): SetAsideCardDraft => ({
  key,
  problem,
  draft: { target: { mode, commentId: 'c1' }, text, base: '', caret: [0, 0] },
});

describe('CardDraftNotice', () => {
  it('shows nothing with nothing set aside, but keeps its live region', () => {
    const view = render(
      createElement(CardDraftNotice, { setAside: [], onCopy: vi.fn(), onDiscard: vi.fn() }),
    );
    expect(view.container.querySelector('[data-card-draft-notice]')).toBeNull();
    expect(screen.getByRole('status')).toBeTruthy();
  });

  it('says why the first draft was kept aside, counts the rest, and offers copy and discard', () => {
    const onCopy = vi.fn();
    const onDiscard = vi.fn();
    render(
      createElement(CardDraftNotice, {
        setAside: [
          aside('k1', 'reply-compose', 'comment-gone', 'my reply'),
          aside('k2', 'comment-edit', 'changed', 'my edit'),
        ],
        onCopy,
        onDiscard,
      }),
    );
    expect(screen.getByRole('status').textContent).toContain(
      'An unsent reply was kept aside: the comment it belongs to is no longer in this file.',
    );
    expect(screen.getByRole('status').textContent).toContain('(1 more kept aside)');
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    expect(onCopy).toHaveBeenCalledWith('my reply');
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(onDiscard).toHaveBeenCalledWith('k1');
  });

  it('tells a resolved thread and a changed edit apart', () => {
    const view = render(
      createElement(CardDraftNotice, {
        setAside: [aside('k', 'reply-compose', 'resolved', 'x')],
        onCopy: vi.fn(),
        onDiscard: vi.fn(),
      }),
    );
    expect(screen.getByRole('status').textContent).toContain(
      'its comment was resolved. Reopen the comment to finish it.',
    );
    view.rerender(
      createElement(CardDraftNotice, {
        setAside: [aside('k', 'comment-edit', 'changed', 'x')],
        onCopy: vi.fn(),
        onDiscard: vi.fn(),
      }),
    );
    expect(screen.getByRole('status').textContent).toContain(
      'An unsent edit to a comment was kept aside: the text it edits changed since you started.',
    );
  });
});
