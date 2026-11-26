import { useEffect, useRef } from 'react';
import { tabIndexForNumber } from '../lib/tab-number';

declare global {
  interface Window {
    /** Set while the app is mounted; the desktop shell's Next Tab / Previous
     *  Tab (Ctrl+Tab, Ctrl+Shift+Tab). Returns whether it switched. */
    __mdrSwitchTab?: (offset: number) => boolean;
    /** Set while the app is mounted; the desktop shell's go-to-tab keys (Cmd+1
     *  to Cmd+9, Ctrl+ elsewhere): 1 to 8 pick that tab, 9 the last. Returns
     *  whether it switched. */
    __mdrSelectTab?: (n: number) => boolean;
    /** Set while the app is mounted; the desktop shell's View menu. Each does
     *  what its key does in the page (Cmd+B, Cmd+Shift+O, Cmd+\, Cmd+.) and
     *  returns false, doing nothing, while the Mermaid fullscreen view owns
     *  the keyboard. */
    __mdrToggleExplorer?: () => boolean;
    __mdrToggleOutline?: () => boolean;
    __mdrToggleComments?: () => boolean;
    __mdrToggleFocusMode?: () => boolean;
    /** Set while the app is mounted; the desktop shell's Go menu Next Comment
     *  (offset 1) and Previous Comment (offset -1). */
    __mdrJumpToComment?: (offset: number) => boolean;
    /** Set while the app is mounted; the desktop shell's Settings (Cmd+,) and
     *  its About entry. Opens the dialog rather than toggling it. */
    __mdrOpenSettings?: (section?: 'about') => boolean;
    /** Set while the app is mounted; the desktop shell's Help > Keyboard
     *  Shortcuts. Opens the panel rather than toggling it. */
    __mdrShowShortcuts?: () => boolean;
    /** Set while the app is mounted; the desktop shell's File > Show in
     *  Finder for the active tab. Returns false with no tab open. */
    __mdrRevealActiveFile?: () => boolean;
  }
}

/** What the desktop shell hooks act through. App supplies these. */
export interface DesktopShellActions {
  /** True while the Mermaid fullscreen view is open. It owns the keyboard, so
   *  core's own shortcuts do nothing there, and the shell's menu items for
   *  those shortcuts do nothing either: that is the one state in which the
   *  key reaches the menu instead of the page (see the View menu in
   *  src-tauri/src/main.rs). */
  mermaidFullscreenOpen: () => boolean;
  /** Closes every overlay but a confirm dialog, as for New Tab. False when a
   *  confirm dialog is up and waits for its answer. */
  clearOverlays: () => boolean;
  tabCount: () => number;
  /** The active tab's index, or -1 with none. */
  activeTabIndex: () => number;
  switchTabByOffset: (offset: number) => void;
  selectTabAt: (index: number) => void;
  toggleExplorer: () => void;
  toggleOutline: () => void;
  toggleComments: () => void;
  toggleFocusMode: () => void;
  jumpToComment: (offset: 1 | -1) => void;
  openSettings: (section?: 'about') => void;
  showShortcuts: () => void;
  /** Shows the active tab's file in the file manager; false with no tab. */
  revealActiveFile: () => boolean;
}

const HOOK_NAMES = [
  '__mdrSwitchTab',
  '__mdrSelectTab',
  '__mdrToggleExplorer',
  '__mdrToggleOutline',
  '__mdrToggleComments',
  '__mdrToggleFocusMode',
  '__mdrJumpToComment',
  '__mdrOpenSettings',
  '__mdrShowShortcuts',
  '__mdrRevealActiveFile',
] as const;

/**
 * Whether a tab switch now would throw away what is being typed: focus is in
 * a text field other than the comment form's or a comment card's reply and
 * edit fields, whose drafts are set aside and handed back on return (#196,
 * #213). The page's own Cmd+Shift+[ / ] keeps the same rule.
 */
export function typingOutsideCommentDraft(el: Element | null): boolean {
  return isTextEntry(el) && el!.closest('[data-comment-form], [data-card-editor]') === null;
}

/** Whether `el` takes typed text: an input, a textarea or an editable element. */
export function isTextEntry(el: Element | null): boolean {
  if (!el || !(el instanceof HTMLElement)) return false;
  return (
    el.tagName === 'INPUT' ||
    el.tagName === 'TEXTAREA' ||
    el.isContentEditable ||
    el.getAttribute('contenteditable') === 'true' ||
    el.getAttribute('contenteditable') === ''
  );
}

/**
 * Registers the hooks the desktop shell's menus and keys call (see AGENTS.md,
 * "Desktop shell hooks"). Registered once; each call reads the latest actions,
 * so a re-render never leaves the shell without a hook.
 */
export function useDesktopShellHooks(actions: DesktopShellActions): void {
  const ref = useRef(actions);
  ref.current = actions;

  useEffect(() => {
    const a = () => ref.current;
    // Core's own shortcut, mirrored for its menu item: nothing while the
    // Mermaid fullscreen view owns the keyboard.
    const asCoreKey = (run: () => void) => () => {
      if (a().mermaidFullscreenOpen()) return false;
      run();
      return true;
    };
    // A key with no other tab to go to does nothing at all: the overlays
    // close only for a switch that will happen. Nor does one while typing
    // (only the document's comment form hands its draft back), or while the
    // Mermaid fullscreen view is open: its composer keeps no draft, so closing
    // the view could throw away a comment being written, wherever focus is.
    // The page's own Cmd+Shift+[ / ] does nothing there either.
    const switchTo = (canSwitch: boolean, run: () => void) => {
      if (!canSwitch) return false;
      if (a().mermaidFullscreenOpen()) return false;
      if (typingOutsideCommentDraft(document.activeElement)) return false;
      if (!a().clearOverlays()) return false;
      run();
      return true;
    };

    window.__mdrSwitchTab = (offset) =>
      switchTo((offset === 1 || offset === -1) && a().tabCount() > 1, () =>
        a().switchTabByOffset(offset),
      );
    window.__mdrSelectTab = (n) => {
      const index = tabIndexForNumber(n, a().tabCount());
      return switchTo(index !== null && index !== a().activeTabIndex(), () =>
        a().selectTabAt(index!),
      );
    };
    window.__mdrToggleExplorer = asCoreKey(() => a().toggleExplorer());
    window.__mdrToggleOutline = asCoreKey(() => a().toggleOutline());
    window.__mdrToggleComments = asCoreKey(() => a().toggleComments());
    window.__mdrToggleFocusMode = asCoreKey(() => a().toggleFocusMode());
    window.__mdrJumpToComment = (offset) => {
      if (offset !== 1 && offset !== -1) return false;
      return asCoreKey(() => a().jumpToComment(offset))();
    };
    window.__mdrOpenSettings = (section) =>
      asCoreKey(() => a().openSettings(section === 'about' ? 'about' : undefined))();
    window.__mdrShowShortcuts = asCoreKey(() => a().showShortcuts());
    window.__mdrRevealActiveFile = () => a().revealActiveFile();

    return () => {
      for (const name of HOOK_NAMES) delete window[name];
    };
  }, []);
}
