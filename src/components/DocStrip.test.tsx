// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import { DocStrip } from './DocStrip';
import { getPrimaryModifierLabel } from '../lib/platform';

// jsdom has no layout, so the strip's measured width is driven directly.
let measuredWidth = 1000;
vi.mock('../hooks/useElementWidth', () => ({
  useElementWidth: () => measuredWidth,
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
    commentsSurfaceVisible: false,
    openCommentCount: 0,
    onToggleComments: vi.fn(),
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

  it('diff toggle is titled "Show diff" / "Hide diff" and disabled without a snapshot, with the same disabled title PanelToolbar used', () => {
    const onDiffToggle = vi.fn();
    const { rerender, props } = renderStrip({ onDiffToggle });
    const show = screen.getByTitle('Show diff') as HTMLButtonElement;
    expect(show.disabled).toBe(false);
    expect(show.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(show);
    expect(onDiffToggle).toHaveBeenCalledTimes(1);

    rerender(<DocStrip {...props} diffEnabled diffChunkCount={3} />);
    const hide = screen.getByTitle('Hide diff');
    expect(hide.getAttribute('aria-pressed')).toBe('true');
    expect(within(hide).getByText('3')).toBeTruthy();

    rerender(<DocStrip {...props} hasDiffSnapshot={false} />);
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

  it('copy button keeps data-testid "copy-button" and title "Copied!" while copyFeedback', () => {
    const onCopyDocument = vi.fn();
    const { rerender, props } = renderStrip({ onCopyDocument });
    const copy = screen.getByTestId('copy-button');
    expect(copy.getAttribute('title')).toBe('Copy document (comment markers stripped)');
    expect(copy.getAttribute('aria-label')).toBe('Copy document without comment markers');
    fireEvent.click(copy);
    expect(onCopyDocument).toHaveBeenCalledTimes(1);

    rerender(<DocStrip {...props} copyFeedback />);
    expect(screen.getByTestId('copy-button').getAttribute('title')).toBe('Copied!');
  });

  it('comments toggle has title "Toggle comments rail (⌘+\\)", aria-pressed reflects commentsSurfaceVisible, and shows openCommentCount only while the rail is hidden', () => {
    const onToggleComments = vi.fn();
    const title = `Toggle comments rail (${mod}+\\)`;
    const { rerender, props } = renderStrip({ onToggleComments, openCommentCount: 4 });

    // Rail hidden: no rail controls, so the toggle carries the count.
    let toggle = screen.getByTitle(title);
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    expect(within(toggle).getByText('4')).toBeTruthy();
    fireEvent.click(toggle);
    expect(onToggleComments).toHaveBeenCalledTimes(1);

    // Rail shown: its controls already say "N open", so the toggle drops it.
    rerender(
      <DocStrip
        {...props}
        commentsSurfaceVisible
        railControls={<div data-testid="rail-controls">4 open</div>}
      />,
    );
    toggle = screen.getByTitle(title);
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(within(toggle).queryByText('4')).toBeNull();
  });

  it('railControls render first in the controls group when provided', () => {
    renderStrip({ railControls: <div data-testid="rail-controls">rail</div> });
    const group = screen.getByTestId('panel-toolbar');
    expect(group.firstElementChild?.getAttribute('data-testid')).toBe('rail-controls');
  });

  it('the controls group carries data-testid "panel-toolbar"', () => {
    renderStrip({ trailing: <button type="button">Hand off</button> });
    const group = screen.getByTestId('panel-toolbar');
    expect(within(group).getByTitle('View raw markdown')).toBeTruthy();
    expect(within(group).getByTestId('copy-button')).toBeTruthy();
    expect(within(group).getByText('Hand off')).toBeTruthy();
  });

  it('when its measured width is under 600px, view, diff and copy move into a "View" menu button (aria-label "View options") and search plus comments stay visible', () => {
    measuredWidth = 599;
    renderStrip();
    expect(screen.queryByTitle('View raw markdown')).toBeNull();
    expect(screen.queryByTitle('Show diff')).toBeNull();
    expect(screen.queryByTestId('copy-button')).toBeNull();
    expect(screen.getByTitle(`Find in document (${mod}+F)`)).toBeTruthy();
    expect(screen.getByTitle(`Toggle comments rail (${mod}+\\)`)).toBeTruthy();

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

  it('Copy in the View menu asks for a toast, since the menu closes on the click; the inline button does not', () => {
    const onCopyDocument = vi.fn();
    measuredWidth = 599;
    const { unmount } = renderStrip({ onCopyDocument });
    fireEvent.click(screen.getByLabelText('View options'));
    fireEvent.click(within(screen.getByRole('menu')).getByTestId('copy-button'));
    expect(onCopyDocument).toHaveBeenCalledWith(true);
    expect(screen.queryByRole('menu')).toBeNull();
    unmount();

    measuredWidth = 1000;
    onCopyDocument.mockClear();
    renderStrip({ onCopyDocument });
    fireEvent.click(screen.getByTestId('copy-button'));
    expect(onCopyDocument).toHaveBeenCalledWith();
  });

  it('the diff pending dot is neutral, not crimson', () => {
    renderStrip({ diffPending: true });
    const dot = screen.getByTitle('Show diff').querySelector('.animate-pulse');
    expect(dot).toBeTruthy();
    expect(dot!.className).not.toContain('bg-primary');
  });

  it('at 600px or more the controls stay inline with no View menu', () => {
    measuredWidth = 600;
    renderStrip();
    expect(screen.queryByLabelText('View options')).toBeNull();
    expect(screen.getByTitle('View raw markdown')).toBeTruthy();
  });
});
