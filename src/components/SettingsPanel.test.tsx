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

describe('SettingsPanel: hidden comment prefixes', () => {
  it('sits after Comment Max Length, because its prefix list is long', () => {
    renderPanel({ open: true });
    const maxLength = screen.getByText('Comment Max Length');
    const renderHtml = screen.getByText('Render HTML comments');
    // Node.compareDocumentPosition: 4 = FOLLOWING. Asserting order rather than
    // an index keeps this alive when other settings are added between them.
    expect(maxLength.compareDocumentPosition(renderHtml) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it('hides the whole prefixes section when Render HTML comments is off', () => {
    renderPanel({ open: true });
    // Default is on, so the section is there to begin with -- without this the
    // assertion below would pass against a section that never renders at all.
    expect(screen.queryByText('Hidden prefixes')).not.toBeNull();

    fireEvent.click(screen.getByRole('switch', { name: /render html comments/i }));

    expect(screen.queryByText('Hidden prefixes')).toBeNull();
    expect(screen.queryByText('markdownlint')).toBeNull();
    expect(screen.queryByLabelText('Add a hidden prefix')).toBeNull();
  });

  it('starts every group collapsed and expands one on click', () => {
    renderPanel({ open: true });

    const group = screen.getByRole('button', { name: 'markdownlint' });
    expect(group.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('switch', { name: 'Toggle markdownlint-disable' })).toBeNull();
    // Control: the group's own tri-state switch IS rendered while collapsed, so
    // the null above is the rows being hidden and not the section being absent.
    expect(
      screen.queryByRole('switch', { name: 'Toggle all markdownlint prefixes' }),
    ).not.toBeNull();

    fireEvent.click(group);

    expect(group.getAttribute('aria-expanded')).toBe('true');
    expect(screen.queryByRole('switch', { name: 'Toggle markdownlint-disable' })).not.toBeNull();
    // Collapsing is independent per group: Prettier stays shut.
    expect(screen.queryByRole('switch', { name: 'Toggle prettier-ignore' })).toBeNull();

    fireEvent.click(group);
    expect(screen.queryByRole('switch', { name: 'Toggle markdownlint-disable' })).toBeNull();
  });

  it('gives a group header and its prefix rows the same right edge', () => {
    renderPanel({ open: true });
    const group = screen.getByRole('button', { name: 'markdownlint' });
    fireEvent.click(group);

    // Both rows end on the same padding, so the switches line up.
    const headerRow = group.parentElement!;
    const prefixRow = screen
      .getByRole('switch', { name: 'Toggle markdownlint-disable' })
      .closest('div')!;
    expect(headerRow.className).toContain('pr-2');
    expect(prefixRow.className).toContain('pr-2');
    expect(prefixRow.className).toContain('pl-6');
    // ...and the names still indent relative to the group.
    expect(headerRow.className).toContain('pl-2');
  });

  it('puts every switch row on one pitch, collapsed or expanded', () => {
    renderPanel({ open: true });

    // A fixed row height with no vertical padding or margin keeps one pitch
    // between switches, in both states, since collapsing removes rows mid-run.
    const rowOf = (name: string) => screen.getByRole('switch', { name }).parentElement!;

    const collapsedRows = [
      rowOf('Toggle all Prettier prefixes'),
      rowOf('Toggle all markdownlint prefixes'),
    ];
    for (const row of collapsedRows) {
      expect(row.className).toContain('h-8');
      expect(row.className).not.toMatch(/\bpy-/);
      expect(row.className).not.toMatch(/\bmt-/);
    }

    fireEvent.click(screen.getByRole('button', { name: 'markdownlint' }));

    const expandedRows = [
      ...collapsedRows,
      rowOf('Toggle markdownlint-disable'),
      rowOf('Toggle markdownlint-configure-file'),
    ];
    for (const row of expandedRows) {
      expect(row.className).toContain('h-8');
      expect(row.className).not.toMatch(/\bpy-/);
    }

    // Nothing between the rows may add space either: a gap on a wrapper is what
    // made the header-to-row distance differ from the row-to-row distance.
    const section = screen.getByText('Hidden prefixes').parentElement!;
    for (const el of section.querySelectorAll('div')) {
      expect(el.className).not.toMatch(/\bspace-y-[1-9]/);
    }
  });

  it('keeps a custom prefix remove button on the switch right edge', () => {
    renderPanel({ open: true });

    fireEvent.change(screen.getByLabelText('Add a hidden prefix'), {
      target: { value: 'my-tool-ignore' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    const custom = screen.getByRole('button', { name: 'Custom' });
    fireEvent.click(custom);

    const remove = screen.getByRole('button', { name: 'Remove my-tool-ignore' });
    // w-9 is ToggleSwitch's width; without the wrapper the narrower x button
    // floats right of every switch above it.
    expect(remove.parentElement!.className).toContain('w-9');
    expect(within(remove.closest('div')!).getByText('my-tool-ignore')).not.toBeNull();
  });
});
