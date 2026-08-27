// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
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
// clamping on resize, so every test in this file needs a stub. Track
// observed elements so the clamp re-check test can assert on them.
let resizeObserverObserved: Element[] = [];
class ResizeObserverStub {
  constructor() {}
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
  return render(createElement(CommentCard, { ...defaults, ...props }), { wrapper: AllProviders });
}

describe('CommentCard - sent dimming', () => {
  // `sent` marks a comment already handed to the agent. Dimming it at rest
  // says so; dimming it while the user is working in it says nothing useful
  // and reads as disabled, which is what the whole sidebar looked like after
  // every Send. `isResolved` already gets this right by living inside the
  // isActive ternary, so this is the same rule applied to the sibling flag.
  it('dims a sent comment at rest', () => {
    const { container } = renderCard({ sent: true, isActive: false });
    expect((container.firstChild as HTMLElement).className).toContain('opacity-50');
  });

  it('does not dim a sent comment while it is active', () => {
    const { container } = renderCard({ sent: true, isActive: true });
    expect((container.firstChild as HTMLElement).className).not.toContain('opacity-50');
  });

  it('leaves an unsent comment undimmed either way', () => {
    const atRest = renderCard({ sent: false, isActive: false });
    expect((atRest.container.firstChild as HTMLElement).className).not.toContain('opacity-50');
    const active = renderCard({ sent: false, isActive: true });
    expect((active.container.firstChild as HTMLElement).className).not.toContain('opacity-50');
  });

  it('never stacks two opacity classes on a sent, resolved card', async () => {
    // opacity-50 and opacity-60 on one element is settled by Tailwind's
    // stylesheet order, not by position in the string, so which one wins is
    // invisible from the call site. Resolved owns the dimming here.
    // isResolved needs enableResolve, since that is what turns the status on.
    const { container } = renderCard(
      { sent: true, isActive: false, comment: { ...baseComment, status: 'resolved' } },
      { enableResolve: true },
    );
    const card = () => (container.firstChild as HTMLElement).className;
    await waitFor(() => expect(card()).toContain('opacity-60'));
    expect(card()).not.toContain('opacity-50');
  });
});

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
  it('compact hides the replies thread and shows a summary line', async () => {
    const withReplies: MdComment = {
      ...baseComment,
      replies: [
        { id: 'r1', text: 'First reply', author: 'Dennis', timestamp: new Date().toISOString() },
        { id: 'r2', text: 'Second reply', author: 'Dennis', timestamp: new Date().toISOString() },
      ],
    };
    renderCard({ comment: withReplies, compact: true });
    expect(await screen.findByText('2 replies from Dennis')).toBeTruthy();
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
    expect(await screen.findByText('1 reply from Dennis')).toBeTruthy();
    expect(screen.queryByText('Only reply')).toBeNull();
  });

  it('names both authors of a two-author thread, and counts the rest beyond that', async () => {
    const stamp = new Date().toISOString();
    renderCard({
      comment: {
        ...baseComment,
        replies: [
          { id: 'r1', text: 'a', author: 'Claude', timestamp: stamp },
          { id: 'r2', text: 'b', author: 'Dennis', timestamp: stamp },
        ],
      },
      compact: true,
    });
    expect(await screen.findByText('2 replies from Claude and Dennis')).toBeTruthy();

    cleanup();
    renderCard({
      comment: {
        ...baseComment,
        replies: [
          { id: 'r1', text: 'a', author: 'Claude', timestamp: stamp },
          { id: 'r2', text: 'b', author: 'Dennis', timestamp: stamp },
          { id: 'r3', text: 'c', author: 'Bianca', timestamp: stamp },
        ],
      },
      compact: true,
    });
    expect(await screen.findByText('3 replies from Claude, Dennis +1')).toBeTruthy();
  });

  it('renders one author dot per named author, never an unnamed one', async () => {
    const stamp = new Date().toISOString();
    renderCard({
      comment: {
        ...baseComment,
        replies: [
          { id: 'r1', text: 'a', author: 'Claude', timestamp: stamp },
          { id: 'r2', text: 'b', author: 'Dennis', timestamp: stamp },
          { id: 'r3', text: 'c', author: 'Bianca', timestamp: stamp },
          { id: 'r4', text: 'd', author: 'Sam', timestamp: stamp },
        ],
      },
      compact: true,
    });
    const summary = await screen.findByTestId('reply-summary');
    expect(summary.textContent).toContain('4 replies from Claude, Dennis +2');
    // Two names on the line, so two dots. A dot for an author the reader
    // can't see named is a colour with nothing to attach it to.
    expect(summary.querySelectorAll('span[style*="background-color"]').length).toBe(2);
  });

  it('the summary tooltip counts the same replies the line does', async () => {
    const stamp = new Date().toISOString();
    renderCard({
      comment: {
        ...baseComment,
        replies: [
          { id: 'r1', text: 'read already', author: 'Dennis', timestamp: stamp },
          { id: 'r2', text: 'read already too', author: 'Dennis', timestamp: stamp },
          { id: 'r3', text: 'just landed', author: 'Claude', timestamp: stamp },
        ],
      },
      compact: true,
      unreadReplyIds: new Set(['r3']),
    });
    const summary = await screen.findByTestId('reply-summary');
    expect(summary.textContent).toContain('1 new reply from Claude');
    expect(summary.getAttribute('title')).toBe('Open this comment to read the reply');
  });

  it('marks the summary as a collapsed disclosure for assistive tech', async () => {
    renderCard({
      comment: {
        ...baseComment,
        replies: [
          { id: 'r1', text: 'Only reply', author: 'Dennis', timestamp: new Date().toISOString() },
        ],
      },
      compact: true,
    });
    const summary = await screen.findByTestId('reply-summary');
    expect(summary.getAttribute('aria-expanded')).toBe('false');
  });

  it('the summary counts and attributes only the unread replies', async () => {
    const stamp = new Date().toISOString();
    renderCard({
      comment: {
        ...baseComment,
        replies: [
          { id: 'r1', text: 'old one', author: 'Dennis', timestamp: stamp },
          { id: 'r2', text: 'just landed', author: 'Claude', timestamp: stamp },
        ],
      },
      compact: true,
      unreadReplyIds: new Set(['r2']),
    });
    // Not "2 replies": the agent's answer is what the reader came back for, and
    // folding it into a total is what made it easy to miss.
    const summary = await screen.findByTestId('reply-summary');
    expect(summary.textContent).toContain('1 new reply from Claude');
    expect(summary.getAttribute('data-unread')).toBe('true');
  });

  it('drops the new emphasis once every reply has been read', async () => {
    renderCard({
      comment: {
        ...baseComment,
        replies: [
          { id: 'r1', text: 'read already', author: 'Claude', timestamp: new Date().toISOString() },
        ],
      },
      compact: true,
      unreadReplyIds: new Set(['r-from-another-comment']),
    });
    const summary = await screen.findByTestId('reply-summary');
    expect(summary.textContent).toContain('1 reply from Claude');
    expect(summary.textContent).not.toContain('new');
    expect(summary.getAttribute('data-unread')).toBeNull();
  });

  it('the summary line activates the card, which is what expands the thread', async () => {
    const onActivate = vi.fn();
    renderCard({
      comment: {
        ...baseComment,
        replies: [
          { id: 'r1', text: 'Only reply', author: 'Dennis', timestamp: new Date().toISOString() },
        ],
      },
      compact: true,
      onActivate,
    });
    fireEvent.click(await screen.findByTestId('reply-summary'));
    expect(onActivate).toHaveBeenCalledWith(baseComment.id);
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
    expect(screen.queryByTestId('reply-summary')).toBeNull();
  });

  it('compact still renders the reply composer when reply-compose is active', async () => {
    // The action bar is reachable on a compact (inactive) margin card, so the
    // composer it triggers must render there too — otherwise Reply is a dead
    // button. It is deliberately not compact-gated, unlike the replies thread.
    renderCard({
      comment: baseComment,
      compact: true,
      editor: { mode: 'reply-compose', token: 1 },
    });
    expect(await screen.findByPlaceholderText('Write a reply...')).toBeTruthy();
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

  it('Resolve is a success (green) action, not crimson', async () => {
    renderCard({ isActive: true, onResolve: vi.fn() }, { enableResolve: true });
    const btn = await waitFor(() => screen.getByRole('button', { name: 'Resolve' }));
    expect(btn.className).toContain('text-success-text');
    expect(btn.className).not.toContain('text-primary-text');
  });
});

describe('clamp re-check', () => {
  it('re-checks clamping when the text element resizes', () => {
    renderCard({});
    const textEl = screen.getByText(baseComment.text);
    expect(resizeObserverObserved).toContain(textEl);
  });
});

describe('CommentCard — anchor badges', () => {
  it('shows no anchor badge when the anchor is intact', () => {
    renderCard();
    expect(screen.queryByText('Changed')).toBeNull();
    expect(screen.queryByText('Re-anchored')).toBeNull();
  });

  it('shows "Re-anchored" and quotes where the comment now points', () => {
    renderCard({
      comment: {
        ...baseComment,
        anchorStale: true,
        recoveredAnchor: 'A1. The section that replaced it',
      },
    });
    expect(screen.queryByText('Re-anchored')).not.toBeNull();
    expect(screen.queryByText('Changed')).toBeNull();
    // The quote follows the recovery, so the card describes the document as it
    // is now rather than as it was when the comment was written.
    expect(screen.getByText(/A1\. The section that replaced it/)).toBeTruthy();
  });

  it('keeps the original anchor reachable in the title when re-anchored', () => {
    const { container } = renderCard({
      comment: { ...baseComment, anchorStale: true, recoveredAnchor: 'the replacement' },
    });
    const quote = container.querySelector('[data-anchor-quote]');
    expect(quote?.getAttribute('title')).toContain('Hello world');
  });

  it('shows "Changed" for an open comment whose anchor could not be recovered', () => {
    renderCard({ comment: { ...baseComment, anchorStale: true }, anchorMissing: true });
    const badge = screen.queryByText('Changed');
    expect(badge).not.toBeNull();
    expect(badge?.className).toContain('bg-danger-bg');
  });

  it('shows a quiet "Changed" for a resolved comment detached by a later rewrite', () => {
    // Resolved comments are excluded from the rail's orphan set (the reviewer
    // cannot act on them), so anchorMissing is false while anchorStale is true.
    // The badge still has to appear, or the resolved thread silently stops
    // pointing anywhere.
    renderCard({
      comment: { ...baseComment, status: 'resolved', resolved: true, anchorStale: true },
      anchorMissing: false,
    });
    const badge = screen.queryByText('Changed');
    expect(badge).not.toBeNull();
    expect(badge?.className).not.toContain('bg-danger-bg');
  });

  it('reads the quiet variant off the comment’s status, not off a missing prop', () => {
    // MermaidThreadPanel renders cards without wiring anchorMissing at all, so
    // "no anchorMissing" cannot be taken to mean "resolved". An OPEN detached
    // comment there must still read as loud and actionable, and must never be
    // told it was resolved.
    renderCard({
      comment: { ...baseComment, anchorStale: true },
      anchorMissing: undefined,
    });
    const badge = screen.queryByText('Changed');
    expect(badge).not.toBeNull();
    expect(badge?.className).toContain('bg-danger-bg');
    expect(badge?.getAttribute('title')).not.toContain('resolved');
  });

  it('suppresses the badge when the full anchor context is already shown', () => {
    renderCard({
      comment: { ...baseComment, anchorStale: true },
      anchorMissing: true,
      showAnchorContext: true,
    });
    expect(screen.queryByText('Changed')).toBeNull();
  });
});
