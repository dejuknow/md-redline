import type { ModalId } from '../hooks/useModalState';

/** What is open on top of the document when a desktop shell shortcut arrives. */
export interface ShellOverlayState {
  /** A confirm dialog: unsaved changes, delete all, or any other alertdialog. */
  confirmOpen: boolean;
  mermaidFullscreenOpen: boolean;
  activeModal: ModalId;
  drawerOpen: boolean;
  /** One of App's own context menus. */
  contextMenuOpen: boolean;
  /** A menu or popover App does not own (the View menu, the tab list, a review popover). */
  popupOpen: boolean;
  /** The highlight's comment popover, which may hold a reply being typed. */
  commentPopoverOpen: boolean;
}

/**
 * What the desktop shell's Close Tab (Cmd+W, Ctrl+W) does to an overlay before
 * it gets to the tab, as a browser's Cmd+W closes a dialog before the page:
 *
 * - `blocked`: a confirm dialog is up and waits for its own answer. A second
 *   Cmd+W used to swap the unsaved-changes dialog over to the active tab, so
 *   the reader confirmed closing a tab they had not asked about.
 * - `close-*` / `dismiss-popup`: close that overlay and leave the document be.
 *   The palette, a dialog, a menu or a comment popover (with a reply half
 *   typed in it) used to stay up, or go, while the document behind it closed.
 * - `null`: nothing is open; close the tab. The find bar does not count: it
 *   is part of reading the document, as a browser's is.
 *
 * Checked top down, the order they stack in: a menu opened from the drawer
 * or a popover sits above it, and the drawer (Cmd+\ opens it over an open
 * popover) above the popover.
 */
export type ShellOverlayAction =
  | 'blocked'
  | 'close-mermaid'
  | 'close-modal'
  | 'close-context-menu'
  | 'dismiss-popup'
  | 'close-drawer'
  | 'close-comment-popover'
  | null;

export function shellOverlayAction(state: ShellOverlayState): ShellOverlayAction {
  if (state.confirmOpen) return 'blocked';
  if (state.mermaidFullscreenOpen || state.activeModal === 'mermaidFullscreen') {
    return 'close-mermaid';
  }
  if (state.activeModal !== null && state.activeModal !== 'search') return 'close-modal';
  if (state.contextMenuOpen) return 'close-context-menu';
  if (state.popupOpen) return 'dismiss-popup';
  if (state.drawerOpen) return 'close-drawer';
  if (state.commentPopoverOpen) return 'close-comment-popover';
  return null;
}
