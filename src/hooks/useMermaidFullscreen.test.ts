// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useMermaidFullscreen } from './useMermaidFullscreen';

describe('useMermaidFullscreen', () => {
  it('opens with a source and reports it as active', () => {
    const { result } = renderHook(() => useMermaidFullscreen());
    expect(result.current.activeSource).toBeNull();
    expect(result.current.activeBlockIndex).toBeNull();
    act(() => result.current.open('flowchart TD\n  A --> B', 0));
    expect(result.current.activeSource).toBe('flowchart TD\n  A --> B');
    expect(result.current.activeBlockIndex).toBe(0);
    expect(result.current.isOpen).toBe(true);
  });

  it('closes and clears the active source and block index', () => {
    const { result } = renderHook(() => useMermaidFullscreen());
    act(() => result.current.open('graph LR\n  X --> Y', 1));
    act(() => result.current.close());
    expect(result.current.isOpen).toBe(false);
    expect(result.current.activeSource).toBeNull();
    expect(result.current.activeBlockIndex).toBeNull();
  });

  it('preserves the block index for duplicate sources', () => {
    const { result } = renderHook(() => useMermaidFullscreen());
    act(() => result.current.open('graph LR\n  A --> B', 0));
    expect(result.current.activeBlockIndex).toBe(0);
    act(() => result.current.open('graph LR\n  A --> B', 1));
    expect(result.current.activeBlockIndex).toBe(1);
  });
});
