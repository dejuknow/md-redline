// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

const fetchPreferences = vi.fn();
const savePreferencesToDisk = vi.fn();
vi.mock('../lib/preferences-client', () => ({
  fetchPreferences: (...args: unknown[]) => fetchPreferences(...args),
  savePreferencesToDisk: (...args: unknown[]) => savePreferencesToDisk(...args),
}));

import { SettingsProvider } from '../contexts/SettingsContext';
import { MarginNotes } from './MarginNotes';
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
    marginWidth: 280,
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

function renderNotes(
  props: Partial<React.ComponentProps<typeof MarginNotes>> = {},
) {
  const defaults: React.ComponentProps<typeof MarginNotes> = {
    layout: layout(),
    comments,
    activeCommentId: null,
    missingAnchors: new Set(['c2']),
    sentCommentIds: [],
    onActivate: vi.fn(),
    onReply: vi.fn(),
    onDelete: vi.fn(),
    onEdit: vi.fn(),
    onEditReply: vi.fn(),
    onDeleteReply: vi.fn(),
  };
  return {
    props: { ...defaults, ...props },
    ...render(
      <SettingsProvider>
        <MarginNotes {...defaults} {...props} />
      </SettingsProvider>,
    ),
  };
}

beforeEach(() => {
  fetchPreferences.mockReset();
  fetchPreferences.mockResolvedValue({ settings: {} });
});

afterEach(() => cleanup());

describe('MarginNotes', () => {
  it('renders nothing when layout is inactive', () => {
    renderNotes({ layout: layout({ active: false }) });
    expect(document.querySelector('[data-margin-notes]')).toBeNull();
  });

  it('renders a positioned card per comment', async () => {
    renderNotes();
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
    renderNotes();
    expect(await screen.findByText('1 reply')).toBeTruthy();
    expect(screen.queryByText('A reply')).toBeNull();
  });

  it('the active card is not compact: replies render fully', async () => {
    renderNotes({ activeCommentId: 'c2' });
    expect(await screen.findByText('A reply')).toBeTruthy();
    expect(screen.queryByText('1 reply')).toBeNull();
  });

  it('clicking a card activates the comment', async () => {
    const onActivate = vi.fn();
    renderNotes({ onActivate });
    fireEvent.click(await screen.findByText('First comment'));
    expect(onActivate).toHaveBeenCalledWith('c1');
  });
});
