// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act, waitFor } from '@testing-library/react';
import { createElement, useEffect, useRef } from 'react';

const fetchPreferences = vi.fn();
vi.mock('../lib/preferences-client', () => ({
  fetchPreferences: (...args: unknown[]) => fetchPreferences(...args),
  savePreferencesToDisk: vi.fn(),
}));
vi.mock('next-themes', () => ({
  useTheme: () => ({ theme: 'system', setTheme: vi.fn() }),
}));

import { SettingsProvider } from '../contexts/SettingsContext';
import { CardDraftsContext } from '../contexts/CardDraftsContext';
import { useCardDrafts, type CardDraftsApi } from '../hooks/useCardDrafts';
import { CommentCard } from './CommentCard';
import { ThreadCard } from './ThreadCard';
import type { MdComment } from '../types';

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  fetchPreferences.mockReset();
  fetchPreferences.mockResolvedValue({ settings: { enableResolve: false } });
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const note: MdComment = {
  id: 'c1',
  anchor: 'anchor',
  text: 'Original note',
  author: 'User',
  timestamp: '2026-01-01T00:00:00.000Z',
  replies: [],
};

// The harness's store, for tests that check what it kept.
const held: { store: CardDraftsApi | null } = { store: null };
const onReply = vi.fn();
const onEdit = vi.fn();

/** The app's store around one card, which can be taken away and brought back. */
function Harness({ file, comment, shown }: { file: string; comment: MdComment; shown: boolean }) {
  const tokenRef = useRef(0);
  const { api } = useCardDrafts({
    file,
    comments: [comment],
    requestedEditor: null,
    onEditorBack: () => {},
  });
  useEffect(() => {
    held.store = api;
  });
  const open = (mode: 'reply-compose' | 'comment-edit') => (commentId: string) =>
    api?.setEditor({ mode, commentId, token: ++tokenRef.current });
  return createElement(
    SettingsProvider,
    null,
    createElement(
      CardDraftsContext.Provider,
      { value: api },
      shown
        ? createElement(CommentCard, {
            comment,
            isActive: true,
            editor: api?.editor?.commentId === comment.id ? api.editor : null,
            onActivate: vi.fn(),
            onDelete: vi.fn(),
            onEdit,
            onReply,
            onEditReply: vi.fn(),
            onDeleteReply: vi.fn(),
            onRequestCommentEdit: open('comment-edit'),
            onRequestReplyCompose: open('reply-compose'),
            onRequestReplyEdit: vi.fn(),
            onCloseEditor: () => api?.setEditor(null),
          })
        : null,
    ),
  );
}

function setup() {
  const view = render(createElement(Harness, { file: 'a.md', comment: note, shown: true }));
  const show = (shown: boolean, comment = note) =>
    view.rerender(createElement(Harness, { file: 'a.md', comment, shown }));
  return { ...view, show };
}

const replyField = () => screen.getByPlaceholderText('Write a reply...') as HTMLTextAreaElement;

describe('CommentCard with the card draft store (#213)', () => {
  it('a reply typed, unmounted and mounted again comes back with its caret, focused', async () => {
    const view = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Write a reply...' }));
    fireEvent.change(replyField(), { target: { value: 'half a thought' } });
    replyField().setSelectionRange(4, 4);
    fireEvent.select(replyField());

    view.show(false);
    expect(screen.queryByPlaceholderText('Write a reply...')).toBeNull();
    view.show(true);

    expect(replyField().value).toBe('half a thought');
    await waitFor(() => expect(document.activeElement).toBe(replyField()));
    expect(replyField().selectionStart).toBe(4);
  });

  it('a reply coming back does not take the keyboard from another field', () => {
    const view = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Write a reply...' }));
    fireEvent.change(replyField(), { target: { value: 'kept' } });
    view.show(false);

    const other = document.createElement('input');
    document.body.appendChild(other);
    other.focus();
    view.show(true);
    expect(replyField().value).toBe('kept');
    expect(document.activeElement).toBe(other);
    other.remove();
  });

  it('Cancel drops the draft: opening the field again starts empty', () => {
    const view = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Write a reply...' }));
    fireEvent.change(replyField(), { target: { value: 'never mind' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    view.show(false);
    view.show(true);
    expect(screen.queryByPlaceholderText('Write a reply...')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Write a reply...' }));
    expect(replyField().value).toBe('');
  });

  it('Escape drops the draft too', () => {
    setup();
    fireEvent.click(screen.getByRole('button', { name: 'Write a reply...' }));
    fireEvent.change(replyField(), { target: { value: 'never mind' } });
    fireEvent.keyDown(replyField(), { key: 'Escape' });
    expect(held.store?.readDraft({ mode: 'reply-compose', commentId: 'c1' })).toBeNull();
  });

  it('sending the reply drops the draft', () => {
    setup();
    fireEvent.click(screen.getByRole('button', { name: 'Write a reply...' }));
    fireEvent.change(replyField(), { target: { value: 'sent' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reply' }));
    expect(onReply).toHaveBeenCalledWith('c1', 'sent');
    expect(held.store?.readDraft({ mode: 'reply-compose', commentId: 'c1' })).toBeNull();
  });

  it('an edit opened again on its kept draft saves the draft', () => {
    const view = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const field = () => screen.getByDisplayValue(/Original note/) as HTMLTextAreaElement;
    fireEvent.change(field(), { target: { value: 'Original note, reworded' } });
    view.show(false);
    view.show(true);
    expect(field().value).toBe('Original note, reworded');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onEdit).toHaveBeenCalledWith('c1', 'Original note, reworded');
    expect(held.store?.readDraft({ mode: 'comment-edit', commentId: 'c1' })).toBeNull();
  });

  it('an edit whose comment changed under it is not shown, and opening Edit starts from the new text', () => {
    const view = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByDisplayValue('Original note'), {
      target: { value: 'My rewording' },
    });
    const changed = { ...note, text: 'Changed elsewhere' };
    act(() => view.show(true, changed));
    expect(screen.queryByDisplayValue('My rewording')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(screen.getByDisplayValue('Changed elsewhere')).toBeTruthy();
  });

  it('an editor shown again on a card that stayed mounted does not take the keyboard from another field', () => {
    const view = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Write a reply...' }));
    fireEvent.change(replyField(), { target: { value: 'kept through a resolve' } });
    // Resolved elsewhere: the editor goes, the card stays.
    act(() => view.show(true, { ...note, status: 'resolved' }));
    expect(screen.queryByPlaceholderText('Write a reply...')).toBeNull();

    const other = document.createElement('input');
    document.body.appendChild(other);
    other.focus();
    // Reopened: the editor comes back on its draft, and leaves focus alone.
    act(() => view.show(true, note));
    expect(replyField().value).toBe('kept through a resolve');
    expect(document.activeElement).toBe(other);
    other.remove();
  });

  it('a card keeping its own editor (popover, Mermaid panel) leaves the store alone', () => {
    function PopoverLike() {
      const { api } = useCardDrafts({
        file: 'a.md',
        comments: [note],
        requestedEditor: null,
        onEditorBack: () => {},
      });
      useEffect(() => {
        held.store = api;
      });
      return createElement(
        SettingsProvider,
        null,
        createElement(
          CardDraftsContext.Provider,
          { value: api },
          createElement(ThreadCard, {
            thread: note,
            active: true,
            onSelect: vi.fn(),
            onReply: vi.fn(),
            onDelete: vi.fn(),
            onEdit: vi.fn(),
            onEditReply: vi.fn(),
            onDeleteReply: vi.fn(),
          }),
        ),
      );
    }
    render(createElement(PopoverLike));
    fireEvent.click(screen.getByRole('button', { name: 'Write a reply...' }));
    fireEvent.change(replyField(), { target: { value: 'popover text' } });
    expect(held.store?.readDraft({ mode: 'reply-compose', commentId: 'c1' })).toBeNull();
    // Nothing reopens this editor after a switch, so the tab shortcut stays off in it.
    expect(replyField().hasAttribute('data-card-editor')).toBe(false);
  });
});
