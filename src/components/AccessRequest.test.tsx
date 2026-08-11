// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { AccessRequest } from './AccessRequest';

afterEach(cleanup);

const DEEP_DIR =
  '/private/tmp/claude-503/-Users-dennisju-dev-buela-product-management-designer-jd/1a7f55ac-00f8-4f15-a8b2-4b820badf2a2/scratchpad';

describe('AccessRequest', () => {
  it('leads with the folder name, not the absolute path', () => {
    render(<AccessRequest dir={DEEP_DIR} onAllow={vi.fn()} />);
    expect(screen.getByText('scratchpad')).toBeTruthy();
    // The raw path never appears in full; it is elided and kept in the tooltip
    // so a four-line wall of path cannot come back.
    expect(screen.queryByText(DEEP_DIR)).toBeNull();
    expect(screen.getByTitle(DEEP_DIR)).toBeTruthy();
  });

  it('tilde-shortens the displayed path', () => {
    render(
      <AccessRequest dir="/Users/dennisju/dev/notes" homeDir="/Users/dennisju" onAllow={vi.fn()} />,
    );
    expect(screen.getByTitle('/Users/dennisju/dev/notes').textContent).toBe('~/dev/notes');
  });

  it('calls onAllow when the button is clicked', () => {
    const onAllow = vi.fn();
    render(<AccessRequest dir={DEEP_DIR} onAllow={onAllow} />);
    fireEvent.click(screen.getByTestId('access-request-allow'));
    expect(onAllow).toHaveBeenCalledTimes(1);
  });

  it('disables the button and says what it is waiting on while pending', () => {
    render(<AccessRequest dir={DEEP_DIR} pending onAllow={vi.fn()} />);
    const button = screen.getByTestId('access-request-allow') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.textContent).toMatch(/waiting/i);
  });

  it('renders the panel variant without the page copy', () => {
    render(<AccessRequest dir={DEEP_DIR} variant="panel" onAllow={vi.fn()} />);
    expect(screen.getByTestId('access-request-panel')).toBeTruthy();
    expect(screen.queryByTestId('access-request')).toBeNull();
    expect(screen.queryByText(/system dialog/i)).toBeNull();
    expect(screen.getByTestId('access-request-panel-allow')).toBeTruthy();
  });

  it('gives each variant its own button testid, since both mount together', () => {
    // The document card and the explorer panel are routinely refused by the
    // same folder and render at once; a shared testid makes every unscoped
    // Playwright lookup a strict-mode violation.
    render(
      <>
        <AccessRequest dir={DEEP_DIR} onAllow={vi.fn()} />
        <AccessRequest dir={DEEP_DIR} variant="panel" onAllow={vi.fn()} />
      </>,
    );
    expect(screen.getAllByTestId('access-request-allow')).toHaveLength(1);
    expect(screen.getAllByTestId('access-request-panel-allow')).toHaveLength(1);
  });

  it('still asks when the folder cannot be named', () => {
    // `?file=~` has no derivable parent. Suppressing the card there left a
    // blank sheet with no message and no button.
    render(<AccessRequest dir={null} onAllow={vi.fn()} />);
    expect(screen.getByTestId('access-request')).toBeTruthy();
    expect(screen.getByTestId('access-request-allow')).toBeTruthy();
  });

  it('says the grant missed instead of repeating itself word for word', () => {
    render(<AccessRequest dir={DEEP_DIR} grantMissed onAllow={vi.fn()} />);
    expect(screen.getByText(/does not cover this file/i)).toBeTruthy();
    expect(screen.queryByText(/Opens a system dialog/i)).toBeNull();
  });

  it('announces itself, since it replaced the toolbar strip that used to', () => {
    render(<AccessRequest dir={DEEP_DIR} onAllow={vi.fn()} />);
    const card = screen.getByTestId('access-request');
    expect(card.getAttribute('role')).toBe('status');
    expect(card.getAttribute('aria-live')).toBe('polite');
  });
});
