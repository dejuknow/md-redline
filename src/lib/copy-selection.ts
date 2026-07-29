interface CopySelectionFallbackOptions {
  nativeSelectionText: string;
  viewerSelectionText: string | null;
  activeElement: { tagName?: string | null; isContentEditable?: boolean | null } | null;
  viewMode: string;
  /** True when focus sits in the comment composer's textarea. */
  inCommentComposer?: boolean;
  /** True when that textarea has no selection of its own (a plain caret). */
  composerCaretCollapsed?: boolean;
}

export function getCopySelectionFallbackText({
  nativeSelectionText,
  viewerSelectionText,
  activeElement,
  viewMode,
  inCommentComposer = false,
  composerCaretCollapsed = false,
}: CopySelectionFallbackOptions): string | null {
  if (viewMode !== 'rendered') return null;
  if (nativeSelectionText.trim().length > 0) return null;

  const tagName = activeElement?.tagName?.toUpperCase();
  const isEditable =
    activeElement?.isContentEditable === true || tagName === 'INPUT' || tagName === 'TEXTAREA';
  // Quick comment focuses the composer the moment a selection is made, so a
  // bare caret there still means "copy what I highlighted in the document".
  // Text selected inside the composer keeps the native copy.
  const isComposerCaret = inCommentComposer && composerCaretCollapsed;
  if (isEditable && !isComposerCaret) return null;

  const text = viewerSelectionText?.trim();
  return text && text.length > 0 ? text : null;
}
