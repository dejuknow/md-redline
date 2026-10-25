// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
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

describe('CommentCard - answered indicator', () => {
  const answeredComment = {
    ...baseComment,
    replies: [
      { id: 'r1', text: 'Per-tenant, yes.', author: 'Claude', timestamp: new Date().toISOString() },
    ],
  };

  it('marks a comment an agent has replied to', async () => {
    renderCard({ comment: answeredComment, answered: true });
    expect(await screen.findByText('Answered')).toBeTruthy();
  });

  it('says nothing when no agent has replied', () => {
    renderCard({ comment: baseComment, answered: false });
    expect(screen.queryByText('Answered')).toBeNull();
  });

  it('agrees with the footer on a resolved comment in remove mode', async () => {
    // The card gates on resolveEnabled && status === 'resolved'; the footer
    // count gates the same way. They used to differ, so a file resolved in
    // someone else's resolve-mode session and reopened in remove mode showed
    // the pill here while the footer skipped it, and the total read lower than
    // the pills on screen.
    // enableResolve is set explicitly, not inherited. The shipped default is
    // resolve mode, so omitting it here would quietly run this "remove mode"
    // case in the other one and assert nothing.
    renderCard(
      { comment: { ...answeredComment, status: 'resolved' }, answered: true },
      { enableResolve: false },
    );
    expect(await screen.findByText('Answered')).toBeTruthy();
  });

  it('stands in for the Sent pill rather than stacking beside it', async () => {
    // Three badges on a 280px margin card squeeze the anchor quote down to a
    // word or two, and a comment cannot be answered without having been sent.
    renderCard({ comment: answeredComment, answered: true, sent: true });
    expect(await screen.findByText('Answered')).toBeTruthy();
    expect(screen.queryByText('Sent')).toBeNull();
  });

  it('still shows Sent on a comment nobody has answered', () => {
    renderCard({ comment: baseComment, answered: false, sent: true });
    expect(screen.queryByText('Sent')).toBeTruthy();
  });

  it('still marks an answered question in resolve mode, beside Open', async () => {
    // Resolve mode reports per-comment state for an EDIT, which ends
    // resolved. A question is told to stay open, so without the pill an
    // answered question shows "Open" and reads as untouched -- the same gap
    // the pill exists for in the other mode.
    renderCard({ comment: answeredComment, answered: true }, { enableResolve: true });
    await waitFor(() => expect(screen.queryByText('Open')).toBeTruthy());
    expect(screen.queryByText('Answered')).toBeTruthy();
  });

  it('says nothing on a resolved comment, which is already finished', async () => {
    renderCard(
      { comment: { ...answeredComment, status: 'resolved' }, answered: true },
      { enableResolve: true },
    );
    await waitFor(() => expect(screen.queryByText('Resolved')).toBeTruthy());
    expect(screen.queryByText('Answered')).toBeNull();
  });
});

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

  it('renders the thread Delete when active', () => {
    renderCard({ isActive: true });
    const deleteBtn = screen.queryByRole('button', { name: 'Delete' });
    expect(deleteBtn).not.toBeNull();
  });

  it('offers the reply field, not a footer Reply, when active', () => {
    renderCard({ isActive: true });
    expect(screen.queryByRole('button', { name: 'Write a reply...' })).not.toBeNull();
    expect(screen.queryByRole('button', { name: /^reply$/i })).toBeNull();
  });

  it('offers no Edit when active, since the text is the agent’s (#174)', () => {
    // An mdr_ask question or mdr_comment note falls under the same rule as an
    // agent's reply. Delete and the reply field stay (see the two tests above).
    renderCard({ isActive: true });
    const editBtn = screen.queryByRole('button', { name: /^edit$/i });
    expect(editBtn).toBeNull();
  });
});

describe('CommentCard — user-authored comment', () => {
  const userComment: MdComment = {
    ...baseComment,
    agentInitiated: false,
    author: 'Alice',
  };

  it('renders Delete, Edit, and the reply field when active', () => {
    renderCard({ comment: userComment, isActive: true });
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeNull();
    expect(screen.queryByRole('button', { name: /^edit$/i })).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Write a reply...' })).not.toBeNull();
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
    // The composer is an explicit editor surface, deliberately not
    // compact-gated like the replies thread, so a compose request that lands
    // on a compact (inactive) margin card still has somewhere to render.
    renderCard({
      comment: baseComment,
      compact: true,
      editor: { mode: 'reply-compose', token: 1 },
    });
    expect(await screen.findByPlaceholderText('Write a reply...')).toBeTruthy();
  });
});

describe('CommentCard: reply actions in a thread', () => {
  const reviewerComment: MdComment = {
    ...baseComment,
    agentInitiated: false,
    author: 'Alice',
  };
  const answered: MdComment = {
    ...reviewerComment,
    replies: [
      {
        id: 'r1',
        text: 'Per-tenant, yes.',
        author: 'Claude',
        timestamp: new Date().toISOString(),
        agent: true,
      },
    ],
  };

  const replyButtons = () => screen.queryAllByRole('button', { name: /^reply$/i });
  const replyField = () => screen.queryByRole('button', { name: 'Write a reply...' });
  const follows = (a: Node, b: Node) =>
    Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

  it('ends a selected card’s full thread with a reply field, not a footer Reply', async () => {
    const { container } = renderCard({ comment: answered, isActive: true });
    await screen.findByText('Per-tenant, yes.');
    const lastReply = container.querySelector('[data-reply-id="r1"]')!;
    expect(replyField()).not.toBeNull();
    expect(follows(lastReply, replyField()!)).toBe(true);
    expect(replyButtons()).toHaveLength(0);
  });

  it('opens the composer from the reply field', async () => {
    const onRequestReplyCompose = vi.fn();
    renderCard({ comment: answered, isActive: true, onRequestReplyCompose });
    await screen.findByText('Per-tenant, yes.');
    fireEvent.click(replyField()!);
    expect(onRequestReplyCompose).toHaveBeenCalledWith('cmt_1');
  });

  it('holds no reply row on an unselected card whose thread shows in full', async () => {
    // The List view never compacts its cards. A trigger kept there at
    // opacity 0 still takes a row and can take keyboard focus unseen.
    renderCard({ comment: answered, isActive: false });
    await screen.findByText('Per-tenant, yes.');
    expect(replyField()).toBeNull();
    expect(replyButtons()).toHaveLength(0);
  });

  it('renders no reply control on a compact card, whose thread is a summary line', async () => {
    // Clicking the summary selects the card, and the selected card carries the
    // reply field. Until then there is nothing to reach for.
    renderCard({ comment: answered, compact: true });
    await screen.findByTestId('reply-summary');
    expect(replyButtons()).toHaveLength(0);
    expect(replyField()).toBeNull();
  });

  it('swaps the reply field for the composer while it is open', async () => {
    renderCard({
      comment: answered,
      isActive: true,
      editor: { mode: 'reply-compose', token: 1 },
    });
    await screen.findByPlaceholderText('Write a reply...');
    expect(replyField()).toBeNull();
    // Only the composer's own submit button remains.
    expect(replyButtons()).toHaveLength(1);
    expect((replyButtons()[0] as HTMLButtonElement).disabled).toBe(true);
  });

  it('offers Delete but no Edit on a reply stamped as an agent’s', async () => {
    // Rewriting an agent's words makes no sense, but dropping one stray
    // answer (a duplicate, say) shouldn't cost the whole thread.
    const { container } = renderCard({ comment: answered, isActive: true });
    await screen.findByText('Per-tenant, yes.');
    const reply = container.querySelector<HTMLElement>('[data-reply-id="r1"]')!;
    expect(within(reply).queryByRole('button', { name: /^edit$/i })).toBeNull();
    expect(within(reply).queryByRole('button', { name: /delete/i })).not.toBeNull();
  });

  it('reveals a reply’s actions to keyboard focus as well as hover', async () => {
    // `invisible` takes a button out of the tab order, so Tab could never reach
    // it to reveal it. Opacity keeps it focusable and focus-within shows it.
    const { container } = renderCard({ comment: answered, isActive: true });
    await screen.findByText('Per-tenant, yes.');
    const reply = container.querySelector<HTMLElement>('[data-reply-id="r1"]')!;
    const actions = within(reply).getByRole('button', { name: 'Delete' }).parentElement!;
    expect(actions.className).toContain('opacity-0');
    expect(actions.className).toContain('group-hover/reply:opacity-100');
    expect(actions.className).toContain('group-focus-within/reply:opacity-100');
    expect(actions.className).not.toContain('invisible');
  });

  it('shows no actions on a reply of an unselected card whose thread shows in full', async () => {
    // The List view never compacts its cards, so an unselected card renders its
    // whole thread. Its reply rows get no Edit or trash until it is selected.
    const own: MdComment = {
      ...reviewerComment,
      replies: [
        {
          id: 'r1',
          text: 'Thanks.',
          author: 'Alice',
          timestamp: new Date().toISOString(),
          agent: false,
        },
      ],
    };
    const { container } = renderCard({ comment: own, isActive: false });
    await screen.findByText('Thanks.');
    const reply = container.querySelector<HTMLElement>('[data-reply-id="r1"]')!;
    expect(within(reply).queryAllByRole('button')).toHaveLength(0);
  });

  it('deletes just that reply from the reply row’s trash', async () => {
    const onDeleteReply = vi.fn();
    const onDelete = vi.fn();
    const { container } = renderCard({
      comment: answered,
      isActive: true,
      onDeleteReply,
      onDelete,
    });
    await screen.findByText('Per-tenant, yes.');
    const reply = container.querySelector<HTMLElement>('[data-reply-id="r1"]')!;
    fireEvent.click(within(reply).getByRole('button', { name: 'Delete' }));
    expect(onDeleteReply).toHaveBeenCalledWith('cmt_1', 'r1');
    expect(onDelete).not.toHaveBeenCalled();
  });

  it('keeps Edit and Delete on the reviewer’s own reply', async () => {
    const own: MdComment = {
      ...reviewerComment,
      replies: [
        {
          id: 'r1',
          text: 'Thanks.',
          author: 'Alice',
          timestamp: new Date().toISOString(),
          agent: false,
        },
      ],
    };
    const { container } = renderCard({ comment: own, isActive: true });
    await screen.findByText('Thanks.');
    const reply = container.querySelector<HTMLElement>('[data-reply-id="r1"]')!;
    expect(within(reply).queryByRole('button', { name: /^edit$/i })).not.toBeNull();
    expect(within(reply).queryByRole('button', { name: /delete/i })).not.toBeNull();
  });

  it('keeps Edit and Delete on an unstamped reply, even from another author', async () => {
    // Without the stamp, only a name comparison could call this an agent's
    // reply, and that comparison mistakes a colleague for an agent (#102).
    const unstamped: MdComment = {
      ...reviewerComment,
      replies: [{ id: 'r1', text: 'Agreed.', author: 'Bob', timestamp: new Date().toISOString() }],
    };
    const { container } = renderCard({ comment: unstamped, isActive: true });
    await screen.findByText('Agreed.');
    const reply = container.querySelector<HTMLElement>('[data-reply-id="r1"]')!;
    expect(within(reply).queryByRole('button', { name: /^edit$/i })).not.toBeNull();
    expect(within(reply).queryByRole('button', { name: /delete/i })).not.toBeNull();
  });
});

describe('CommentCard: action scope', () => {
  const stamp = new Date().toISOString();
  const reviewer: MdComment = { ...baseComment, agentInitiated: false, author: 'Alice' };
  const withReplies: MdComment = {
    ...reviewer,
    replies: [{ id: 'r1', text: 'Looks right.', author: 'Bob', timestamp: stamp }],
  };

  const actionNames = /^(reply|edit|resolve|reopen|delete|delete thread)$/i;
  const actionButtons = () => screen.queryAllByRole('button', { name: actionNames });
  const replyField = () => screen.queryByRole('button', { name: 'Write a reply...' });
  const resolvedReviewer: MdComment = { ...reviewer, status: 'resolved' };

  describe('an unselected card', () => {
    it('renders no action buttons, compact', async () => {
      renderCard({ comment: withReplies, compact: true, onResolve: vi.fn() });
      await screen.findByTestId('reply-summary');
      expect(actionButtons()).toHaveLength(0);
      expect(replyField()).toBeNull();
    });

    it('renders no action buttons, not compact, with replies', async () => {
      // The List view and the Mermaid thread panel show an unselected card's
      // full thread. Neither the card nor its reply rows get any button.
      const { container } = renderCard({ comment: withReplies, onResolve: vi.fn() });
      await screen.findByText('Looks right.');
      expect(actionButtons()).toHaveLength(0);
      expect(replyField()).toBeNull();
      const reply = container.querySelector<HTMLElement>('[data-reply-id="r1"]')!;
      expect(within(reply).queryAllByRole('button')).toHaveLength(0);
    });

    it('renders no Reopen on a resolved card', async () => {
      renderCard({ comment: resolvedReviewer, onUnresolve: vi.fn() }, { enableResolve: true });
      await waitFor(() => expect(screen.queryByText('Resolved')).toBeTruthy());
      expect(actionButtons()).toHaveLength(0);
    });

    it('holds no button at all, hidden or hover-revealed, behind the byline', () => {
      const { container } = renderCard({ comment: reviewer, onResolve: vi.fn() });
      expect(container.querySelector('button')).toBeNull();
      expect(container.innerHTML).not.toContain('group-hover:opacity-100');
    });

    it('keeps Keep this anchor visible when a recovery applies', () => {
      const onReanchorToSelection = vi.fn();
      renderCard({
        comment: {
          ...reviewer,
          anchorStale: true,
          recoveredAnchor: 'The replacement text',
          cleanOffset: 12,
        },
        compact: true,
        onReanchorToSelection,
      });
      const keep = screen.getByRole('button', { name: 'Keep this anchor' });
      expect(keep.closest('.opacity-0')).toBeNull();
      fireEvent.click(keep);
      expect(onReanchorToSelection).toHaveBeenCalledWith('cmt_1', 'The replacement text', 12);
    });

    it('keeps Re-anchor to selection visible when a selection exists', () => {
      const onReanchorToSelection = vi.fn();
      renderCard({
        comment: { ...reviewer, anchorStale: true, contextBefore: 'a ', contextAfter: ' b' },
        showAnchorContext: true,
        selectionText: 'new anchor',
        selectionOffset: 5,
        onReanchorToSelection,
      });
      const btn = screen.getByRole('button', { name: 'Re-anchor to selection' });
      expect(btn.closest('.opacity-0')).toBeNull();
      fireEvent.click(btn);
      expect(onReanchorToSelection).toHaveBeenCalledWith('cmt_1', 'new anchor', 5);
    });

    it('shows no repair button when nothing applies', () => {
      renderCard({ comment: reviewer, onReanchorToSelection: vi.fn() });
      expect(screen.queryByRole('button', { name: 'Keep this anchor' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Re-anchor to selection' })).toBeNull();
    });
  });

  describe('a selected card', () => {
    it('shows the reply field with no replies, and no footer Reply', () => {
      renderCard({ comment: reviewer, isActive: true });
      expect(replyField()).not.toBeNull();
      expect(screen.queryByRole('button', { name: /^reply$/i })).toBeNull();
    });

    it('hides the reply field while resolved', async () => {
      renderCard(
        { comment: resolvedReviewer, isActive: true, onUnresolve: vi.fn() },
        { enableResolve: true },
      );
      await waitFor(() => expect(screen.queryByText('Resolved')).toBeTruthy());
      expect(replyField()).toBeNull();
    });

    it('hides the reply field while editing the comment or a reply', () => {
      renderCard({
        comment: withReplies,
        isActive: true,
        editor: { mode: 'comment-edit', token: 1 },
      });
      expect(replyField()).toBeNull();
      cleanup();
      renderCard({
        comment: withReplies,
        isActive: true,
        editor: { mode: 'reply-edit', replyId: 'r1', token: 1 },
      });
      expect(replyField()).toBeNull();
    });

    it('puts Edit on the first comment’s byline row', () => {
      const { container } = renderCard({ comment: reviewer, isActive: true });
      const edit = screen.getByRole('button', { name: /^edit$/i });
      const row = container.querySelector<HTMLElement>('.group\\/root')!;
      expect(row).not.toBeNull();
      expect(row.contains(edit)).toBe(true);
      expect(row.textContent).toContain('Alice');
    });

    it('reveals root Edit on hover or keyboard focus of its row, by opacity', () => {
      renderCard({ comment: reviewer, isActive: true });
      const wrapper = screen.getByRole('button', { name: /^edit$/i }).parentElement!;
      expect(wrapper.className).toContain('opacity-0');
      expect(wrapper.className).toContain('group-hover/root:opacity-100');
      expect(wrapper.className).toContain('group-focus-within/root:opacity-100');
      expect(wrapper.className).toContain('transition-opacity');
      // `invisible` would drop it from the tab order, so focus could never
      // reveal it.
      expect(wrapper.className).not.toContain('invisible');
    });

    it('offers no root Edit on an agent-initiated comment', () => {
      renderCard({ comment: { ...reviewer, agentInitiated: true }, isActive: true });
      expect(screen.queryByRole('button', { name: /^edit$/i })).toBeNull();
    });

    it('offers no root Edit on a resolved comment', async () => {
      renderCard({ comment: resolvedReviewer, isActive: true }, { enableResolve: true });
      await waitFor(() => expect(screen.queryByText('Resolved')).toBeTruthy());
      expect(screen.queryByRole('button', { name: /^edit$/i })).toBeNull();
    });

    it('opens the comment editor from root Edit without activating the card', () => {
      const onRequestCommentEdit = vi.fn();
      const onActivate = vi.fn();
      renderCard({ comment: reviewer, isActive: true, onRequestCommentEdit, onActivate });
      fireEvent.click(screen.getByRole('button', { name: /^edit$/i }));
      expect(onRequestCommentEdit).toHaveBeenCalledWith('cmt_1');
      expect(onActivate).not.toHaveBeenCalled();
    });

    it('keeps the anchor repair buttons visible on a selected card too', () => {
      renderCard({
        comment: { ...reviewer, anchorStale: true, recoveredAnchor: 'The replacement text' },
        isActive: true,
        onReanchorToSelection: vi.fn(),
      });
      const keep = screen.getByRole('button', { name: 'Keep this anchor' });
      expect(keep.closest('.opacity-0')).toBeNull();
    });
  });

  describe('the thread bar', () => {
    const threadBar = (container: HTMLElement) =>
      container.querySelector<HTMLElement>('[data-thread-bar]');

    it('is the last element of a selected card, under a full-width hairline', async () => {
      const { container } = renderCard({ comment: withReplies, isActive: true });
      await screen.findByText('Looks right.');
      const bar = threadBar(container)!;
      expect((container.firstChild as HTMLElement).lastElementChild).toBe(bar);
      expect(bar.className).toContain('border-t');
      expect(bar.className).toContain('border-border-subtle');
    });

    it('is absent from an unselected card', () => {
      const { container } = renderCard({ comment: reviewer, onResolve: vi.fn() });
      expect(threadBar(container)).toBeNull();
    });

    it('Resolve calls onResolve, without activating the card', async () => {
      const onResolve = vi.fn();
      const onActivate = vi.fn();
      renderCard({ comment: reviewer, isActive: true, onResolve, onActivate });
      fireEvent.click(await screen.findByRole('button', { name: 'Resolve' }));
      expect(onResolve).toHaveBeenCalledWith('cmt_1');
      expect(onActivate).not.toHaveBeenCalled();
    });

    it('puts Resolve on the left and the trash on the right', () => {
      const { container } = renderCard({ comment: reviewer, isActive: true, onResolve: vi.fn() });
      const bar = threadBar(container)!;
      const resolve = screen.getByRole('button', { name: 'Resolve' });
      const trash = screen.getByRole('button', { name: 'Delete' });
      expect(bar.firstElementChild!.contains(resolve)).toBe(true);
      expect(bar.lastElementChild!.contains(trash)).toBe(true);
    });

    it('keeps the trash on the right when there is no Resolve', () => {
      const { container } = renderCard({ comment: reviewer, isActive: true });
      const bar = threadBar(container)!;
      const trash = screen.getByRole('button', { name: 'Delete' });
      expect(bar.lastElementChild!.contains(trash)).toBe(true);
      expect(bar.lastElementChild!.className).toContain('ml-auto');
    });

    it('shows Reopen on a resolved card and calls onUnresolve', async () => {
      const onUnresolve = vi.fn();
      renderCard(
        { comment: resolvedReviewer, isActive: true, onUnresolve, onResolve: vi.fn() },
        { enableResolve: true },
      );
      fireEvent.click(await screen.findByRole('button', { name: 'Reopen' }));
      expect(onUnresolve).toHaveBeenCalledWith('cmt_1');
      expect(screen.queryByRole('button', { name: 'Resolve' })).toBeNull();
    });

    it('labels the trash "Delete thread" when the comment has replies', async () => {
      const onDelete = vi.fn();
      renderCard({ comment: withReplies, isActive: true, onDelete });
      const trash = await screen.findByRole('button', { name: 'Delete thread' });
      expect(trash.getAttribute('title')).toBe('Delete thread');
      fireEvent.click(trash);
      expect(onDelete).toHaveBeenCalledWith('cmt_1');
    });

    it('labels the trash "Delete" when there are no replies', () => {
      const onDelete = vi.fn();
      renderCard({ comment: reviewer, isActive: true, onDelete });
      const trash = screen.getByRole('button', { name: 'Delete' });
      expect(trash.getAttribute('title')).toBe('Delete');
      fireEvent.click(trash);
      expect(onDelete).toHaveBeenCalledWith('cmt_1');
    });

    it('keeps the trash but drops Resolve when the resolve workflow is off', async () => {
      renderCard(
        { comment: reviewer, isActive: true, onResolve: vi.fn(), onUnresolve: vi.fn() },
        { enableResolve: false },
      );
      await waitFor(() => expect(screen.queryByRole('button', { name: 'Resolve' })).toBeNull());
      expect(screen.queryByRole('button', { name: 'Reopen' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeNull();
    });

    it('shows no Resolve when the surface wires no resolve handler', () => {
      renderCard({ comment: reviewer, isActive: true });
      expect(screen.queryByRole('button', { name: 'Resolve' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeNull();
    });

    it.each([
      ['the comment editor', { mode: 'comment-edit', token: 1 }],
      ['a reply editor', { mode: 'reply-edit', replyId: 'r1', token: 1 }],
      ['the reply composer', { mode: 'reply-compose', token: 1 }],
    ] as const)('is hidden while %s is open', (_name, editor) => {
      const { container } = renderCard({
        comment: withReplies,
        isActive: true,
        onResolve: vi.fn(),
        editor,
      });
      expect(threadBar(container)).toBeNull();
      expect(screen.queryByRole('button', { name: 'Resolve' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Delete thread' })).toBeNull();
    });
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
