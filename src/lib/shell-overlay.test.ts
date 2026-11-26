import { describe, expect, it } from 'vitest';
import { shellOverlayAction, type ShellOverlayState } from './shell-overlay';

const nothing: ShellOverlayState = {
  confirmOpen: false,
  mermaidFullscreenOpen: false,
  activeModal: null,
  drawerOpen: false,
  contextMenuOpen: false,
  popupOpen: false,
  commentPopoverOpen: false,
};

describe('shellOverlayAction', () => {
  it('closes the tab when nothing is open', () => {
    expect(shellOverlayAction(nothing)).toBeNull();
  });

  it('leaves a confirm dialog waiting for its answer', () => {
    expect(shellOverlayAction({ ...nothing, confirmOpen: true })).toBe('blocked');
    // Even with the palette or a menu also up: the dialog is on top.
    expect(
      shellOverlayAction({
        ...nothing,
        confirmOpen: true,
        activeModal: 'commandPalette',
        contextMenuOpen: true,
      }),
    ).toBe('blocked');
  });

  it('closes the Mermaid fullscreen view before anything under it', () => {
    expect(shellOverlayAction({ ...nothing, mermaidFullscreenOpen: true })).toBe('close-mermaid');
    expect(shellOverlayAction({ ...nothing, activeModal: 'mermaidFullscreen' })).toBe(
      'close-mermaid',
    );
  });

  it.each(['commandPalette', 'fileOpener', 'settings', 'shortcuts'] as const)(
    'closes the %s modal',
    (modal) => {
      expect(shellOverlayAction({ ...nothing, activeModal: modal, drawerOpen: true })).toBe(
        'close-modal',
      );
    },
  );

  it('treats the find bar as part of the document', () => {
    expect(shellOverlayAction({ ...nothing, activeModal: 'search' })).toBeNull();
    expect(shellOverlayAction({ ...nothing, activeModal: 'search', drawerOpen: true })).toBe(
      'close-drawer',
    );
  });

  it('closes a menu before the drawer or popover it was opened over', () => {
    const all = { ...nothing, drawerOpen: true, commentPopoverOpen: true };
    expect(shellOverlayAction({ ...all, contextMenuOpen: true, popupOpen: true })).toBe(
      'close-context-menu',
    );
    expect(shellOverlayAction({ ...all, popupOpen: true })).toBe('dismiss-popup');
    expect(shellOverlayAction(all)).toBe('close-comment-popover');
    expect(shellOverlayAction({ ...nothing, drawerOpen: true })).toBe('close-drawer');
  });

  it('closes a comment popover rather than the document under it', () => {
    expect(shellOverlayAction({ ...nothing, commentPopoverOpen: true })).toBe(
      'close-comment-popover',
    );
  });
});
