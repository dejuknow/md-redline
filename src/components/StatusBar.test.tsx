// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { StatusBar } from './StatusBar';

afterEach(cleanup);

type Props = React.ComponentProps<typeof StatusBar>;

function renderBar(overrides: Partial<Props> = {}) {
  const props: Props = {
    filePath: '~/specs/payments/spec.md',
    error: null,
    errorKind: null,
    accessRequestShown: false,
    onTrustFolder: vi.fn(),
    isLoading: false,
    focusMode: false,
    onExitFocus: vi.fn(),
    onOpenPalette: vi.fn(),
    onOpenShortcuts: vi.fn(),
    ...overrides,
  };
  return { props, ...render(<StatusBar {...props} />) };
}

describe('StatusBar', () => {
  it('shows the active file path, truncating with the full path in its title', () => {
    renderBar();
    const path = screen.getByText('~/specs/payments/spec.md');
    expect(path.classList.contains('truncate')).toBe(true);
    expect(path.getAttribute('title')).toBe('~/specs/payments/spec.md');
  });

  it('the Commands hint is a button with aria-label "Command palette" that keeps the selection', () => {
    const { props } = renderBar();
    const chip = screen.getByRole('button', { name: 'Command palette' });
    expect(chip.textContent).toContain('Commands');
    // The palette offers to copy a painted selection, the same as the shortcut does.
    expect(chip.hasAttribute('data-preserve-selection')).toBe(true);
    fireEvent.click(chip);
    expect(props.onOpenPalette).toHaveBeenCalledTimes(1);
  });

  it('the Shortcuts hint opens the shortcuts panel', () => {
    const { props } = renderBar();
    fireEvent.click(screen.getByRole('button', { name: 'Keyboard shortcuts' }));
    expect(props.onOpenShortcuts).toHaveBeenCalledTimes(1);
  });

  it('access denied with retained content: "Lost access to this file\'s folder" and the allow button', () => {
    const { props } = renderBar({
      error: 'Access denied: cannot resolve path',
      errorKind: 'access-denied',
    });
    expect(screen.getByText('Lost access to this file’s folder')).toBeTruthy();
    expect(screen.queryByText(/cannot resolve path/)).toBeNull();
    fireEvent.click(screen.getByTestId('toolbar-allow-access'));
    expect(props.onTrustFolder).toHaveBeenCalledTimes(1);
  });

  it('says nothing about a refusal while the permission card shows', () => {
    renderBar({
      error: 'Access denied: path outside allowed directories',
      errorKind: 'access-denied',
      accessRequestShown: true,
    });
    expect(screen.queryByTestId('toolbar-allow-access')).toBeNull();
    expect(screen.queryByText(/lost access/i)).toBeNull();
  });

  it('shows a generic error with its full text in a title, and Loading', () => {
    renderBar({ error: 'File not found', errorKind: 'generic', isLoading: true });
    expect(screen.getByText('File not found').getAttribute('title')).toBe('File not found');
    expect(screen.getByText('Loading...')).toBeTruthy();
  });

  it('focus mode: "Exit focus" carries data-focus-chip and title "Exit focus mode"', () => {
    const { props, rerender } = renderBar();
    expect(document.querySelector('[data-focus-chip]')).toBeNull();
    rerender(<StatusBar {...props} focusMode />);
    const exit = screen.getByRole('button', { name: 'Exit focus' });
    expect(exit.hasAttribute('data-focus-chip')).toBe(true);
    expect(exit.getAttribute('title')).toBe('Exit focus mode');
    fireEvent.click(exit);
    expect(props.onExitFocus).toHaveBeenCalledTimes(1);
  });
});
