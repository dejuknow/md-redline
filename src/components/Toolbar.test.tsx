// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { Toolbar } from './Toolbar';

afterEach(cleanup);

function renderToolbar(overrides: Partial<React.ComponentProps<typeof Toolbar>> = {}) {
  return render(
    <Toolbar
      error={null}
      errorKind={null}
      accessRequestShown={false}
      onTrustFolder={vi.fn()}
      isLoading={false}
      commentsSurfaceVisible={false}
      author="Dennis"
      onAuthorChange={vi.fn()}
      onToggleSidebar={vi.fn()}
      {...overrides}
    />,
  );
}

describe('Toolbar status', () => {
  it('reports a generic error', () => {
    renderToolbar({ error: 'File not found', errorKind: 'generic' });
    expect(screen.getByText('File not found')).toBeTruthy();
  });

  it('says nothing about access-denied while the document area shows the card', () => {
    renderToolbar({
      error: 'Access denied: path outside allowed directories',
      errorKind: 'access-denied',
      accessRequestShown: true,
    });
    expect(screen.queryByTestId('toolbar-allow-access')).toBeNull();
    expect(screen.queryByText(/access denied/i)).toBeNull();
  });

  it('reports access-denied when the card declined to take over', () => {
    // A tab that kept its content through a failed reload: the card must not
    // cover the document, so the toolbar is the only surface left to report it.
    const onTrustFolder = vi.fn();
    renderToolbar({
      error: 'Access denied: cannot resolve path',
      errorKind: 'access-denied',
      accessRequestShown: false,
      onTrustFolder,
    });
    expect(screen.getByText(/lost access/i)).toBeTruthy();
    fireEvent.click(screen.getByTestId('toolbar-allow-access'));
    expect(onTrustFolder).toHaveBeenCalledTimes(1);
  });

  it('never shows the raw server message for access-denied', () => {
    renderToolbar({
      error: 'Access denied: path outside allowed directories',
      errorKind: 'access-denied',
    });
    expect(screen.queryByText(/outside allowed directories/)).toBeNull();
  });

  it('shows the loading indicator', () => {
    renderToolbar({ isLoading: true });
    expect(screen.getByText('Loading...')).toBeTruthy();
  });
});
