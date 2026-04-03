// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolveSelection } from './selection-resolver';

// jsdom's Range doesn't implement getBoundingClientRect — stub it.
if (!Range.prototype.getBoundingClientRect) {
  Range.prototype.getBoundingClientRect = () =>
    ({
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
      toJSON: () => {},
    }) as DOMRect;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

function mockSelection(
  opts: {
    collapsed?: boolean;
    text?: string;
    range?: Range;
  } | null,
) {
  const sel = opts
    ? {
        isCollapsed: opts.collapsed ?? false,
        toString: () => opts.text ?? '',
        getRangeAt: () => opts.range!,
        rangeCount: opts.range ? 1 : 0,
      }
    : null;
  vi.spyOn(window, 'getSelection').mockReturnValue(sel as unknown as Selection);
}

describe('resolveSelection', () => {
  it('returns null when no selection', () => {
    mockSelection(null);
    const container = document.createElement('div');
    expect(resolveSelection(container)).toBeNull();
  });

  it('returns null when selection is collapsed', () => {
    mockSelection({ collapsed: true, text: '' });
    const container = document.createElement('div');
    expect(resolveSelection(container)).toBeNull();
  });

  it('returns null when text is less than 2 chars', () => {
    document.body.innerHTML = '<div id="root">A</div>';
    const container = document.getElementById('root')!;
    const textNode = container.firstChild!;

    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, 1);

    mockSelection({ text: 'A', range });
    expect(resolveSelection(container)).toBeNull();
  });

  it('returns correct contextBefore and contextAfter for a mid-document selection', () => {
    const content = 'The quick brown fox jumps over the lazy dog and then some more text follows';
    document.body.innerHTML = `<div id="root">${content}</div>`;
    const container = document.getElementById('root')!;
    const textNode = container.firstChild!;

    // Select "fox jumps"
    const selStart = content.indexOf('fox jumps');
    const selEnd = selStart + 'fox jumps'.length;

    const range = document.createRange();
    range.setStart(textNode, selStart);
    range.setEnd(textNode, selEnd);

    mockSelection({ text: 'fox jumps', range });

    const result = resolveSelection(container);
    expect(result).not.toBeNull();
    expect(result!.text).toBe('fox jumps');
    expect(result!.contextBefore).toBe(content.slice(Math.max(0, selStart - 40), selStart));
    expect(result!.contextAfter).toBe(content.slice(selEnd, selEnd + 40));
    expect(result!.offset).toBe(selStart);
  });

  it('handles leading whitespace in selection correctly', () => {
    const content = 'Hello World Goodbye';
    document.body.innerHTML = `<div id="root">${content}</div>`;
    const container = document.getElementById('root')!;
    const textNode = container.firstChild!;

    // Select "  World " (with leading/trailing spaces) — raw text includes spaces
    // The selection starts at index 5 (" World Goodbye" starts there)
    const rawText = '  World ';
    const selStart = 4; // "Hello" ends at 5, space starts at 5, so "  World " starts at 4? Let's be precise.
    // content = "Hello World Goodbye"
    //            01234567890123456789
    // Select from index 5 to 13 = " World G" — actually let's pick a cleaner example.

    // Simpler: content "Hello  World Goodbye"
    document.body.innerHTML = '<div id="root">Hello  World Goodbye</div>';
    const container2 = document.getElementById('root')!;
    const textNode2 = container2.firstChild!;

    // Select "  World" (positions 5-12) — raw has leading spaces, trim gives "World"
    const range = document.createRange();
    range.setStart(textNode2, 5);
    range.setEnd(textNode2, 12);

    mockSelection({ text: '  World', range });

    const result = resolveSelection(container2);
    expect(result).not.toBeNull();
    // Trimmed text should be "World"
    expect(result!.text).toBe('World');
    // Leading whitespace is 2 chars, so adjustedStart = 5 + 2 = 7
    // contextBefore should be content[max(0, 7-40) .. 7] = "Hello  "
    expect(result!.contextBefore).toBe('Hello  ');
    // selEnd = 7 + 5 = 12, contextAfter = content[12..52] = " Goodbye"
    expect(result!.contextAfter).toBe(' Goodbye');
    expect(result!.offset).toBe(7);
  });
});
