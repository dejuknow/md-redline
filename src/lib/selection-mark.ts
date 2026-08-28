/**
 * The class the viewer paints a committed selection with, and the selector for
 * finding it again.
 *
 * Three modules have to agree on this string: `MarkdownViewer` paints it and
 * resolves right-clicks from it, `useSelection` spares a secondary press that
 * lands on it, and `CommentForm` refuses to read such a press as a dismissal.
 * A second copy of the literal is how one of them silently stops matching.
 */
export const SELECTION_MARK_CLASS = 'selection-highlight';
export const SELECTION_MARK_SELECTOR = `mark.${SELECTION_MARK_CLASS}`;
