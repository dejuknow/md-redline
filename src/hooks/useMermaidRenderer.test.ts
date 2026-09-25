// @vitest-environment jsdom

import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useMermaidRenderer, extractMermaidSources } from './useMermaidRenderer';

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
    const { result, rerender } = renderHook(({ theme }) => useMermaidRenderer(markdown, theme), {
      initialProps: { theme: 'dark' },
    });

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
    const { result, rerender } = renderHook(({ theme }) => useMermaidRenderer(markdown, theme), {
      initialProps: { theme: 'dark' },
    });

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

  it('does not scan or render while disabled and clears existing results', async () => {
    const markdown = '```mermaid\nflowchart TD\nA-->B\n```';
    const { result, rerender } = renderHook(
      ({ enabled }) => useMermaidRenderer(markdown, 'dark', enabled),
      { initialProps: { enabled: false } },
    );

    expect(result.current.size).toBe(0);
    expect(hasMermaidBlocks).not.toHaveBeenCalled();
    expect(renderMermaidBlock).not.toHaveBeenCalled();

    rerender({ enabled: true });

    await waitFor(() => {
      expect(result.current.size).toBe(1);
    });
    expect(renderMermaidBlock).toHaveBeenCalledTimes(1);

    rerender({ enabled: false });

    await waitFor(() => {
      expect(result.current.size).toBe(0);
    });
    expect(renderMermaidBlock).toHaveBeenCalledTimes(1);
  });
});

describe('extractMermaidSources', () => {
  // MarkdownViewer's unpainted-anchor report (#99 follow-up) needs to know
  // exactly which fences this function will ever produce a result for, so
  // its own detection has to match this shape precisely, not approximate it.
  it('extracts a well-formed fence, trimmed', () => {
    const markdown = '# Doc\n\n```mermaid\n  flowchart TD\n  A --> B\n```\n';
    expect(extractMermaidSources(markdown)).toEqual(['flowchart TD\n  A --> B']);
  });

  it('extracts more than one fence, in order', () => {
    const markdown = '```mermaid\nA\n```\n\nSome text.\n\n```mermaid\nB\n```\n';
    expect(extractMermaidSources(markdown)).toEqual(['A', 'B']);
  });

  it('does not extract a fence indented inside a blockquote', () => {
    // Each line carries a "> " prefix, so the fence marker never sits at
    // column 0 and the regex's ^ anchor never matches it.
    const markdown = '> ```mermaid\n> flowchart TD\n>   A --> B\n> ```\n';
    expect(extractMermaidSources(markdown)).toEqual([]);
  });

  it('does not extract a fence indented inside a list item', () => {
    const markdown = '- item\n  ```mermaid\n  flowchart TD\n  ```\n';
    expect(extractMermaidSources(markdown)).toEqual([]);
  });

  it('does not extract a ~~~ fence', () => {
    const markdown = '~~~mermaid\nflowchart TD\n~~~\n';
    expect(extractMermaidSources(markdown)).toEqual([]);
  });

  it('does not extract a fence with trailing text after "mermaid"', () => {
    const markdown = '```mermaid title="flow"\nflowchart TD\n```\n';
    expect(extractMermaidSources(markdown)).toEqual([]);
  });

  it('does not extract an unclosed fence', () => {
    const markdown = '```mermaid\nflowchart TD\nA --> B\n';
    expect(extractMermaidSources(markdown)).toEqual([]);
  });

  it('returns an empty array for a document with no mermaid fences', () => {
    expect(extractMermaidSources('# Doc\n\nJust text.\n')).toEqual([]);
  });
});
