// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { RefObject } from 'react';

const fetchPreferences = vi.fn();
const savePreferencesToDisk = vi.fn();
vi.mock('../lib/preferences-client', () => ({
  fetchPreferences: (...args: unknown[]) => fetchPreferences(...args),
  savePreferencesToDisk: (...args: unknown[]) => savePreferencesToDisk(...args),
}));

import { SettingsProvider } from '../contexts/SettingsContext';
import { CommentsRail, RailDensityControl } from './CommentsRail';
import type { MarginLayout } from '../hooks/useMarginLayout';
import type { MdComment } from '../types';

const comments: MdComment[] = [
  {
    id: 'c1',
    anchor: 'first anchor',
    text: 'First comment',
    author: 'Dennis',
    timestamp: new Date().toISOString(),
  },
  {
    id: 'c2',
    anchor: 'gone anchor',
    text: 'Orphaned comment',
    author: 'Dennis',
    timestamp: new Date().toISOString(),
    replies: [{ id: 'r1', text: 'A reply', author: 'Dennis', timestamp: new Date().toISOString() }],
  },
];

function layout(overrides: Partial<MarginLayout> = {}): MarginLayout {
  return {
    active: true,
    tops: new Map([
      ['c1', 100],
      ['c2', 0],
    ]),
    anchorTops: new Map([['c1', 100]]),
    // Both measured by default: the hidden-until-placed path is exercised by
    // its own cases rather than silently applying to every other test here.
    measuredIds: new Set(['c1', 'c2']),
    orphanIds: ['c2'],
    registerCardRef: vi.fn(),
    layerHeight: 400,
    ...overrides,
  };
}

// No real DOM element behind the ref: the List-density viewport-measuring
// effect no-ops when scrollRef.current is null. CommentCard itself still
// observes its text node for clamp re-checks, so a ResizeObserver stub is
// installed below (jsdom doesn't implement one).
const nullScrollRef = { current: null } as RefObject<HTMLElement | null>;

// jsdom has no ResizeObserver; CommentCard (rendered by CommentsRail's cards)
// observes its text node to re-check clamping on resize.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function renderRail(props: Partial<React.ComponentProps<typeof CommentsRail>> = {}) {
  const defaults: React.ComponentProps<typeof CommentsRail> = {
    density: 'anchored',
    scrollRef: nullScrollRef,
    layout: layout(),
    anchoredComments: comments,
    allComments: comments,
    activeCommentId: null,
    missingAnchors: new Set(['c2']),
    sentCommentIds: [],
    onActivate: vi.fn(),
    onReply: vi.fn(),
    onDelete: vi.fn(),
    onEdit: vi.fn(),
    onEditReply: vi.fn(),
    onDeleteReply: vi.fn(),
    onBulkDelete: vi.fn(),
  };
  return {
    props: { ...defaults, ...props },
    ...render(
      <SettingsProvider>
        <CommentsRail {...defaults} {...props} />
      </SettingsProvider>,
    ),
  };
}

beforeEach(() => {
  fetchPreferences.mockReset();
  fetchPreferences.mockResolvedValue({ settings: {} });
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('CommentsRail - a card is hidden until its height is measured', () => {
  // An unmeasured card is positioned against useMarginLayout's 120px estimate,
  // which is shorter than a real card, so it lands on top of its neighbour and
  // then slides clear once the ResizeObserver fires. Showing it during that
  // pass is what made a second agent comment appear to shove the first one.
  function cardEl(container: HTMLElement, id: string) {
    return container.querySelector<HTMLElement>(`[data-margin-card-id="${id}"]`);
  }

  it('hides a card that has no measured height yet', () => {
    const { container } = renderRail({
      layout: layout({ measuredIds: new Set(['c2']) }),
    });
    expect(cardEl(container, 'c1')?.style.visibility).toBe('hidden');
  });

  it('hides a measured card whose anchor has not painted yet', () => {
    // The case that shipped three broken fixes: height arrives from the
    // ResizeObserver before the highlight mark paints, so the card is measured
    // but unanchored, and resolveCollisions has stacked it from 0.
    const { container } = renderRail({
      layout: layout({
        measuredIds: new Set(['c1', 'c2']),
        anchorTops: new Map(),
      }),
      missingAnchors: new Set<string>(),
    });
    expect(cardEl(container, 'c1')?.style.visibility).toBe('hidden');
  });

  it('shows a genuine orphan straight away, without waiting on paint', () => {
    // detectMissingAnchors reads the document text, so a comment whose anchor
    // is really gone is known immediately and must not be held back.
    const { container } = renderRail({
      layout: layout({ measuredIds: new Set(['c1', 'c2']), anchorTops: new Map() }),
      missingAnchors: new Set(['c1']),
    });
    expect(cardEl(container, 'c1')?.style.visibility).toBe('');
  });

  it('shows it once measured', () => {
    const { container } = renderRail({
      layout: layout({ measuredIds: new Set(['c1', 'c2']) }),
    });
    expect(cardEl(container, 'c1')?.style.visibility).toBe('');
  });

  it('withholds the position transition while unmeasured, so the correction does not animate', () => {
    // margin-note-pos carries `transition: top 150ms`. Applied before the
    // corrected top arrives, it turns a silent reposition into a visible slide.
    const { container } = renderRail({
      layout: layout({ measuredIds: new Set(['c2']) }),
    });
    expect(cardEl(container, 'c1')?.className).not.toContain('margin-note-pos');
    expect(cardEl(container, 'c1')?.className).not.toContain('margin-note-enter');
  });

  it('applies both once placed, so the fade plays where the card lands', () => {
    const { container } = renderRail({
      layout: layout({ measuredIds: new Set(['c1', 'c2']) }),
    });
    expect(cardEl(container, 'c1')?.className).toContain('margin-note-pos');
    expect(cardEl(container, 'c1')?.className).toContain('margin-note-enter');
  });
});

describe('RailDensityControl', () => {
  const renderControl = (overrides: Partial<Parameters<typeof RailDensityControl>[0]> = {}) =>
    render(
      <RailDensityControl
        density="anchored"
        onDensityChange={vi.fn()}
        openCount={3}
        resolvedCount={0}
        totalCount={3}
        resolveEnabled
        onJumpPrev={vi.fn()}
        onJumpNext={vi.fn()}
        onBulkResolve={vi.fn()}
        onBulkDeleteResolved={vi.fn()}
        onBulkDelete={vi.fn()}
        {...overrides}
      />,
    );

  it('renders both density options, the open count, and switches on click', () => {
    const onDensityChange = vi.fn();
    renderControl({ onDensityChange });
    expect(screen.getByRole('button', { name: 'Anchored' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'List' })).toBeTruthy();
    expect(screen.getByText('3 open')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'List' }));
    expect(onDensityChange).toHaveBeenCalledWith('list');
  });

  it('density buttons carry a visible keyboard focus ring', () => {
    renderControl({ openCount: 2 });
    const anchored = screen.getByRole('button', { name: 'Anchored' });
    expect(anchored.className).toContain('focus-visible:ring-2');
    expect(anchored.className).toContain('focus-visible:ring-inset');
  });

  it('prev/next buttons jump between comments and disable when there are none', () => {
    const onJumpPrev = vi.fn();
    const onJumpNext = vi.fn();
    const { rerender } = renderControl({ onJumpPrev, onJumpNext });
    fireEvent.click(screen.getByRole('button', { name: 'Previous comment' }));
    fireEvent.click(screen.getByRole('button', { name: 'Next comment' }));
    expect(onJumpPrev).toHaveBeenCalledTimes(1);
    expect(onJumpNext).toHaveBeenCalledTimes(1);

    rerender(
      <RailDensityControl
        density="anchored"
        onDensityChange={vi.fn()}
        openCount={0}
        resolvedCount={0}
        totalCount={0}
        resolveEnabled
        onJumpPrev={onJumpPrev}
        onJumpNext={onJumpNext}
        onBulkDelete={vi.fn()}
      />,
    );
    expect(
      (screen.getByRole('button', { name: 'Next comment' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('offers the bulk actions in an overflow menu, gated on the counts', () => {
    const onBulkResolve = vi.fn();
    renderControl({ onBulkResolve, resolvedCount: 0 });
    fireEvent.click(screen.getByRole('button', { name: 'Comment actions' }));
    expect(screen.getByText('Resolve all open')).toBeTruthy();
    // No resolved comments yet, so nothing to clear.
    expect(screen.queryByText('Clear resolved')).toBeNull();
    fireEvent.click(screen.getByText('Resolve all open'));
    expect(onBulkResolve).toHaveBeenCalledTimes(1);
  });

  it('hides resolve-only bulk actions when the resolve workflow is off', () => {
    renderControl({ resolveEnabled: false, resolvedCount: 0 });
    fireEvent.click(screen.getByRole('button', { name: 'Comment actions' }));
    expect(screen.queryByText('Resolve all open')).toBeNull();
    expect(screen.getByText('Delete all comments…')).toBeTruthy();
  });

  it('confirms before deleting all comments', () => {
    const onBulkDelete = vi.fn();
    renderControl({ onBulkDelete });
    fireEvent.click(screen.getByRole('button', { name: 'Comment actions' }));
    fireEvent.click(screen.getByText('Delete all comments…'));
    expect(onBulkDelete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Delete All' }));
    expect(onBulkDelete).toHaveBeenCalledTimes(1);
  });

  it('hides the overflow menu entirely when there are no comments', () => {
    renderControl({ openCount: 0, totalCount: 0, resolvedCount: 0 });
    expect(screen.queryByRole('button', { name: 'Comment actions' })).toBeNull();
  });

  it('drops an open menu and dialog when the comments disappear underneath them', () => {
    // A file-watcher reload or an agent rewrite can empty the document with no
    // click involved, so neither surface gets ContextMenu's outside-mousedown.
    const { rerender } = renderControl();
    fireEvent.click(screen.getByRole('button', { name: 'Comment actions' }));
    fireEvent.click(screen.getByText('Delete all comments…'));
    expect(screen.getByRole('button', { name: 'Delete All' })).toBeTruthy();

    rerender(
      <RailDensityControl
        density="anchored"
        onDensityChange={vi.fn()}
        openCount={0}
        resolvedCount={0}
        totalCount={0}
        resolveEnabled
        onJumpPrev={vi.fn()}
        onJumpNext={vi.fn()}
        onBulkDelete={vi.fn()}
      />,
    );
    expect(screen.queryByText('Resolve all open')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete All' })).toBeNull();
  });
});

describe('CommentsRail', () => {
  describe('Anchored density', () => {
    it('renders a positioned card per anchoredComments entry', async () => {
      renderRail();
      expect(await screen.findByText('First comment')).toBeTruthy();
      expect(screen.getByText('Orphaned comment')).toBeTruthy();
      const card = document.querySelector('[data-margin-card-id="c1"]') as HTMLElement;
      expect(card.style.top).toBe('100px');
      // The orphan renders at its stacked block position (badge rendering is
      // ThreadCard's existing anchorMissing behavior, covered visually).
      const orphan = document.querySelector('[data-margin-card-id="c2"]') as HTMLElement;
      expect(orphan.style.top).toBe('0px');
    });

    it('inactive cards are compact: replies collapse to a summary line', async () => {
      renderRail();
      expect(await screen.findByText('1 reply from Dennis')).toBeTruthy();
      expect(screen.queryByText('A reply')).toBeNull();
    });

    it('the active card is not compact: replies render fully', async () => {
      renderRail({ activeCommentId: 'c2' });
      expect(await screen.findByText('A reply')).toBeTruthy();
      expect(screen.queryByTestId('reply-summary')).toBeNull();
    });

    it('clicking the collapsed summary activates the card that owns it', async () => {
      const onActivate = vi.fn();
      renderRail({ onActivate });
      fireEvent.click(await screen.findByTestId('reply-summary'));
      expect(onActivate).toHaveBeenCalledWith('c2');
    });

    it('forwards unread reply IDs so the summary marks them new', async () => {
      renderRail({ unreadReplyIds: new Set(['r1']) });
      const summary = await screen.findByTestId('reply-summary');
      expect(summary.textContent).toContain('1 new reply from Dennis');
      expect(summary.getAttribute('data-unread')).toBe('true');
    });

    it('clicking a card activates the comment', async () => {
      const onActivate = vi.fn();
      renderRail({ onActivate });
      fireEvent.click(await screen.findByText('First comment'));
      expect(onActivate).toHaveBeenCalledWith('c1');
    });

    it('renders no cards when layout is inactive', () => {
      renderRail({ layout: layout({ active: false }) });
      expect(document.querySelector('[data-margin-notes]')).toBeNull();
      expect(document.querySelector('[data-margin-card-id]')).toBeNull();
    });
  });

  describe('List density', () => {
    it('renders CommentListSurface content and no anchored cards', () => {
      renderRail({ density: 'list' });
      expect(screen.getByPlaceholderText('Search')).toBeTruthy();
      expect(document.querySelector('[data-margin-card-id]')).toBeNull();
      expect(document.querySelector('[data-margin-notes]')).toBeNull();
    });
  });
});
