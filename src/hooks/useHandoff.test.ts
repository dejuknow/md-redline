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
    whenSaved: () => Promise.resolve(),
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

    let pending: Promise<boolean> = Promise.resolve(false);
    act(() => {
      pending = result.current.handOff(['/a.md', '/b.md']);
    });
    await vi.waitFor(() => expect(copyAgentPrompt).toHaveBeenCalled());
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

  // The Send's response can arrive after the reviewer switched tabs, when the
  // shared active-text ref holds another file. The text is read at the click.
  it("reads a banner Send's files at the click and records only the session files", async () => {
    const { params, result } = setup();

    let commit: (() => void) | null = null;
    await act(async () => {
      commit = await result.current.prepareSend(['/a.md', '/b.md', '/not-open.md']);
    });
    params.rawMarkdownRef.current = 'another tab now active';
    act(() => commit!());

    expect(params.captureReferences).toHaveBeenCalledWith(
      new Map([
        ['/a.md', 'active at click'],
        ['/b.md', 'b at click'],
      ]),
      'handoff',
    );
  });

  it('gives the banner no commit when a session file failed to save', async () => {
    const { params, result } = setup({
      getSaveState: (path) => (path === '/b.md' ? 'failed' : 'saved'),
    });

    let commit: (() => void) | null = () => {};
    await act(async () => {
      commit = await result.current.prepareSend(['/a.md', '/b.md']);
    });

    expect(commit).toBeNull();
    expect(params.showToast).toHaveBeenCalledWith(
      expect.stringMatching(/b\.md didn't save/),
      'error',
    );
  });

  describe('unsaved comments', () => {
    it('waits for a write still out, then hands off', async () => {
      const states = new Map<string, SaveState>([['/b.md', 'saving']]);
      let landSave: () => void = () => {};
      const whenSaved = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            landSave = () => {
              states.set('/b.md', 'saved');
              resolve();
            };
          }),
      );
      const { params, result } = setup({
        getSaveState: (path) => states.get(path) ?? 'saved',
        whenSaved,
      });

      let pending: Promise<boolean> = Promise.resolve(false);
      act(() => {
        pending = result.current.handOff(['/a.md', '/b.md']);
      });
      expect(whenSaved).toHaveBeenCalled();
      expect(params.copyAgentPrompt).not.toHaveBeenCalled();

      let handedOff: boolean | undefined;
      await act(async () => {
        landSave();
        handedOff = await pending;
      });
      expect(handedOff).toBe(true);
      expect(params.copyAgentPrompt).toHaveBeenCalledWith(['/a.md', '/b.md']);
      expect(params.showToast).not.toHaveBeenCalled();
    });

    it('refuses when a handed-off file failed to save', async () => {
      const { params, result } = setup({
        getSaveState: (path) => (path === '/b.md' ? 'failed' : 'saved'),
      });

      let handedOff: boolean | undefined;
      await act(async () => {
        handedOff = await result.current.handOff(['/a.md', '/b.md']);
      });

      expect(handedOff).toBe(false);
      expect(params.copyAgentPrompt).not.toHaveBeenCalled();
      expect(params.captureReferences).not.toHaveBeenCalled();
      expect(params.showToast).toHaveBeenCalledWith(
        expect.stringMatching(/b\.md didn't save/),
        'error',
      );
    });

    it('ignores a save problem in a file that is not being handed off', async () => {
      const { params, result } = setup({
        getSaveState: (path) => (path === '/b.md' ? 'failed' : 'saved'),
      });

      await act(() => result.current.handOff(['/a.md']));

      expect(params.copyAgentPrompt).toHaveBeenCalled();
    });

    it('exposes the same check for the review banner', async () => {
      const { params, result } = setup({
        getSaveState: (path) => (path === '/b.md' ? 'failed' : 'saved'),
      });

      expect(await result.current.ensureSaved(['/a.md'])).toBe(true);
      expect(await result.current.ensureSaved(['/a.md', '/b.md'])).toBe(false);
      expect(params.showToast).toHaveBeenCalledTimes(1);
    });
  });
});
