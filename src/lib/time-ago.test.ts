import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { timeAgo } from './time-ago';

describe('timeAgo', () => {
  // Pin "now" so the relative buckets are deterministic.
  const NOW = new Date('2026-04-06T18:00:00.000Z').getTime();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns "just now" for a timestamp under one minute ago', () => {
    expect(timeAgo('2026-04-06T17:59:30.000Z')).toBe('just now');
  });

  it('returns minutes for a timestamp under an hour ago', () => {
    expect(timeAgo('2026-04-06T17:55:00.000Z')).toBe('5m ago');
    expect(timeAgo('2026-04-06T17:01:00.000Z')).toBe('59m ago');
  });

  it('returns hours for a timestamp under a day ago', () => {
    expect(timeAgo('2026-04-06T17:00:00.000Z')).toBe('1h ago');
    expect(timeAgo('2026-04-06T07:00:00.000Z')).toBe('11h ago');
  });

  it('returns days for a timestamp under a week ago', () => {
    expect(timeAgo('2026-04-04T18:00:00.000Z')).toBe('2d ago');
    expect(timeAgo('2026-03-31T18:00:00.000Z')).toBe('6d ago');
  });

  it('falls back to a locale date string for older timestamps', () => {
    const result = timeAgo('2025-12-25T00:00:00.000Z');
    expect(result).not.toBeNull();
    expect(result).not.toBe('just now');
    expect(result).not.toMatch(/m ago|h ago|d ago/);
  });

  // Defensive cases — these are the bug the prompt change exposed.
  // Agents now omit the `timestamp` field entirely, and we don't want
  // "Invalid Date" leaking into the UI before SSE backfill catches up.
  it('returns null for undefined input', () => {
    expect(timeAgo(undefined)).toBeNull();
  });

  it('returns null for null input', () => {
    expect(timeAgo(null)).toBeNull();
  });

  it('returns null for empty string input', () => {
    expect(timeAgo('')).toBeNull();
  });

  it('returns null for unparseable timestamp strings', () => {
    expect(timeAgo('not-a-date')).toBeNull();
    expect(timeAgo('2026-13-99')).toBeNull();
  });
});
