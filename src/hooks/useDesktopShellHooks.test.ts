// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  typingOutsideCommentDraft,
  useDesktopShellHooks,
  type DesktopShellActions,
} from './useDesktopShellHooks';

function makeActions(overrides: Partial<DesktopShellActions> = {}): DesktopShellActions {
  return {
    mermaidFullscreenOpen: () => false,
    clearOverlays: vi.fn(() => true),
    tabCount: () => 3,
    activeTabIndex: () => 0,
    switchTabByOffset: vi.fn(),
    selectTabAt: vi.fn(),
    toggleExplorer: vi.fn(),
    toggleOutline: vi.fn(),
    toggleComments: vi.fn(),
    toggleFocusMode: vi.fn(),
    jumpToComment: vi.fn(),
    openSettings: vi.fn(),
    showShortcuts: vi.fn(),
    revealActiveFile: vi.fn(() => true),
    ...overrides,
  };
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('useDesktopShellHooks', () => {
  it('registers every hook while mounted and removes them on unmount', () => {
    const { unmount } = renderHook(() => useDesktopShellHooks(makeActions()));
    expect(typeof window.__mdrSwitchTab).toBe('function');
    expect(typeof window.__mdrSelectTab).toBe('function');
    expect(typeof window.__mdrToggleExplorer).toBe('function');
    expect(typeof window.__mdrRevealActiveFile).toBe('function');
    unmount();
    expect(window.__mdrSwitchTab).toBeUndefined();
    expect(window.__mdrSelectTab).toBeUndefined();
    expect(window.__mdrToggleExplorer).toBeUndefined();
    expect(window.__mdrOpenSettings).toBeUndefined();
    expect(window.__mdrRevealActiveFile).toBeUndefined();
  });

  it('switches to the next and previous tab after closing overlays', () => {
    const actions = makeActions();
    renderHook(() => useDesktopShellHooks(actions));
    expect(window.__mdrSwitchTab!(1)).toBe(true);
    expect(window.__mdrSwitchTab!(-1)).toBe(true);
    expect(actions.clearOverlays).toHaveBeenCalledTimes(2);
    expect(actions.switchTabByOffset).toHaveBeenNthCalledWith(1, 1);
    expect(actions.switchTabByOffset).toHaveBeenNthCalledWith(2, -1);
    expect(window.__mdrSwitchTab!(2)).toBe(false);
  });

  it('selects tabs 1 to 8 by position and 9 as the last', () => {
    const actions = makeActions({ tabCount: () => 4, activeTabIndex: () => 2 });
    renderHook(() => useDesktopShellHooks(actions));
    expect(window.__mdrSelectTab!(2)).toBe(true);
    expect(actions.selectTabAt).toHaveBeenLastCalledWith(1);
    expect(window.__mdrSelectTab!(9)).toBe(true);
    expect(actions.selectTabAt).toHaveBeenLastCalledWith(3);
    expect(window.__mdrSelectTab!(6)).toBe(false);
    expect(actions.selectTabAt).toHaveBeenCalledTimes(2);
  });

  it('leaves overlays open when the key has no tab to go to', () => {
    const actions = makeActions({ tabCount: () => 1 });
    renderHook(() => useDesktopShellHooks(actions));
    // Past the last tab, and next / previous with only one tab.
    expect(window.__mdrSelectTab!(4)).toBe(false);
    expect(window.__mdrSwitchTab!(1)).toBe(false);
    expect(window.__mdrSwitchTab!(-1)).toBe(false);
    expect(actions.clearOverlays).not.toHaveBeenCalled();
    expect(actions.switchTabByOffset).not.toHaveBeenCalled();
  });

  it('leaves overlays open for the tab already active', () => {
    const actions = makeActions({ tabCount: () => 3, activeTabIndex: () => 0 });
    renderHook(() => useDesktopShellHooks(actions));
    expect(window.__mdrSelectTab!(1)).toBe(false);
    expect(actions.clearOverlays).not.toHaveBeenCalled();
    expect(actions.selectTabAt).not.toHaveBeenCalled();
  });

  it('leaves the Mermaid fullscreen view open, whose composer keeps no draft', () => {
    const actions = makeActions({ mermaidFullscreenOpen: () => true });
    renderHook(() => useDesktopShellHooks(actions));
    const form = document.createElement('div');
    form.setAttribute('data-comment-form', '');
    const textarea = document.createElement('textarea');
    form.appendChild(textarea);
    document.body.appendChild(form);
    textarea.focus();
    expect(window.__mdrSwitchTab!(1)).toBe(false);
    expect(window.__mdrSelectTab!(2)).toBe(false);
    // Focus elsewhere in the view (its Cancel button, say): still nothing.
    textarea.blur();
    expect(window.__mdrSwitchTab!(1)).toBe(false);
    expect(actions.clearOverlays).not.toHaveBeenCalled();
  });

  it('leaves tabs alone with none open, while a confirm dialog waits, or while typing', () => {
    const none = makeActions({ tabCount: () => 0 });
    const { unmount } = renderHook(() => useDesktopShellHooks(none));
    expect(window.__mdrSwitchTab!(1)).toBe(false);
    expect(window.__mdrSelectTab!(1)).toBe(false);
    unmount();

    const blocked = makeActions({ clearOverlays: vi.fn(() => false) });
    const second = renderHook(() => useDesktopShellHooks(blocked));
    expect(window.__mdrSwitchTab!(1)).toBe(false);
    expect(blocked.switchTabByOffset).not.toHaveBeenCalled();
    second.unmount();

    const typing = makeActions();
    renderHook(() => useDesktopShellHooks(typing));
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    expect(window.__mdrSwitchTab!(1)).toBe(false);
    expect(window.__mdrSelectTab!(1)).toBe(false);
    // Nothing closed either: the field keeps what is typed and its overlay.
    expect(typing.clearOverlays).not.toHaveBeenCalled();
  });

  it('switches from the comment form, whose draft is handed back', () => {
    const actions = makeActions();
    renderHook(() => useDesktopShellHooks(actions));
    const form = document.createElement('div');
    form.setAttribute('data-comment-form', '');
    const textarea = document.createElement('textarea');
    form.appendChild(textarea);
    document.body.appendChild(form);
    textarea.focus();
    expect(window.__mdrSwitchTab!(1)).toBe(true);
  });

  it('runs the View and Go menu actions', () => {
    const actions = makeActions();
    renderHook(() => useDesktopShellHooks(actions));
    expect(window.__mdrToggleExplorer!()).toBe(true);
    expect(window.__mdrToggleOutline!()).toBe(true);
    expect(window.__mdrToggleComments!()).toBe(true);
    expect(window.__mdrToggleFocusMode!()).toBe(true);
    expect(window.__mdrJumpToComment!(1)).toBe(true);
    expect(window.__mdrJumpToComment!(-1)).toBe(true);
    expect(window.__mdrJumpToComment!(3)).toBe(false);
    expect(actions.toggleExplorer).toHaveBeenCalledTimes(1);
    expect(actions.toggleOutline).toHaveBeenCalledTimes(1);
    expect(actions.toggleComments).toHaveBeenCalledTimes(1);
    expect(actions.toggleFocusMode).toHaveBeenCalledTimes(1);
    expect(actions.jumpToComment).toHaveBeenNthCalledWith(1, 1);
    expect(actions.jumpToComment).toHaveBeenNthCalledWith(2, -1);
  });

  it("does nothing for core's own keys while the Mermaid fullscreen view owns the keyboard", () => {
    const actions = makeActions({ mermaidFullscreenOpen: () => true });
    renderHook(() => useDesktopShellHooks(actions));
    expect(window.__mdrToggleExplorer!()).toBe(false);
    expect(window.__mdrToggleOutline!()).toBe(false);
    expect(window.__mdrToggleComments!()).toBe(false);
    expect(window.__mdrToggleFocusMode!()).toBe(false);
    expect(window.__mdrJumpToComment!(1)).toBe(false);
    expect(window.__mdrOpenSettings!()).toBe(false);
    expect(window.__mdrShowShortcuts!()).toBe(false);
    expect(actions.toggleExplorer).not.toHaveBeenCalled();
    expect(actions.openSettings).not.toHaveBeenCalled();
  });

  it('opens settings, its About section, and the shortcuts panel', () => {
    const actions = makeActions();
    renderHook(() => useDesktopShellHooks(actions));
    expect(window.__mdrOpenSettings!()).toBe(true);
    expect(window.__mdrOpenSettings!('about')).toBe(true);
    expect(actions.openSettings).toHaveBeenNthCalledWith(1, undefined);
    expect(actions.openSettings).toHaveBeenNthCalledWith(2, 'about');
    expect(window.__mdrShowShortcuts!()).toBe(true);
    expect(actions.showShortcuts).toHaveBeenCalledTimes(1);
  });

  it('reveals the active file and reports when there is none', () => {
    const actions = makeActions({ revealActiveFile: vi.fn(() => false) });
    renderHook(() => useDesktopShellHooks(actions));
    expect(window.__mdrRevealActiveFile!()).toBe(false);
    expect(actions.revealActiveFile).toHaveBeenCalledTimes(1);
  });

  it('reads the latest actions after a re-render', () => {
    const first = makeActions();
    const second = makeActions();
    const { rerender } = renderHook(({ a }) => useDesktopShellHooks(a), {
      initialProps: { a: first },
    });
    rerender({ a: second });
    window.__mdrToggleExplorer!();
    expect(first.toggleExplorer).not.toHaveBeenCalled();
    expect(second.toggleExplorer).toHaveBeenCalledTimes(1);
  });
});

describe('typingOutsideCommentDraft', () => {
  it('counts inputs, textareas and editable elements outside the comment form', () => {
    const input = document.createElement('input');
    const editable = document.createElement('div');
    editable.setAttribute('contenteditable', 'true');
    const plain = document.createElement('button');
    document.body.append(input, editable, plain);
    expect(typingOutsideCommentDraft(input)).toBe(true);
    expect(typingOutsideCommentDraft(editable)).toBe(true);
    expect(typingOutsideCommentDraft(plain)).toBe(false);
    expect(typingOutsideCommentDraft(document.body)).toBe(false);
    expect(typingOutsideCommentDraft(null)).toBe(false);
  });
});
