// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { AppHeader } from './AppHeader';
import { UNFOLD_HYSTERESIS, type HeaderMeasure } from '../lib/header-fit';

// The header measures its items to decide whether the review row folds. jsdom
// has no layout, so the measurements come from here; the decision itself is
// the real nextHeaderFit.
let mockMeasure: HeaderMeasure | null | ((compact: boolean) => HeaderMeasure) = null;
vi.mock('../lib/header-fit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/header-fit')>();
  return {
    ...actual,
    // A function reads the layout on screen, the way the real one does.
    measureHeader: () =>
      typeof mockMeasure === 'function'
        ? mockMeasure(document.querySelector('[data-compact="true"]') !== null)
        : mockMeasure,
  };
});

beforeEach(() => {
  mockMeasure = null;
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
    // Never wider than its cap. Beside a review row it gives way to the row
    // (down to the least width the header's measurement keeps for it).
    expect(notices.className).toMatch(/\bmax-w-\[40%\]/);
    expect(notices.className).not.toMatch(/\bshrink-0\b/);
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

  it('focus mode with a review: the file name gives way to any notice, Exit focus stays', () => {
    const banner = () => <div data-testid="review-banner">Agent is waiting</div>;
    const fileNameEl = () => header().querySelector('[data-focus-file-name]');
    const { rerender } = renderHeader({ focusMode: true, renderBanner: banner, handOff: null });
    expect(fileNameEl()?.textContent).toBe('spec.md');

    const withNotice = (notice: Partial<React.ComponentProps<typeof AppHeader>>) => (
      <AppHeader
        fileName="spec.md"
        folderPath="~/specs/payments"
        error={null}
        errorKind={null}
        accessRequestShown={false}
        onTrustFolder={vi.fn()}
        isLoading={false}
        renderBanner={banner}
        handOff={null}
        focusMode
        onExitFocus={vi.fn()}
        onOpenPalette={vi.fn()}
        {...notice}
      />
    );
    for (const notice of [
      { error: 'Save failed: disk full', errorKind: 'generic' as const },
      { error: 'Access denied', errorKind: 'access-denied' as const },
      { isLoading: true },
    ]) {
      rerender(withNotice(notice));
      expect(header().querySelector('[data-header-notices]')).toBeTruthy();
      expect(fileNameEl()).toBeNull();
      expect(screen.getByRole('button', { name: 'Exit focus' })).toBeTruthy();
      expect(screen.getByTestId('review-banner')).toBeTruthy();
    }
    rerender(withNotice({}));
    expect(fileNameEl()?.textContent).toBe('spec.md');
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

  const row = document.createElement('div');
  const measured = (m: Partial<HeaderMeasure>): HeaderMeasure => ({
    width: 1000,
    minContent: 800,
    floorContent: 800,
    actions: 400,
    rowNeed: 560,
    row,
    ...m,
  });
  const bannerHeader = (renderBanner: (compact: boolean) => React.ReactNode) => (
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
    />
  );

  it('folds the review row when its content does not fit, and unfolds only past the hysteresis', () => {
    // Pinned through the argument: renderBanner receives `compact` and the
    // element it returns carries it, so both the call and the result are seen.
    const renderBanner = vi.fn((compact: boolean) => (
      <div data-testid="review-banner" data-compact={String(compact)} />
    ));
    // The wide row needs 1050px in a 1000px header, so it folds; folded, its
    // actions measure 260px, 140px less than the 400px wide.
    let width = 1000;
    mockMeasure = (compact) =>
      compact
        ? measured({ width, minContent: 910, actions: 260 })
        : measured({ width, minContent: 1050, actions: 400 });
    const { rerender } = render(bannerHeader(renderBanner));
    expect(renderBanner).toHaveBeenLastCalledWith(true);
    expect(screen.getByTestId('review-banner').getAttribute('data-compact')).toBe('true');

    // Wide would fit at 910 + 140 = 1050px, but that is inside the hysteresis.
    width = 1060;
    rerender(bannerHeader(renderBanner));
    expect(renderBanner).toHaveBeenLastCalledWith(true);

    width = 1050 + UNFOLD_HYSTERESIS;
    rerender(bannerHeader(renderBanner));
    expect(renderBanner).toHaveBeenLastCalledWith(false);
    expect(screen.getByTestId('review-banner').getAttribute('data-compact')).toBe('false');
  });

  it('keeps the review row from narrowing past its least width, short of pushing the chip out', () => {
    const renderBanner = () => <div data-testid="review-banner" />;
    mockMeasure = measured({ width: 1000, minContent: 800, rowNeed: 560 });
    const { rerender } = render(bannerHeader(renderBanner));
    const slot = header().querySelector('[data-header-banner]') as HTMLElement;
    expect(slot.style.minWidth).toBe('560px');
    // 100px short even folded with the notice at its least: the row gives up
    // those 100px, not the chip.
    mockMeasure = measured({ width: 1000, minContent: 1300, floorContent: 1100, rowNeed: 560 });
    rerender(bannerHeader(renderBanner));
    expect(slot.style.minWidth).toBe('460px');
  });

  it('treats an unmeasured header (no layout) as wide', () => {
    const renderBanner = vi.fn(() => <div data-testid="review-banner" />);
    mockMeasure = measured({ width: 0, minContent: 5000 });
    renderHeader({ renderBanner, handOff: null });
    expect(renderBanner).toHaveBeenLastCalledWith(false);
  });

  it('shows Hand off beside the review row when given one', () => {
    renderHeader({
      renderBanner: () => <div data-testid="review-banner">Agent is waiting</div>,
      handOff: <button type="button">Hand off</button>,
    });
    const actions = header().querySelector('[data-header-actions]') as HTMLElement;
    expect(actions.classList.contains('shrink-0')).toBe(true);
    expect(actions.contains(screen.getByRole('button', { name: 'Hand off' }))).toBe(true);
    expect(screen.getByTestId('review-banner')).toBeTruthy();
  });
});
