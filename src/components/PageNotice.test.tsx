// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import { PageNotice, PAGE_LOADING_DELAY_MS } from './PageNotice';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

type Props = React.ComponentProps<typeof PageNotice>;

function renderNotice(overrides: Partial<Props> = {}) {
  const props: Props = {
    error: null,
    errorKind: null,
    accessRequestShown: false,
    onTrustFolder: vi.fn(),
    isLoading: false,
    ...overrides,
  };
  return { props, ...render(<PageNotice {...props} />) };
}

describe('PageNotice', () => {
  it('renders nothing when there is nothing to say', () => {
    renderNotice();
    expect(document.querySelector('[data-page-notices]')).toBeNull();
    // The live region is there, empty, ready to announce.
    expect(screen.getByRole('status').textContent).toBe('');
  });

  it('access denied with retained content: "Lost access to this file\'s folder" and the allow button', () => {
    const { props } = renderNotice({
      error: 'Access denied: cannot resolve path',
      errorKind: 'access-denied',
    });
    expect(screen.getByText('Lost access to this file’s folder')).toBeTruthy();
    expect(screen.queryByText(/cannot resolve path/)).toBeNull();
    fireEvent.click(screen.getByTestId('toolbar-allow-access'));
    expect(props.onTrustFolder).toHaveBeenCalledTimes(1);
  });

  it('says nothing about a refusal while the permission card shows', () => {
    renderNotice({
      error: 'Access denied: path outside allowed directories',
      errorKind: 'access-denied',
      accessRequestShown: true,
    });
    expect(document.querySelector('[data-page-notices]')).toBeNull();
  });

  it('shows a generic error with its full text in a title', () => {
    renderNotice({ error: 'File not found', errorKind: 'generic' });
    expect(screen.getByText('File not found').getAttribute('title')).toBe('File not found');
  });

  it('shows Loading only once a load has run long enough to notice', () => {
    vi.useFakeTimers();
    const { props, rerender } = renderNotice({ isLoading: true });
    expect(document.querySelector('[data-page-notices]')).toBeNull();
    act(() => {
      vi.advanceTimersByTime(PAGE_LOADING_DELAY_MS);
    });
    expect(screen.getByText('Loading...')).toBeTruthy();
    rerender(<PageNotice {...props} isLoading={false} />);
    expect(document.querySelector('[data-page-notices]')).toBeNull();
  });
});
