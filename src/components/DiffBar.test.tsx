// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { DiffBar } from './DiffBar';

afterEach(cleanup);

function renderBar(overrides: Partial<React.ComponentProps<typeof DiffBar>> = {}) {
  const props: React.ComponentProps<typeof DiffBar> = {
    diffEnabled: false,
    diffChunkCount: 0,
    onDiffPrev: vi.fn(),
    onDiffNext: vi.fn(),
    onMarkReviewed: vi.fn(),
    onDiffToggle: vi.fn(),
    ...overrides,
  };
  return { props, ...render(<DiffBar {...props} />) };
}

describe('DiffBar', () => {
  it('renders Mark reviewed with the overlay off when chunks exist', () => {
    const onMarkReviewed = vi.fn();
    const { container } = renderBar({ diffChunkCount: 2, onMarkReviewed });
    expect(container.querySelector('[data-diff-bar]')).toBeTruthy();
    fireEvent.click(screen.getByTitle('Mark reviewed'));
    expect(onMarkReviewed).toHaveBeenCalledTimes(1);
  });

  it('renders nothing with the overlay off and zero chunks', () => {
    const { container } = renderBar();
    expect(container.firstChild).toBeNull();
  });

  it('renders with the overlay on and zero chunks, without Mark reviewed', () => {
    const { container } = renderBar({ diffEnabled: true });
    expect(container.querySelector('[data-diff-bar]')).toBeTruthy();
    expect(screen.queryByTitle('Mark reviewed')).toBeNull();
  });

  it('shows the reference label and prev/next only while diffEnabled', () => {
    const onDiffPrev = vi.fn();
    const onDiffNext = vi.fn();
    const { rerender, props } = renderBar({
      diffChunkCount: 2,
      referenceLabel: 'Since last handoff',
      onDiffPrev,
      onDiffNext,
    });
    expect(screen.queryByTestId('diff-reference-label')).toBeNull();
    expect(screen.queryByTitle('Previous change')).toBeNull();
    expect(screen.queryByTitle('Next change')).toBeNull();

    rerender(<DiffBar {...props} diffEnabled />);
    expect(screen.getByTestId('diff-reference-label').textContent).toBe('Since last handoff');
    fireEvent.click(screen.getByTitle('Previous change'));
    fireEvent.click(screen.getByTitle('Next change'));
    expect(onDiffPrev).toHaveBeenCalledTimes(1);
    expect(onDiffNext).toHaveBeenCalledTimes(1);
  });
});
