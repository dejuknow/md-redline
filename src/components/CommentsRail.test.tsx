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
import { CommentsRail } from './CommentsRail';
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
    replies: [
      { id: 'r1', text: 'A reply', author: 'Dennis', timestamp: new Date().toISOString() },
    ],
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
    onDensityChange: vi.fn(),
    scrollRef: nullScrollRef,
    layout: layout(),
    anchoredComments: comments,
    allComments: comments,
    activeCommentId: null,
    missingAnchors: new Set(['c2']),
    sentCommentIds: [],
    openCount: 2,
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

describe('CommentsRail', () => {
  describe('header', () => {
    it('renders both density options and switches on click', () => {
      const onDensityChange = vi.fn();
      renderRail({ onDensityChange });
      expect(screen.getByRole('button', { name: 'Anchored' })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'List' })).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'List' }));
      expect(onDensityChange).toHaveBeenCalledWith('list');
    });

    it('renders the open count', async () => {
      renderRail({ openCount: 3 });
      expect(await screen.findByText('3 open')).toBeTruthy();
    });
  });

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

    it('inactive cards are compact: replies collapse to a count line', async () => {
      renderRail();
      expect(await screen.findByText('1 reply')).toBeTruthy();
      expect(screen.queryByText('A reply')).toBeNull();
    });

    it('the active card is not compact: replies render fully', async () => {
      renderRail({ activeCommentId: 'c2' });
      expect(await screen.findByText('A reply')).toBeTruthy();
      expect(screen.queryByText('1 reply')).toBeNull();
    });

    it('clicking a card activates the comment', async () => {
      const onActivate = vi.fn();
      renderRail({ onActivate });
      fireEvent.click(await screen.findByText('First comment'));
      expect(onActivate).toHaveBeenCalledWith('c1');
    });

    it('renders the header but no cards when layout is inactive', () => {
      renderRail({ layout: layout({ active: false }) });
      expect(screen.getByRole('button', { name: 'Anchored' })).toBeTruthy();
      expect(document.querySelector('[data-margin-notes]')).toBeNull();
      expect(document.querySelector('[data-margin-card-id]')).toBeNull();
    });
  });

  describe('List density', () => {
    it('renders CommentListSurface content and no anchored cards', () => {
      renderRail({ density: 'list' });
      expect(screen.getByPlaceholderText('Search comments...')).toBeTruthy();
      expect(document.querySelector('[data-margin-card-id]')).toBeNull();
      expect(document.querySelector('[data-margin-notes]')).toBeNull();
    });
  });
});
