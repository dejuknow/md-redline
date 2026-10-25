// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent, screen } from '@testing-library/react';
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

// jsdom has no ResizeObserver; CommentCard (wrapped by ThreadCard) observes
// its text node to re-check clamping on resize.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
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

describe('ThreadCard keyboard reach', () => {
  // An unselected card holds no button, so without a tab stop of its own no
  // key could reach it, or the actions that appear once it is selected.
  const wrapperOf = () => document.querySelector<HTMLElement>('[data-comment-card-id]')!;

  it('is a tab stop', () => {
    render(createElement(ThreadCard, baseThreadProps), { wrapper: AllProviders });
    expect(wrapperOf().tabIndex).toBe(0);
  });

  it.each([
    ['Enter', 'Enter'],
    ['Space', ' '],
  ])('selects the card on %s while the card itself has focus', (_name, key) => {
    const onSelect = vi.fn();
    render(createElement(ThreadCard, { ...baseThreadProps, onSelect }), {
      wrapper: AllProviders,
    });
    const notPrevented = fireEvent.keyDown(wrapperOf(), { key });
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith('cmt_1');
    // Space would otherwise scroll the page.
    expect(notPrevented).toBe(false);
  });

  it('ignores other keys on the card', () => {
    const onSelect = vi.fn();
    render(createElement(ThreadCard, { ...baseThreadProps, onSelect }), {
      wrapper: AllProviders,
    });
    for (const key of ['Tab', 'a', 'Escape', 'ArrowDown']) {
      const notPrevented = fireEvent.keyDown(wrapperOf(), { key });
      expect(notPrevented).toBe(true);
    }
    expect(onSelect).not.toHaveBeenCalled();
  });

  it.each([
    ['Enter', 'Enter'],
    ['Space', ' '],
  ])('leaves %s to a button inside the card', (_name, key) => {
    const onSelect = vi.fn();
    render(createElement(ThreadCard, { ...baseThreadProps, active: true, onSelect }), {
      wrapper: AllProviders,
    });
    // The key bubbles up from the button, so the card must not also select.
    const notPrevented = fireEvent.keyDown(
      screen.getByRole('button', { name: 'Write a reply...' }),
      { key },
    );
    expect(onSelect).not.toHaveBeenCalled();
    expect(notPrevented).toBe(true);
  });
});
