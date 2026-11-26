// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import { DocStrip } from './DocStrip';
import { getPrimaryModifierLabel } from '../lib/platform';

// jsdom has no layout, so the strip's measured width is driven directly.
let measuredWidth = 1000;
vi.mock('../hooks/useElementNarrowerThan', () => ({
  useElementNarrowerThan: (_ref: unknown, px: number) => measuredWidth > 0 && measuredWidth < px,
}));

const mod = getPrimaryModifierLabel();

beforeEach(() => {
  measuredWidth = 1000;
});
afterEach(cleanup);

function renderStrip(overrides: Partial<React.ComponentProps<typeof DocStrip>> = {}) {
  const props: React.ComponentProps<typeof DocStrip> = {
    tabs: <div data-testid="tabs-slot">tabs</div>,
    viewMode: 'rendered',
    onViewModeChange: vi.fn(),
    hasDiffSnapshot: true,
    diffEnabled: false,
    diffChunkCount: 0,
    onDiffToggle: vi.fn(),
    searchActive: false,
    onSearch: vi.fn(),
    onCopyDocument: vi.fn(),
    copyFeedback: false,
    comments: <button type="button" data-testid="comments-slot" />,
    ...overrides,
  };
  return { props, ...render(<DocStrip {...props} />) };
}

describe('DocStrip', () => {
  it('carries data-doc-strip on its root and renders the tabs slot', () => {
    const { container } = renderStrip();
    const root = container.firstElementChild as HTMLElement;
    expect(root.hasAttribute('data-doc-strip')).toBe(true);
    expect(within(root).getByTestId('tabs-slot')).toBeTruthy();
  });

  it('shows no document controls with no file open, only the tabs slot', () => {
    renderStrip({ hasDocument: false });
    expect(document.querySelector('[data-doc-strip]')).toBeTruthy();
    expect(screen.queryByTestId('panel-toolbar')).toBeNull();
  });

  it('renders the view toggle titled "View raw markdown" in rendered mode and "Switch to rendered view" in raw mode', () => {
    const onViewModeChange = vi.fn();
    const { rerender, props } = renderStrip({ onViewModeChange });
    fireEvent.click(screen.getByTitle('View raw markdown'));
    expect(onViewModeChange).toHaveBeenCalledWith('raw');
    expect(screen.queryByTitle('Switch to rendered view')).toBeNull();

    rerender(<DocStrip {...props} viewMode="raw" />);
    expect(screen.queryByTitle('View raw markdown')).toBeNull();
    fireEvent.click(screen.getByTitle('Switch to rendered view'));
    expect(onViewModeChange).toHaveBeenLastCalledWith('rendered');
  });

  it('Diff lives in the strip\'s menu, titled "Show diff" / "Hide diff" and disabled without a snapshot', () => {
    const onDiffToggle = vi.fn();
    const { rerender, props } = renderStrip({ onDiffToggle });
    const openMenu = () => fireEvent.click(screen.getByRole('button', { name: 'View options' }));
    openMenu();
    const show = within(screen.getByRole('menu')).getByTitle('Show diff') as HTMLButtonElement;
    expect(show.disabled).toBe(false);
    expect(show.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(show);
    expect(onDiffToggle).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).toBeNull();

    rerender(<DocStrip {...props} diffEnabled diffChunkCount={3} />);
    openMenu();
    const hide = within(screen.getByRole('menu')).getByTitle('Hide diff');
    expect(hide.getAttribute('aria-checked')).toBe('true');
    expect(within(hide).getByText('3')).toBeTruthy();
    openMenu();

    rerender(<DocStrip {...props} hasDiffSnapshot={false} />);
    openMenu();
    const disabled = screen.getByTitle(
      'Show diff. Available after a handoff, or once an agent saves a copy before editing.',
    ) as HTMLButtonElement;
    expect(disabled.disabled).toBe(true);
  });

  it('search button has aria-label and title "Find in document (⌘+F)"', () => {
    const onSearch = vi.fn();
    renderStrip({ onSearch });
    const label = `Find in document (${mod}+F)`;
    const btn = screen.getByTitle(label);
    expect(btn.getAttribute('aria-label')).toBe(label);
    fireEvent.click(btn);
    expect(onSearch).toHaveBeenCalledTimes(1);
  });

  it('copy keeps data-testid "copy-button", sits in the menu and titles "Copied!" while copyFeedback', () => {
    const onCopyDocument = vi.fn();
    const { rerender, props } = renderStrip({ onCopyDocument });
    expect(screen.queryByTestId('copy-button')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'View options' }));
    const copy = screen.getByTestId('copy-button');
    expect(copy.getAttribute('title')).toBe('Copy document (comment markers stripped)');
    expect(copy.getAttribute('aria-label')).toBe('Copy document without comment markers');
    fireEvent.click(copy);
    // The menu closes on the click, so App confirms with a toast.
    expect(onCopyDocument).toHaveBeenCalledWith(true);

    rerender(<DocStrip {...props} copyFeedback />);
    fireEvent.click(screen.getByRole('button', { name: 'View options' }));
    expect(screen.getByTestId('copy-button').getAttribute('title')).toBe('Copied!');
  });

  it('renders the comments button, then Hand off last, in the controls group', () => {
    renderStrip({ handOff: <button type="button" data-testid="handoff-slot" /> });
    const group = screen.getByTestId('panel-toolbar');
    const comments = within(group).getByTestId('comments-slot');
    const handOff = within(group).getByTestId('handoff-slot');
    expect(
      comments.compareDocumentPosition(handOff) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(group.lastElementChild?.contains(handOff)).toBe(true);
  });

  it('the controls group carries data-testid "panel-toolbar"', () => {
    renderStrip();
    const group = screen.getByTestId('panel-toolbar');
    expect(within(group).getByTitle('View raw markdown')).toBeTruthy();
    expect(within(group).getByRole('button', { name: 'View options' })).toBeTruthy();
  });

  it('when its measured width is under 600px, view, diff and copy move into a "View" menu button (aria-label "View options") and search plus comments stay visible', () => {
    measuredWidth = 599;
    renderStrip();
    expect(screen.queryByTitle('View raw markdown')).toBeNull();
    expect(screen.queryByTitle('Show diff')).toBeNull();
    expect(screen.queryByTestId('copy-button')).toBeNull();
    expect(screen.getByTitle(`Find in document (${mod}+F)`)).toBeTruthy();
    expect(screen.getByTestId('comments-slot')).toBeTruthy();

    const viewBtn = screen.getByLabelText('View options');
    expect(viewBtn.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(viewBtn);
    expect(viewBtn.getAttribute('aria-expanded')).toBe('true');
    const menu = screen.getByRole('menu');
    expect(within(menu).getByTitle('View raw markdown')).toBeTruthy();
    expect(within(menu).getByTitle('Show diff')).toBeTruthy();
    expect(within(menu).getByTestId('copy-button')).toBeTruthy();
  });

  it('Escape closes the View menu and goes no further, so the find bar stays open', () => {
    measuredWidth = 599;
    renderStrip();
    const outer = vi.fn();
    document.addEventListener('keydown', outer);
    try {
      const viewBtn = screen.getByRole('button', { name: 'View options' });
      fireEvent.click(viewBtn);
      expect(screen.getByRole('menu')).toBeTruthy();
      fireEvent.keyDown(viewBtn, { key: 'Escape' });
      expect(screen.queryByRole('menu')).toBeNull();
      expect(outer).not.toHaveBeenCalled();

      // Closed, the menu no longer claims the key.
      fireEvent.keyDown(viewBtn, { key: 'Escape' });
      expect(outer).toHaveBeenCalledTimes(1);
    } finally {
      document.removeEventListener('keydown', outer);
    }
  });

  it('closes the View menu when focus moves outside it, as when the palette opens', () => {
    measuredWidth = 599;
    renderStrip();
    fireEvent.click(screen.getByRole('button', { name: 'View options' }));
    expect(screen.getByRole('menu')).toBeTruthy();
    const input = document.createElement('input');
    document.body.appendChild(input);
    try {
      fireEvent.focusIn(input);
      expect(screen.queryByRole('menu')).toBeNull();
    } finally {
      input.remove();
    }
  });

  it('leaves Escape to another overlay that is open, such as the command palette', () => {
    measuredWidth = 599;
    renderStrip();
    const palette = document.createElement('div');
    palette.setAttribute('data-overlay', '');
    const outer = vi.fn();
    document.addEventListener('keydown', outer);
    try {
      fireEvent.click(screen.getByRole('button', { name: 'View options' }));
      document.body.appendChild(palette);
      fireEvent.keyDown(document.body, { key: 'Escape' });
      // The palette's own listener gets the key.
      expect(outer).toHaveBeenCalledTimes(1);
    } finally {
      palette.remove();
      document.removeEventListener('keydown', outer);
    }
  });

  it('the diff pending dot is neutral, not crimson', () => {
    renderStrip({ diffPending: true });
    const dot = screen
      .getByRole('button', { name: 'View options' })
      .querySelector('.animate-pulse');
    expect(dot).toBeTruthy();
    expect(dot!.className).not.toContain('bg-primary');
  });

  it('at 600px or more the view switch stays inline and the menu holds only diff and copy', () => {
    measuredWidth = 600;
    renderStrip();
    expect(screen.getByTitle('View raw markdown')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'View options' }));
    const menu = screen.getByRole('menu');
    expect(within(menu).queryByTitle('View raw markdown')).toBeNull();
    expect(within(menu).getByTitle('Show diff')).toBeTruthy();
    expect(within(menu).getByTestId('copy-button')).toBeTruthy();
  });
});
