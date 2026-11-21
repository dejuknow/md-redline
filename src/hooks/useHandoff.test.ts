// @vitest-environment jsdom

import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useHandoff, type UseHandoffParams, type SaveState } from './useHandoff';

function setup(overrides: Partial<UseHandoffParams> = {}) {
  const params: UseHandoffParams = {
    activeFilePath: '/a.md',
    rawMarkdownRef: { current: 'active at click' },
    tabs: [
      { filePath: '/a.md', rawMarkdown: 'stale tab copy of a' },
      { filePath: '/b.md', rawMarkdown: 'b at click' },
    ],
    getSaveState: () => 'saved',
    copyAgentPrompt: vi.fn(() => Promise.resolve(true)),
    captureReferences: vi.fn(),
    showToast: vi.fn(),
    ...overrides,
  };
  const { result } = renderHook(() => useHandoff(params));
  return { params, result };
}

describe('useHandoff', () => {
  it('records the handed-off files as they were at the click, after the copy succeeds', async () => {
    let finishCopy: (ok: boolean) => void = () => {};
    const copyAgentPrompt = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finishCopy = resolve;
        }),
    );
    const { params, result } = setup({ copyAgentPrompt });

    let pending: Promise<void> = Promise.resolve();
    act(() => {
      pending = result.current.handOff(['/a.md', '/b.md']);
    });
    // Nothing is recorded while the clipboard write is still out.
    expect(params.captureReferences).not.toHaveBeenCalled();

    // An edit that lands while the copy is pending is not what was handed off.
    params.rawMarkdownRef.current = 'typed after the click';
    await act(async () => {
      finishCopy(true);
      await pending;
    });

    expect(copyAgentPrompt).toHaveBeenCalledWith(['/a.md', '/b.md']);
    expect(params.captureReferences).toHaveBeenCalledWith(
      new Map([
        ['/a.md', 'active at click'],
        ['/b.md', 'b at click'],
      ]),
      'handoff',
    );
  });

  it('leaves every reference alone when the copy fails', async () => {
    const { params, result } = setup({ copyAgentPrompt: vi.fn(() => Promise.resolve(false)) });

    await act(() => result.current.handOff(['/a.md']));

    expect(params.captureReferences).not.toHaveBeenCalled();
  });

  it('does not move the active tab reference when the picker left it out', async () => {
    const { params, result } = setup();

    await act(() => result.current.handOff(['/b.md']));

    expect(params.captureReferences).toHaveBeenCalledWith(
      new Map([['/b.md', 'b at click']]),
      'handoff',
    );
  });

  it('records a banner Send for the session files only, not the active tab', () => {
    const { params, result } = setup();

    act(() => result.current.recordSent(['/b.md', '/not-open.md']));

    expect(params.captureReferences).toHaveBeenCalledWith(
      new Map([['/b.md', 'b at click']]),
      'handoff',
    );
  });

  describe('unsaved comments', () => {
    it.each<[SaveState, RegExp]>([
      ['saving', /still saving/i],
      ['failed', /b\.md didn't save/],
    ])('refuses while a handed-off file is %s', async (state, message) => {
      const { params, result } = setup({
        getSaveState: (path) => (path === '/b.md' ? state : 'saved'),
      });

      await act(() => result.current.handOff(['/a.md', '/b.md']));

      expect(params.copyAgentPrompt).not.toHaveBeenCalled();
      expect(params.captureReferences).not.toHaveBeenCalled();
      expect(params.showToast).toHaveBeenCalledWith(expect.stringMatching(message), 'error');
    });

    it('ignores a save problem in a file that is not being handed off', async () => {
      const { params, result } = setup({
        getSaveState: (path) => (path === '/b.md' ? 'failed' : 'saved'),
      });

      await act(() => result.current.handOff(['/a.md']));

      expect(params.copyAgentPrompt).toHaveBeenCalled();
    });

    it('exposes the same check for the review banner', () => {
      const { params, result } = setup({
        getSaveState: (path) => (path === '/b.md' ? 'saving' : 'saved'),
      });

      expect(result.current.ensureSaved(['/a.md'])).toBe(true);
      expect(result.current.ensureSaved(['/a.md', '/b.md'])).toBe(false);
      expect(params.showToast).toHaveBeenCalledTimes(1);
    });
  });
});
