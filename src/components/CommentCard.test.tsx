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
    agentQuestion: false,
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

describe('CommentCard — fire-and-forget agent comment (agentInitiated=true, agentQuestion=false)', () => {
  it('does not render "Awaiting your reply" banner', () => {
    renderCard({ agentQuestion: false });
    expect(screen.queryByText(/awaiting your reply/i)).toBeNull();
  });

  it('renders the Delete action', () => {
    renderCard({ isActive: true, agentQuestion: false });
    // Delete button is rendered; it has aria-label="Delete"
    const deleteBtn = screen.queryByRole('button', { name: /delete/i });
    expect(deleteBtn).not.toBeNull();
  });

  it('renders the Reply action when active', () => {
    renderCard({ isActive: true, agentQuestion: false });
    const replyBtn = screen.queryByRole('button', { name: /reply/i });
    expect(replyBtn).not.toBeNull();
  });
});

describe('CommentCard — agent question (agentQuestion=true)', () => {
  it('renders "Awaiting your reply" banner', () => {
    renderCard({ agentQuestion: true });
    expect(screen.getByText(/awaiting your reply/i)).not.toBeNull();
  });

  it('does not render the Delete action', () => {
    renderCard({ isActive: true, agentQuestion: true });
    expect(screen.queryByRole('button', { name: /delete/i })).toBeNull();
  });
});
