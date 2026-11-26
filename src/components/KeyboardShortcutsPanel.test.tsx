// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
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
  });
});
