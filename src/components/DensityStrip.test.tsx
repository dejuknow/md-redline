// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import { DensityStrip } from './DensityStrip';
import type { CommentTick } from '../hooks/useCommentTicks';

const TICKS: CommentTick[] = [
  { id: 'a', y01: 0.1, kind: 'open', label: 'An open comment' },
  { id: 'b', y01: 0.5, kind: 'resolved', label: 'A resolved comment' },
  { id: 'c', y01: 0.9, kind: 'ask', label: 'An agent question' },
];

afterEach(() => cleanup());

describe('DensityStrip', () => {
  it('renders one positioned tick per comment with the kind color', () => {
    render(<DensityStrip ticks={TICKS} onJump={vi.fn()} />);
    const strip = document.querySelector('[data-density-strip]') as HTMLElement;
    expect(strip).toBeTruthy();
    const ticks = strip.querySelectorAll('[data-tick-id]');
    expect(ticks.length).toBe(3);
    const open = strip.querySelector('[data-tick-id="a"]') as HTMLElement;
    // jsdom's CSSOM has no grammar for the CSS min() function: it drops the
    // whole `top` declaration instead of normalizing it, so neither
    // style.top nor the serialized style attribute ever contain the value.
    // Assert on the data-tick-top-pct mirror instead, same intent: the tick
    // sits at the 10% proportional position.
    expect(open.getAttribute('data-tick-top-pct')).toContain('10');
    expect(open.style.backgroundColor).toBe('var(--theme-comment-underline)');
    const ask = strip.querySelector('[data-tick-id="c"]') as HTMLElement;
    expect(ask.style.backgroundColor).toBe('var(--theme-accent)');
    expect(ask.title).toBe('An agent question');
  });

  it('fires onJump with the comment id', () => {
    const onJump = vi.fn();
    render(<DensityStrip ticks={TICKS} onJump={onJump} />);
    fireEvent.click(document.querySelector('[data-tick-id="b"]')!);
    expect(onJump).toHaveBeenCalledWith('b');
  });

  it('renders nothing without ticks', () => {
    render(<DensityStrip ticks={[]} onJump={vi.fn()} />);
    expect(document.querySelector('[data-density-strip]')).toBeNull();
  });
});
