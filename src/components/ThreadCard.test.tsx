// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
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
import { ThreadCard } from './ThreadCard';
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

const baseThreadProps = {
  thread: {
    id: 'cmt_1',
    anchor: 'Hello world',
    text: 'This needs revision.',
    author: 'Claude',
    timestamp: new Date().toISOString(),
    agentInitiated: true,
  } as MdComment,
  active: false,
  onSelect: vi.fn(),
  onReply: vi.fn(),
  onDelete: vi.fn(),
  onEdit: vi.fn(),
  onEditReply: vi.fn(),
  onDeleteReply: vi.fn(),
};

describe('ThreadCard wrapper', () => {
  it('thread wrapper suppresses the native outline and uses the ring on keyboard focus', () => {
    render(createElement(ThreadCard, baseThreadProps), { wrapper: AllProviders });
    const wrapper = document.querySelector('[data-comment-card-id]')!;
    expect(wrapper.className).toContain('outline-none');
    expect(wrapper.className).toContain('focus-visible:ring-2');
  });
});
