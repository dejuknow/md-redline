// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';

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
  return render(createElement(SettingsPanel, { ...defaults, ...props }), { wrapper: AllProviders });
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

describe('SettingsPanel: hidden HTML comments', () => {
  /** The collapsed summary row, which doubles as the expand button. */
  const summary = () =>
    screen.getByRole('button', { name: /keep hidden: instructions for tools/i });
  const expand = () => fireEvent.click(summary());

  it('sits with the display settings, between Keep line breaks and Comment Max Length', () => {
    renderPanel({ open: true });
    const before = screen.getByText('Keep line breaks');
    const renderHtml = screen.getByText('Render HTML comments');
    const after = screen.getByText('Comment Max Length');
    // Node.compareDocumentPosition: order rather than an index, so settings
    // added elsewhere do not break this.
    const FOLLOWING = Node.DOCUMENT_POSITION_FOLLOWING;
    expect(before.compareDocumentPosition(renderHtml) & FOLLOWING).toBe(FOLLOWING);
    expect(renderHtml.compareDocumentPosition(after) & FOLLOWING).toBe(FOLLOWING);
  });

  it('starts collapsed to one summary row and expands on click', () => {
    renderPanel({ open: true });
    expect(summary().getAttribute('aria-expanded')).toBe('false');
    expect(summary().textContent).toContain('16 tools');
    expect(screen.queryByRole('checkbox', { name: 'Keep Vale comments hidden' })).toBeNull();

    expand();

    expect(summary().getAttribute('aria-expanded')).toBe('true');
    expect(
      (screen.getByRole('checkbox', { name: 'Keep Vale comments hidden' }) as HTMLInputElement)
        .checked,
    ).toBe(true);
  });

  it('hides the whole list when Render HTML comments is off', () => {
    renderPanel({ open: true });
    // Present to begin with, so the null below is the switch working.
    expect(summary()).not.toBeNull();

    fireEvent.click(screen.getByRole('switch', { name: /render html comments/i }));

    expect(
      screen.queryByRole('button', { name: /keep hidden: instructions for tools/i }),
    ).toBeNull();
  });

  it('counts an unticked tool out of the summary', () => {
    renderPanel({ open: true });
    expand();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Keep Vale comments hidden' }));

    expect(
      (screen.getByRole('checkbox', { name: 'Keep Vale comments hidden' }) as HTMLInputElement)
        .checked,
    ).toBe(false);
    expect(summary().textContent).toContain('15 of 16 tools');
  });

  it('adds, switches off, and removes your own words', () => {
    renderPanel({ open: true });
    expand();
    const own = () =>
      screen.getByRole('checkbox', { name: 'Keep your own words hidden' }) as HTMLInputElement;
    // No words yet: the checkbox holds the row's place but does nothing.
    expect(own().disabled).toBe(true);

    const input = screen.getByLabelText('Add a word to keep hidden');
    fireEvent.change(input, { target: { value: '  TODO  ' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(screen.getByRole('button', { name: 'Remove TODO' })).not.toBeNull();
    expect(own().disabled).toBe(false);
    expect(summary().textContent).toContain('1 of your own');

    fireEvent.click(own());
    expect(own().checked).toBe(false);
    expect(summary().textContent).not.toContain('of your own');

    fireEvent.click(screen.getByRole('button', { name: 'Remove TODO' }));
    expect(screen.queryByRole('button', { name: 'Remove TODO' })).toBeNull();
  });

  it('turns your own words back on when you add one', () => {
    renderPanel({ open: true });
    expand();
    const input = screen.getByLabelText('Add a word to keep hidden');
    fireEvent.change(input, { target: { value: 'TODO' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Keep your own words hidden' }));

    fireEvent.change(input, { target: { value: 'DRAFT' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(
      (screen.getByRole('checkbox', { name: 'Keep your own words hidden' }) as HTMLInputElement)
        .checked,
    ).toBe(true);
  });

  it('turns your own words back on when you re-add one already in the list', () => {
    renderPanel({ open: true });
    expand();
    const input = screen.getByLabelText('Add a word to keep hidden');
    fireEvent.change(input, { target: { value: 'TODO' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Keep your own words hidden' }));

    fireEvent.change(input, { target: { value: 'TODO' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(
      (screen.getByRole('checkbox', { name: 'Keep your own words hidden' }) as HTMLInputElement)
        .checked,
    ).toBe(true);
    expect(screen.getAllByRole('button', { name: 'Remove TODO' })).toHaveLength(1);
  });

  it('keeps a half-typed word as a draft when you leave the field, until you add it', () => {
    renderPanel({ open: true });
    expand();
    const input = screen.getByLabelText('Add a word to keep hidden') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'TOD' } });
    fireEvent.blur(input);

    expect(screen.queryByRole('button', { name: 'Remove TOD' })).toBeNull();
    expect(input.value).toBe('TOD');

    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.getByRole('button', { name: 'Remove TOD' })).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Add' })).toBeNull();
  });

  it("reads a per-word settings file from #124's first version", async () => {
    fetchPreferences.mockResolvedValue({
      settings: {
        hiddenCommentPrefixes: [
          { prefix: 'vale off', enabled: false },
          { prefix: 'vale on', enabled: false },
          { prefix: 'TODO', enabled: true },
        ],
      },
    });
    renderPanel({ open: true });

    expect(
      await screen.findByRole('button', { name: /15 of 16 tools, 1 of your own/i }),
    ).not.toBeNull();
    expand();
    expect(within(screen.getByText('Your own').parentElement!).getByText('TODO')).not.toBeNull();
  });
});
