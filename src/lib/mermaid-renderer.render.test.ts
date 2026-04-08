// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const initializeMock = vi.fn();
const renderMock = vi.fn(async (id: string) => ({ svg: `<svg id="${id}"></svg>` }));

describe('renderMermaidBlock', () => {
  beforeEach(() => {
    vi.resetModules();
    initializeMock.mockReset();
    renderMock.mockReset();
    renderMock.mockImplementation(async (id: string) => ({ svg: `<svg id="${id}"></svg>` }));

    vi.doMock('mermaid', () => ({
      default: {
        initialize: initializeMock,
        render: renderMock,
      },
    }));
  });

  afterEach(() => {
    vi.doUnmock('mermaid');
  });

  it('completes a dark-to-light theme switch without leaving mermaid locked', async () => {
    const { renderMermaidBlock } = await import('./mermaid-renderer');

    const darkResult = await renderMermaidBlock('flowchart TD\nA-->B', 'dark');
    expect(darkResult).toHaveProperty('svg');

    const lightResult = await Promise.race([
      renderMermaidBlock('flowchart TD\nA-->B', 'light'),
      new Promise<'timeout'>((resolve) => window.setTimeout(() => resolve('timeout'), 100)),
    ]);

    expect(lightResult).not.toBe('timeout');
    expect(lightResult).toHaveProperty('svg');
    expect(initializeMock.mock.calls.map(([config]) => config.theme)).toEqual([
      'default',
      'dark',
      'default',
    ]);
  });
});
