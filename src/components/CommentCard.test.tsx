// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
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

beforeEach(() => {
  fetchPreferences.mockReset();
  fetchPreferences.mockResolvedValue({ settings: {} });
});

afterEach(() => {
  cleanup();
});

const baseComment: MdComment = {
  id: 'cmt_1',
  anchor: 'Hello world',
  text: 'This needs revision.',
  author: 'Claude',
  timestamp: new Date().toISOString(),
  agentInitiated: true,
};

function renderCard(props: Partial<Parameters<typeof CommentCard>[0]> = {}) {
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
