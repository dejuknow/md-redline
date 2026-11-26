// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KeyboardShortcutsPanel } from './KeyboardShortcutsPanel';

function renderPanel() {
  render(<KeyboardShortcutsPanel open onClose={() => {}} resolveEnabled />);
}

function rowKeys(label: string): string {
  const row = screen.getByText(label).parentElement!;
  return row.querySelector('kbd')?.textContent ?? '';
}

describe('KeyboardShortcutsPanel', () => {
  afterEach(() => {
    cleanup();
    delete window.__mdrDesktop;
  });

  it('leaves out the tab keys in a browser, which keeps them for its own tabs', () => {
    renderPanel();
    expect(screen.queryByText('Tabs')).toBeNull();
    expect(screen.queryByText('New tab')).toBeNull();
    expect(screen.queryByText('Close tab')).toBeNull();
    expect(screen.queryByText('Reopen closed tab')).toBeNull();
    // The rest of the panel is unchanged.
    expect(screen.getByText('Previous tab')).toBeTruthy();
  });

  it('lists New tab, Close tab and Reopen closed tab inside the desktop app', () => {
    window.__mdrDesktop = true;
    renderPanel();
    expect(screen.getByText('Tabs')).toBeTruthy();
    // jsdom's navigator is not a Mac, so the keys read Ctrl, as on Windows and Linux.
    expect(rowKeys('New tab')).toBe('Ctrl+T');
    expect(rowKeys('Close tab')).toBe('Ctrl+W');
    expect(rowKeys('Reopen closed tab')).toBe('Ctrl+Shift+T');
    expect(rowKeys('Show next tab')).toBe('Ctrl+Tab');
    expect(rowKeys('Show previous tab')).toBe('Ctrl+Shift+Tab');
    expect(rowKeys('Go to tab by position')).toBe('Ctrl+1-8');
    expect(rowKeys('Go to last tab')).toBe('Ctrl+9');
    // Zoom lives in the macOS app's View menu; jsdom is not a Mac.
    expect(screen.queryByText('Zoom in')).toBeNull();
  });

  it('lists the zoom keys only in the macOS desktop app, whose View menu has them', () => {
    window.__mdrDesktop = true;
    const platform = vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
    try {
      renderPanel();
      expect(screen.getByText('Zoom')).toBeTruthy();
      expect(screen.getByText('Zoom in')).toBeTruthy();
      expect(screen.getByText('Actual size')).toBeTruthy();
    } finally {
      platform.mockRestore();
    }
  });
});
