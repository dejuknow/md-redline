// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

// Mock preferences-client so SettingsContext doesn't hit the network
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
import { CommentCard } from './CommentCard';
import type { MdComment } from '../types';

function AllProviders({ children }: { children: ReactNode }) {
  return createElement(SettingsProvider, null, children);
}

// jsdom has no ResizeObserver. CommentCard observes its text node to re-check
// clamping on resize, so every test in this file needs a stub — track
// observed elements so the clamp re-check test can assert on them.
let resizeObserverObserved: Element[] = [];
class ResizeObserverStub {
  constructor(private cb: ResizeObserverCallback) {}
  observe(el: Element) {
    resizeObserverObserved.push(el);
  }
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  fetchPreferences.mockReset();
  fetchPreferences.mockResolvedValue({ settings: {} });
  resizeObserverObserved = [];
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const baseComment: MdComment = {
  id: 'cmt_1',
  anchor: 'Hello world',
  text: 'This needs revision.',
  author: 'Claude',
  timestamp: new Date().toISOString(),
  agentInitiated: true,
};

function renderCard(
  props: Partial<Parameters<typeof CommentCard>[0]> = {},
  mockSettings?: Record<string, unknown>,
) {
  fetchPreferences.mockReset();
  fetchPreferences.mockResolvedValue({
    settings: mockSettings || {},
  });
  const defaults: Parameters<typeof CommentCard>[0] = {
    comment: baseComment,
    isActive: false,
    editor: null,
    onActivate: vi.fn(),
    onDelete: vi.fn(),
    onEdit: vi.fn(),
    onReply: vi.fn(),
    onEditReply: vi.fn(),
    onDeleteReply: vi.fn(),
    onRequestCommentEdit: vi.fn(),
    onRequestReplyCompose: vi.fn(),
    onRequestReplyEdit: vi.fn(),
    onCloseEditor: vi.fn(),
  };
  return render(
    createElement(CommentCard, { ...defaults, ...props }),
    { wrapper: AllProviders },
  );
}

describe('CommentCard — agent-initiated comment', () => {
  it('does not render "Awaiting your reply" banner', () => {
    renderCard();
    expect(screen.queryByText(/awaiting your reply/i)).toBeNull();
  });

  it('renders the Delete action when active', () => {
    renderCard({ isActive: true });
    const deleteBtn = screen.queryByRole('button', { name: /delete/i });
    expect(deleteBtn).not.toBeNull();
  });

  it('renders the Reply action when active', () => {
    renderCard({ isActive: true });
    const replyBtn = screen.queryByRole('button', { name: /^reply$/i });
    expect(replyBtn).not.toBeNull();
  });

  it('renders the Edit action when active', () => {
    renderCard({ isActive: true });
    const editBtn = screen.queryByRole('button', { name: /^edit$/i });
    expect(editBtn).not.toBeNull();
  });
});

describe('CommentCard — user-authored comment', () => {
  const userComment: MdComment = {
    ...baseComment,
    agentInitiated: false,
    author: 'Alice',
  };

  it('renders Delete, Edit, and Reply when active', () => {
    renderCard({ comment: userComment, isActive: true });
    expect(screen.queryByRole('button', { name: /delete/i })).not.toBeNull();
    expect(screen.queryByRole('button', { name: /^edit$/i })).not.toBeNull();
    expect(screen.queryByRole('button', { name: /^reply$/i })).not.toBeNull();
  });
});

describe('anchor quote', () => {
  it('renders the anchor as a serif excerpt with the full anchor in title', () => {
    renderCard({ comment: { ...baseComment, anchor: 'Password must be at least 8 characters' } });
    const quote = screen.getByTitle('Password must be at least 8 characters');
    expect(quote.hasAttribute('data-anchor-quote')).toBe(true);
    expect(quote.className).toContain('comment-quote');
    expect(quote.className).not.toContain('font-mono');
  });
});

describe('CommentCard: compact mode', () => {
  it('compact hides the replies thread and shows a count line', async () => {
    const withReplies: MdComment = {
      ...baseComment,
      replies: [
        { id: 'r1', text: 'First reply', author: 'Dennis', timestamp: new Date().toISOString() },
        { id: 'r2', text: 'Second reply', author: 'Dennis', timestamp: new Date().toISOString() },
      ],
    };
    renderCard({ comment: withReplies, compact: true });
    expect(await screen.findByText('2 replies')).toBeTruthy();
    expect(screen.queryByText('First reply')).toBeNull();
    expect(screen.queryByText('Second reply')).toBeNull();
  });

  it('compact uses singular for one reply', async () => {
    const oneReply: MdComment = {
      ...baseComment,
      replies: [
        { id: 'r1', text: 'Only reply', author: 'Dennis', timestamp: new Date().toISOString() },
      ],
    };
    renderCard({ comment: oneReply, compact: true });
    expect(await screen.findByText('1 reply')).toBeTruthy();
    expect(screen.queryByText('Only reply')).toBeNull();
  });

  it('non-compact renders replies as before', async () => {
    const withReplies: MdComment = {
      ...baseComment,
      replies: [
        { id: 'r1', text: 'First reply', author: 'Dennis', timestamp: new Date().toISOString() },
      ],
    };
    renderCard({ comment: withReplies });
    expect(await screen.findByText('First reply')).toBeTruthy();
    expect(screen.queryByText('1 reply')).toBeNull();
  });
});

describe('status pill and resolve action', () => {
  it('renders the open pill in the amber anchor tint', async () => {
    renderCard({}, { enableResolve: true });
    const pill = await waitFor(() => screen.getByText('Open'));
    expect(pill.className).toContain('bg-comment-anchor-bg');
    expect(pill.className).not.toContain('status-open');
  });

  it('renders the resolved pill neutral', async () => {
    const resolvedComment: MdComment = {
      ...baseComment,
      status: 'resolved',
    };
    renderCard({ comment: resolvedComment }, { enableResolve: true });
    const pill = await waitFor(() => screen.getByText('Resolved'));
    expect(pill.className).toContain('bg-surface-inset');
  });

  it('Resolve is a primary (crimson) action', async () => {
    renderCard({ isActive: true, onResolve: vi.fn() }, { enableResolve: true });
    const btn = await waitFor(() => screen.getByRole('button', { name: 'Resolve' }));
    expect(btn.className).toContain('text-primary-text');
  });
});

describe('clamp re-check', () => {
  it('re-checks clamping when the text element resizes', () => {
    renderCard({});
    const textEl = screen.getByText(baseComment.text);
    expect(resizeObserverObserved).toContain(textEl);
  });
});
