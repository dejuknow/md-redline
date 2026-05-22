// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

// Mock preferences-client so SettingsContext doesn't try to hit the network
const fetchPreferences = vi.fn();
const savePreferencesToDisk = vi.fn();

vi.mock('../lib/preferences-client', () => ({
  fetchPreferences: (...args: unknown[]) => fetchPreferences(...args),
  savePreferencesToDisk: (...args: unknown[]) => savePreferencesToDisk(...args),
}));

// Mock next-themes (used by useThemePersistence)
vi.mock('next-themes', () => ({
  useTheme: () => ({ theme: 'system', setTheme: vi.fn() }),
}));

import { createElement, type ReactNode } from 'react';
import { SettingsProvider } from '../contexts/SettingsContext';
import { ThemePersistenceProvider } from '../contexts/ThemePersistenceContext';
import { SettingsPanel } from './SettingsPanel';

function AllProviders({ children }: { children: ReactNode }) {
  return createElement(
    ThemePersistenceProvider,
    null,
    createElement(SettingsProvider, null, children),
  );
}

function renderPanel(props: Partial<Parameters<typeof SettingsPanel>[0]> = {}) {
  const defaults: Parameters<typeof SettingsPanel>[0] = {
    open: true,
    onClose: vi.fn(),
    author: '',
    onAuthorChange: vi.fn(),
  };
  return render(
    createElement(SettingsPanel, { ...defaults, ...props }),
    { wrapper: AllProviders },
  );
}

beforeEach(() => {
  fetchPreferences.mockReset();
  savePreferencesToDisk.mockReset();
  // Simulate immediate hydration with default settings
  fetchPreferences.mockResolvedValue({ settings: {} });
});

afterEach(() => {
  cleanup();
});

describe('SettingsPanel — Agent reviews section', () => {
  it('renders the "Agent reviews" section heading in the General tab', () => {
    renderPanel();
    expect(screen.getByText(/agent reviews/i)).not.toBeNull();
  });

  it('renders the defaultAgentReviewWait toggle with correct label', () => {
    renderPanel();
    const toggle = screen.getByRole('switch', { name: /wait for my response by default/i });
    expect(toggle).not.toBeNull();
  });

  it('reflects defaultAgentReviewWait: false (off) by default', () => {
    renderPanel();
    const toggle = screen.getByRole('switch', { name: /wait for my response by default/i });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
  });

  it('calls updateDefaultAgentReviewWait with true when toggled on', async () => {
    renderPanel();
    const toggle = screen.getByRole('switch', { name: /wait for my response by default/i });
    // Toggle off → on
    fireEvent.click(toggle);
    // After click, aria-checked should flip to true
    expect(toggle.getAttribute('aria-checked')).toBe('true');
  });

  it('toggles back to false after being clicked twice', async () => {
    renderPanel();
    const toggle = screen.getByRole('switch', { name: /wait for my response by default/i });
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-checked')).toBe('false');
  });
});
