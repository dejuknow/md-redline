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
