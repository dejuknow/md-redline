interface CopySelectionFallbackOptions {
  nativeSelectionText: string;
  viewerSelectionText: string | null;
  activeElement: { tagName?: string | null; isContentEditable?: boolean | null } | null;
  viewMode: string;
}

export function getCopySelectionFallbackText({
  nativeSelectionText,
  viewerSelectionText,
  activeElement,
  viewMode,
}: CopySelectionFallbackOptions): string | null {
  if (viewMode !== 'rendered') return null;
  if (nativeSelectionText.trim().length > 0) return null;

  const tagName = activeElement?.tagName?.toUpperCase();
  const isEditable =
    activeElement?.isContentEditable === true || tagName === 'INPUT' || tagName === 'TEXTAREA';
  if (isEditable) return null;

  const text = viewerSelectionText?.trim();
  return text && text.length > 0 ? text : null;
}
