// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { AppHeader } from './AppHeader';

// The header measures itself to pick the banner's compact layout. jsdom has no
// layout, so the width comes from here.
let mockWidth = 0;
vi.mock('../hooks/useElementWidth', () => ({
  useElementWidth: () => mockWidth,
}));

beforeEach(() => {
  mockWidth = 0;
});
afterEach(cleanup);

function renderHeader(overrides: Partial<React.ComponentProps<typeof AppHeader>> = {}) {
  return render(
    <AppHeader
      fileName="spec.md"
      folderPath="~/specs/payments"
      error={null}
      errorKind={null}
      accessRequestShown={false}
      onTrustFolder={vi.fn()}
      isLoading={false}
      renderBanner={null}
      handOff={<button type="button">Hand off</button>}
      focusMode={false}
      onExitFocus={vi.fn()}
      onOpenPalette={vi.fn()}
      {...overrides}
    />,
  );
}

const header = () => document.querySelector('[data-app-header]') as HTMLElement;

describe('AppHeader', () => {
  it('no session: shows file name and folder path, and the hand off slot', () => {
    renderHeader();
    expect(screen.getByText('spec.md')).toBeTruthy();
    expect(screen.getByText('~/specs/payments')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Hand off' })).toBeTruthy();
  });

  it('with banner: renders the banner and hides the hand off slot', () => {
    renderHeader({
      renderBanner: () => <div data-testid="review-banner">Agent is waiting</div>,
      handOff: null,
    });
    expect(screen.getByTestId('review-banner')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Hand off' })).toBeNull();
    // The banner owns the status, so the file name is not repeated beside it.
    expect(screen.queryByText('~/specs/payments')).toBeNull();
  });

  it('access denied with retained content: shows "Lost access to this file\'s folder" and the toolbar-allow-access button', () => {
    // A tab that kept its content through a failed reload: the card must not
    // cover the document, so the header is the only surface left to report it.
    const onTrustFolder = vi.fn();
    renderHeader({
      error: 'Access denied: cannot resolve path',
      errorKind: 'access-denied',
      accessRequestShown: false,
      onTrustFolder,
    });
    expect(screen.getByText('Lost access to this file’s folder')).toBeTruthy();
    // Never the raw server message.
    expect(screen.queryByText(/cannot resolve path/)).toBeNull();
    fireEvent.click(screen.getByTestId('toolbar-allow-access'));
    expect(onTrustFolder).toHaveBeenCalledTimes(1);
  });

  it('access denied while the permission card is shown (accessRequestShown): no header allow button', () => {
    renderHeader({
      error: 'Access denied: path outside allowed directories',
      errorKind: 'access-denied',
      accessRequestShown: true,
    });
    expect(screen.queryByTestId('toolbar-allow-access')).toBeNull();
    expect(screen.queryByText(/access denied/i)).toBeNull();
    expect(screen.queryByText(/lost access/i)).toBeNull();
  });

  it('access denied during an active review: the allow button shows alongside the banner', () => {
    renderHeader({
      error: 'Access denied: cannot resolve path',
      errorKind: 'access-denied',
      accessRequestShown: false,
      renderBanner: () => <div data-testid="review-banner">Agent is waiting</div>,
      handOff: null,
    });
    expect(screen.getByTestId('review-banner')).toBeTruthy();
    expect(screen.getByTestId('toolbar-allow-access')).toBeTruthy();
    expect(screen.getByText('Lost access to this file’s folder')).toBeTruthy();
  });

  it('notices are capped, keep their full text in a title, and sit outside the shrinking status', () => {
    const long = 'File was modified externally. Reload to see changes. '.repeat(3).trim();
    const { rerender } = renderHeader({
      fileName: 'a-very-long-file-name-that-goes-on-and-on.md',
      error: long,
      errorKind: 'generic',
      renderBanner: () => <div data-testid="review-banner">Agent is waiting</div>,
      handOff: null,
    });
    let notices = header().querySelector('[data-header-notices]') as HTMLElement;
    // Never wider than its cap, and never squeezed by the row beside it.
    expect(notices.className).toMatch(/\bmax-w-\[40%\]/);
    expect(notices.className).toMatch(/\bshrink-0\b/);
    expect(screen.getByText(long).getAttribute('title')).toBe(long);

    rerender(
      <AppHeader
        fileName="a-very-long-file-name-that-goes-on-and-on.md"
        folderPath="~/a/deep/folder/that/goes/on/and/on"
        error="Access denied: cannot resolve path"
        errorKind="access-denied"
        accessRequestShown={false}
        onTrustFolder={vi.fn()}
        isLoading={false}
        renderBanner={null}
        handOff={null}
        focusMode={false}
        onExitFocus={vi.fn()}
        onOpenPalette={vi.fn()}
      />,
    );
    notices = header().querySelector('[data-header-notices]') as HTMLElement;
    // The file name and folder give way first: the notice is not inside the
    // status block they shrink in.
    const status = header().querySelector('[data-header-status]') as HTMLElement;
    expect(status.contains(notices)).toBe(false);
    expect(notices.className).toMatch(/\bshrink-0\b/);
    const lost = screen.getByText('Lost access to this file’s folder');
    expect(lost.getAttribute('title')).toBe('Lost access to this file’s folder');
  });

  it('generic error and loading text render as Toolbar did', () => {
    renderHeader({ error: 'File not found', errorKind: 'generic', isLoading: true });
    expect(screen.getByText('File not found')).toBeTruthy();
    expect(screen.getByText('Loading...')).toBeTruthy();
  });

  it('⌘K chip is a button with aria-label "Command palette" that calls onOpenPalette', () => {
    const onOpenPalette = vi.fn();
    renderHeader({ onOpenPalette });
    const chip = screen.getByRole('button', { name: 'Command palette' });
    expect(chip.textContent).toMatch(/K$/);
    // Clicking it must not drop a painted selection: the palette offers to
    // copy it, the same as the shortcut does.
    expect(chip.hasAttribute('data-preserve-selection')).toBe(true);
    fireEvent.click(chip);
    expect(onOpenPalette).toHaveBeenCalledTimes(1);
  });

  it('focus mode: shows "Exit focus" button with data-focus-chip and title "Exit focus mode" calling onExitFocus', () => {
    const onExitFocus = vi.fn();
    const { rerender } = renderHeader();
    expect(document.querySelector('[data-focus-chip]')).toBeNull();

    rerender(
      <AppHeader
        fileName="spec.md"
        folderPath="~/specs/payments"
        error={null}
        errorKind={null}
        accessRequestShown={false}
        onTrustFolder={vi.fn()}
        isLoading={false}
        renderBanner={null}
        handOff={null}
        focusMode
        onExitFocus={onExitFocus}
        onOpenPalette={vi.fn()}
      />,
    );
    const exit = screen.getByRole('button', { name: 'Exit focus' });
    expect(exit.hasAttribute('data-focus-chip')).toBe(true);
    expect(exit.getAttribute('title')).toBe('Exit focus mode');
    fireEvent.click(exit);
    expect(onExitFocus).toHaveBeenCalledTimes(1);
  });

  it('root carries data-app-header and adds --window-inset-left to its own left padding', () => {
    renderHeader();
    expect(header()).toBeTruthy();
    expect(header().style.paddingLeft).toBe('calc(var(--window-inset-left, 0px) + 0.25rem)');
  });

  it('long file name: status has min-w-0 and truncate; actions container has shrink-0', () => {
    const longName = `${'a-very-long-file-name-'.repeat(8)}.md`;
    renderHeader({ fileName: longName });
    const name = screen.getByText(longName);
    expect(name.classList.contains('truncate')).toBe(true);
    const status = header().querySelector('[data-header-status]') as HTMLElement;
    expect(status.contains(name)).toBe(true);
    expect(status.classList.contains('min-w-0')).toBe(true);
    const actions = header().querySelector('[data-header-actions]') as HTMLElement;
    expect(actions.classList.contains('shrink-0')).toBe(true);
    expect(actions.contains(screen.getByRole('button', { name: 'Hand off' }))).toBe(true);
  });

  it('calls renderBanner(true) when the measured width is under 900px and renderBanner(false) at 900px or more', () => {
    // Pinned through the argument: renderBanner receives `compact` and the
    // element it returns carries it, so both the call and the result are seen.
    const renderBanner = vi.fn((compact: boolean) => (
      <div data-testid="review-banner" data-compact={String(compact)} />
    ));
    mockWidth = 899;
    const { rerender } = renderHeader({ renderBanner, handOff: null });
    expect(renderBanner).toHaveBeenLastCalledWith(true);
    expect(screen.getByTestId('review-banner').getAttribute('data-compact')).toBe('true');

    mockWidth = 900;
    rerender(
      <AppHeader
        fileName="spec.md"
        folderPath="~/specs/payments"
        error={null}
        errorKind={null}
        accessRequestShown={false}
        onTrustFolder={vi.fn()}
        isLoading={false}
        renderBanner={renderBanner}
        handOff={null}
        focusMode={false}
        onExitFocus={vi.fn()}
        onOpenPalette={vi.fn()}
      />,
    );
    expect(renderBanner).toHaveBeenLastCalledWith(false);
    expect(screen.getByTestId('review-banner').getAttribute('data-compact')).toBe('false');
  });

  it('treats an unmeasured width (0) as wide', () => {
    const renderBanner = vi.fn(() => <div data-testid="review-banner" />);
    mockWidth = 0;
    renderHeader({ renderBanner, handOff: null });
    expect(renderBanner).toHaveBeenLastCalledWith(false);
  });
});
