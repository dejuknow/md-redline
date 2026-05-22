// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

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

describe('SettingsPanel', () => {
  it('renders General settings when open=true', () => {
    renderPanel({ open: true });
    expect(screen.getByText(/general/i)).not.toBeNull();
  });

  it('does not render Agent reviews section (removed)', () => {
    renderPanel({ open: true });
    expect(screen.queryByText(/agent reviews/i)).toBeNull();
  });
});

