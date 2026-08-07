// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

const fetchPreferences = vi.fn();
const savePreferencesToDisk = vi.fn();
vi.mock('../lib/preferences-client', () => ({
  fetchPreferences: (...args: unknown[]) => fetchPreferences(...args),
  savePreferencesToDisk: (...args: unknown[]) => savePreferencesToDisk(...args),
}));

vi.mock('next-themes', () => ({
  useTheme: () => ({ theme: 'system', setTheme: vi.fn() }),
}));

import { SettingsProvider } from '../contexts/SettingsContext';
import { CommentListSurface } from './CommentListSurface';
import type { MdComment } from '../types';

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const OPEN_COMMENT: MdComment = {
  id: 'still-open',
  anchor: 'first anchor',
  text: 'This one still needs a decision',
  author: 'Dennis',
  timestamp: '2026-08-07T12:00:00.000Z',
};

const RESOLVED_COMMENT: MdComment = {
  id: 'settled',
  anchor: 'second anchor',
  text: 'This one was already settled',
  author: 'Dennis',
  timestamp: '2026-08-07T12:00:00.000Z',
  status: 'resolved',
};

function renderSurface(props: Partial<React.ComponentProps<typeof CommentListSurface>> = {}) {
  const defaults: React.ComponentProps<typeof CommentListSurface> = {
    comments: [OPEN_COMMENT, RESOLVED_COMMENT],
    activeCommentId: null,
    missingAnchors: new Set<string>(),
    onActivate: vi.fn(),
    onDelete: vi.fn(),
    onEdit: vi.fn(),
    onReply: vi.fn(),
    onEditReply: vi.fn(),
    onDeleteReply: vi.fn(),
    onBulkDelete: vi.fn(),
  };
  return render(
    <SettingsProvider>
      <CommentListSurface {...defaults} {...props} />
    </SettingsProvider>,
  );
}

/** Put the list on the Resolved filter, which hides the open comment. */
async function selectResolvedFilter() {
  const tab = await screen.findByRole('button', { name: /^Resolved/ });
  fireEvent.click(tab);
  await waitFor(() => expect(screen.queryByText(OPEN_COMMENT.text)).toBeNull());
}

beforeEach(() => {
  fetchPreferences.mockReset();
  fetchPreferences.mockResolvedValue({ settings: { enableResolve: true } });
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('focus request for a comment that no longer exists', () => {
  // A file-watcher reload or an agent rewrite can delete the requested
  // comment between the request and this effect (`comments` is a dep, so the
  // effect re-runs on the new list). Defaulting the missing comment's status
  // to 'open' widened the filter for a card that was never going to appear,
  // pulling the reviewer off Resolved and then stranding the request: the
  // re-run finds no node and returns without calling onFocusHandled.
  it('leaves the filter alone instead of widening toward a guess', async () => {
    const onFocusHandled = vi.fn();
    const { rerender } = renderSurface({ onFocusHandled });
    await selectResolvedFilter();

    rerender(
      <SettingsProvider>
        <CommentListSurface
          comments={[RESOLVED_COMMENT]}
          activeCommentId={null}
          missingAnchors={new Set<string>()}
          onActivate={vi.fn()}
          onDelete={vi.fn()}
          onEdit={vi.fn()}
          onReply={vi.fn()}
          onEditReply={vi.fn()}
          onDeleteReply={vi.fn()}
          onBulkDelete={vi.fn()}
          onFocusHandled={onFocusHandled}
          requestedFocus={{ commentId: 'deleted-out-from-under-us', token: 1 }}
        />
      </SettingsProvider>,
    );

    // Still on Resolved: the settled card shows, and nothing widened.
    await waitFor(() => expect(screen.getByText(RESOLVED_COMMENT.text)).toBeTruthy());
    expect(screen.queryByText(OPEN_COMMENT.text)).toBeNull();
  });

  // The guard above must not cost the real case its widen.
  it('still widens toward a comment that does exist', async () => {
    const { rerender } = renderSurface();
    await selectResolvedFilter();

    rerender(
      <SettingsProvider>
        <CommentListSurface
          comments={[OPEN_COMMENT, RESOLVED_COMMENT]}
          activeCommentId={null}
          missingAnchors={new Set<string>()}
          onActivate={vi.fn()}
          onDelete={vi.fn()}
          onEdit={vi.fn()}
          onReply={vi.fn()}
          onEditReply={vi.fn()}
          onDeleteReply={vi.fn()}
          onBulkDelete={vi.fn()}
          requestedFocus={{ commentId: OPEN_COMMENT.id, token: 1 }}
        />
      </SettingsProvider>,
    );

    await waitFor(() => expect(screen.getByText(OPEN_COMMENT.text)).toBeTruthy());
  });
});

describe('focus request against an active search', () => {
  // Every highlight click and density tick routes a focus request through
  // this effect now, so an unconditional setSearch('') threw away a
  // reviewer's search on a click that was already showing them the card.
  it('keeps a search that is not hiding the requested card', async () => {
    const { rerender } = renderSurface();
    const box = await screen.findByPlaceholderText('Search');
    fireEvent.change(box, { target: { value: 'still needs' } });
    await waitFor(() => expect(screen.queryByText(RESOLVED_COMMENT.text)).toBeNull());

    rerender(
      <SettingsProvider>
        <CommentListSurface
          comments={[OPEN_COMMENT, RESOLVED_COMMENT]}
          activeCommentId={null}
          missingAnchors={new Set<string>()}
          onActivate={vi.fn()}
          onDelete={vi.fn()}
          onEdit={vi.fn()}
          onReply={vi.fn()}
          onEditReply={vi.fn()}
          onDeleteReply={vi.fn()}
          onBulkDelete={vi.fn()}
          requestedFocus={{ commentId: OPEN_COMMENT.id, token: 1 }}
        />
      </SettingsProvider>,
    );

    await waitFor(() =>
      expect((screen.getByPlaceholderText('Search') as HTMLInputElement).value).toBe('still needs'),
    );
  });

  it('clears a search that is hiding the requested card', async () => {
    const { rerender } = renderSurface();
    const box = await screen.findByPlaceholderText('Search');
    fireEvent.change(box, { target: { value: 'still needs' } });
    await waitFor(() => expect(screen.queryByText(RESOLVED_COMMENT.text)).toBeNull());

    rerender(
      <SettingsProvider>
        <CommentListSurface
          comments={[OPEN_COMMENT, RESOLVED_COMMENT]}
          activeCommentId={null}
          missingAnchors={new Set<string>()}
          onActivate={vi.fn()}
          onDelete={vi.fn()}
          onEdit={vi.fn()}
          onReply={vi.fn()}
          onEditReply={vi.fn()}
          onDeleteReply={vi.fn()}
          onBulkDelete={vi.fn()}
          requestedFocus={{ commentId: RESOLVED_COMMENT.id, token: 1 }}
        />
      </SettingsProvider>,
    );

    await waitFor(() =>
      expect((screen.getByPlaceholderText('Search') as HTMLInputElement).value).toBe(''),
    );
  });
});
