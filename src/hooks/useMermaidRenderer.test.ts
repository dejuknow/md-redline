// @vitest-environment jsdom

import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useMermaidRenderer } from './useMermaidRenderer';

const renderMermaidBlock = vi.fn();
const hasMermaidBlocks = vi.fn();

vi.mock('../lib/mermaid-renderer', () => ({
  getMermaidTheme: (theme: string) => {
    if (theme === 'dark' || theme === 'nord' || theme === 'rose-pine' || theme === 'catppuccin') {
      return 'dark';
    }
    if (theme === 'sepia') return 'neutral';
    return 'default';
  },
  hasMermaidBlocks: (...args: unknown[]) => hasMermaidBlocks(...args),
  renderMermaidBlock: (...args: unknown[]) => renderMermaidBlock(...args),
}));

describe('useMermaidRenderer', () => {
  beforeEach(() => {
    hasMermaidBlocks.mockReset();
    renderMermaidBlock.mockReset();
    hasMermaidBlocks.mockReturnValue(true);
    renderMermaidBlock.mockResolvedValue({ svg: '<svg></svg>' });
  });

  it('does not re-render mermaid when switching between app themes that share the same mermaid theme', async () => {
    const markdown = '```mermaid\nflowchart TD\nA-->B\n```';
    const { result, rerender } = renderHook(
      ({ theme }) => useMermaidRenderer(markdown, theme),
      { initialProps: { theme: 'dark' } },
    );

    await waitFor(() => {
      expect(result.current.size).toBe(1);
    });
    expect(renderMermaidBlock).toHaveBeenCalledTimes(1);
    expect(renderMermaidBlock).toHaveBeenLastCalledWith('flowchart TD\nA-->B', 'dark');

    rerender({ theme: 'nord' });

    await waitFor(() => {
      expect(result.current.size).toBe(1);
    });
    expect(renderMermaidBlock).toHaveBeenCalledTimes(1);
  });

  it('re-renders mermaid when switching to a different normalized mermaid theme', async () => {
    const markdown = '```mermaid\nflowchart TD\nA-->B\n```';
    const { result, rerender } = renderHook(
      ({ theme }) => useMermaidRenderer(markdown, theme),
      { initialProps: { theme: 'dark' } },
    );

    await waitFor(() => {
      expect(result.current.size).toBe(1);
    });
    expect(renderMermaidBlock).toHaveBeenCalledTimes(1);

    rerender({ theme: 'sepia' });

    await waitFor(() => {
      expect(renderMermaidBlock).toHaveBeenCalledTimes(2);
    });
    expect(renderMermaidBlock).toHaveBeenLastCalledWith('flowchart TD\nA-->B', 'neutral');
  });
});
