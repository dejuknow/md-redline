function getNavigatorValue(key: 'platform' | 'userAgent'): string {
  if (typeof navigator === 'undefined') return '';
  return navigator[key] ?? '';
}

export function isApplePlatform(): boolean {
  const platform = getNavigatorValue('platform');
  const userAgent = getNavigatorValue('userAgent');
  return /Mac|iPhone|iPad|iPod/.test(platform || userAgent);
}

export function getPrimaryModifierLabel(): 'Cmd' | 'Ctrl' {
  return isApplePlatform() ? 'Cmd' : 'Ctrl';
}

/**
 * Whether a pointer event is the platform's secondary click.
 *
 * macOS sends ctrl+click as the secondary click, and it arrives with
 * `button: 0` and `ctrlKey: true`, so testing the button alone misses the
 * gesture most Mac users make to open a context menu. Elsewhere ctrl+click is
 * an ordinary primary click (multi-select, open-in-new-tab) and must stay one.
 *
 * Only buttons 2 and the macOS chord count. `button !== 0` would sweep in the
 * middle button and the side buttons, which open no menu and should go on
 * clearing a selection the way any other press does.
 */
export function isSecondaryClick(e: { button: number; ctrlKey: boolean }): boolean {
  return e.button === 2 || (e.button === 0 && e.ctrlKey && isApplePlatform());
}
