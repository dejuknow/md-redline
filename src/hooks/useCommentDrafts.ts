import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CommentDraft, SelectionInfo } from '../types';

interface Params {
  /**
   * The file whose comment form can show right now: the active file, loaded,
   * in the rendered view. Null in the raw view, with no file open, and while
   * a file is still loading.
   */
  surfaceFile: string | null;
  /** The committed selection, from useSelection. */
  selection: SelectionInfo | null;
  /**
   * A touch or pen selection not yet committed, from useSelection. Committing
   * it later keeps the same object, and it was made on the markdown on screen
   * now, not on whatever an edit has left by the time the reader taps.
   */
  pendingSelection?: SelectionInfo | null;
  /**
   * The active file's text as a selection reads it: its markdown without
   * comments, and anything else that changes the rendered page. A draft whose
   * file no longer reads as it did when its selection was made is not
   * postable.
   */
  docText: string;
  /**
   * The rendered view showing the file is the diff overlay, whose page text
   * includes deleted blocks. A selection's offset and context read there do
   * not hold in the plain viewer.
   */
  underDiff: boolean;
  clearSelection: () => void;
  adoptSelection: (info: SelectionInfo) => void;
}

interface KeptDraft {
  draft: CommentDraft;
  /** The markdown (`docText`) on screen when its selection was made. */
  doc: string;
  /** Its selection was made in the diff overlay. */
  underDiff: boolean;
}

interface Restored extends KeptDraft {
  /** Changes with every hand-back, to mount the form afresh. */
  id: number;
  /** The file it belongs to. */
  file: string;
}

/**
 * Keeps one unsent comment draft per file while its form cannot show (#196).
 *
 * The form holds the text and useSelection holds one selection for the whole
 * app, so a tab switch or a switch to the raw view used to destroy both. Here
 * the draft is set aside when its file leaves the rendered view and handed
 * back when the file returns: the selection is committed again and the form
 * mounts on the text.
 *
 * A draft is only postable on the markdown its selection was made on. If the
 * file changed meanwhile, the selection may now point at other words, or at a
 * copy of the same words the reader never chose, and nothing on the page can
 * prove which. So the draft comes back unplaceable, with its text, and the
 * reader selects again. The same holds for a form that never left: an edit
 * landing while the reader types makes its selection unplaceable too (#212).
 * Comments added, resolved or replied to do not count as a change, since they
 * leave the markdown the reader selects in alone.
 *
 * Kept in memory for the session. Closing the tab does not drop the draft, so
 * opening the file again brings it back; a page reload does.
 */
export function useCommentDrafts({
  surfaceFile,
  selection,
  pendingSelection = null,
  docText,
  underDiff,
  clearSelection,
  adoptSelection,
}: Params) {
  // Drafts whose file is not showing its form, by file path.
  const parkedRef = useRef(new Map<string, KeptDraft>());
  // What the mounted form last reported. It outlives the form, because the
  // form unmounts before anything here can ask it, so it is only trusted
  // while its selection is still the committed one. Cancel, Escape and a
  // posted comment all clear the selection, and tell nobody else.
  const liveRef = useRef<KeptDraft | null>(null);
  const selectionRef = useRef(selection);
  const docTextRef = useRef(docText);
  const underDiffRef = useRef(underDiff);
  // The markdown and the view each selection was made on, read when the
  // selection first shows up here. The form reports later, and leaving reads
  // later still: by then an edit may have replaced the markdown the reader
  // selected in, and taking that for theirs would hand the draft back as
  // postable. Recorded from committed renders only, in a layout effect, which
  // runs before the form's report.
  const selectionDocRef = useRef<{
    selection: SelectionInfo | null;
    docText: string;
    underDiff: boolean;
  }>({ selection: null, docText, underDiff });
  // The file, markdown and view the committed selection was made in, as state
  // so a render can tell a selection that is still another file's, or one
  // whose file has changed under an open form (#212).
  const [owner, setOwner] = useState<{
    selection: SelectionInfo | null;
    file: string | null;
    doc: string;
    underDiff: boolean;
  }>({ selection: null, file: null, doc: docText, underDiff });
  // The markdown and view a pending selection was made on, for when it is
  // committed.
  const pendingDocRef = useRef<{
    selection: SelectionInfo | null;
    docText: string;
    underDiff: boolean;
  }>({ selection: null, docText, underDiff });
  useLayoutEffect(() => {
    selectionRef.current = selection;
    docTextRef.current = docText;
    underDiffRef.current = underDiff;
    if (pendingSelection !== null && pendingDocRef.current.selection !== pendingSelection) {
      pendingDocRef.current = { selection: pendingSelection, docText, underDiff };
    }
    if (selectionDocRef.current.selection !== selection) {
      const pending = pendingDocRef.current;
      const madeOn =
        selection !== null && pending.selection === selection
          ? pending
          : { selection, docText, underDiff };
      selectionDocRef.current = madeOn;
      setOwner({
        selection,
        file: surfaceFile,
        doc: madeOn.docText,
        underDiff: madeOn.underDiff,
      });
    }
  }, [selection, pendingSelection, docText, underDiff, surfaceFile]);

  const [restored, setRestored] = useState<Restored | null>(null);

  const reportDraft = useCallback((draft: CommentDraft) => {
    const prev = liveRef.current;
    if (prev !== null && prev.draft.selection === draft.selection) {
      liveRef.current = { ...prev, draft };
      return;
    }
    // A new selection belongs to the markdown it was made on. One still
    // pending (touch, pen) is not the committed one watched above, but the
    // form reports it as soon as it mounts, so the markdown now is its own.
    const madeOn = selectionDocRef.current;
    const known = madeOn.selection === draft.selection;
    liveRef.current = {
      draft,
      doc: known ? madeOn.docText : docTextRef.current,
      underDiff: known ? madeOn.underDiff : underDiffRef.current,
    };
  }, []);

  const prevSurfaceRef = useRef(surfaceFile);
  useEffect(() => {
    const prev = prevSurfaceRef.current;
    if (prev === surfaceFile) return;
    prevSurfaceRef.current = surfaceFile;

    if (prev !== null) {
      const live = liveRef.current;
      if (live && live.draft.selection === selectionRef.current && live.draft.text.trim()) {
        parkedRef.current.set(prev, live);
      }
      // A selection belongs to the document it was made in.
      clearSelection();
    }

    if (surfaceFile !== null) {
      const parked = parkedRef.current.get(surfaceFile);
      if (parked) {
        parkedRef.current.delete(surfaceFile);
        // Live again from here, so leaving before the form has mounted and
        // reported it parks it again instead of dropping it.
        liveRef.current = parked;
        // Locked, like any selection with an open form on it. Committed even
        // when it cannot be posted, because the form needs it to open on.
        adoptSelection(parked.draft.selection);
        setRestored((r) => ({ ...parked, id: (r?.id ?? 0) + 1, file: surfaceFile }));
      }
    }
  }, [surfaceFile, clearSelection, adoptSelection]);

  // The draft handed back, while it is still the one on screen. Bound to its
  // file as well as its selection: on the commit that switches files the
  // selection has not caught up yet.
  const current =
    restored && restored.file === surfaceFile && restored.draft.selection === selection
      ? restored
      : null;

  // What the committed selection was made on. A draft handed back brings its
  // own: committing it again records the markdown on screen now, not the one
  // its selection was read from. Any other selection was made on the markdown
  // recorded when it was committed, so a form left open while the file
  // changes is judged the same way as one taken away and back (#212).
  const madeOn =
    current ??
    (selection !== null && owner.selection === selection && owner.file === surfaceFile
      ? owner
      : null);

  const reason: 'changed' | 'diff' | null =
    madeOn === null
      ? null
      : madeOn.doc !== docText
        ? 'changed'
        : madeOn.underDiff && !underDiff
          ? 'diff'
          : null;

  return {
    /** For the form's `onDraftChange`. */
    reportDraft,
    /**
     * The draft the form should mount on, while its selection is the one
     * committed. Null for every selection the reader makes afterwards.
     */
    restoredDraft: current?.draft ?? null,
    /**
     * The markdown the committed selection was made on, to check the file
     * against again at submit. Null with no committed selection, and for the
     * render or two before a new one is recorded.
     */
    selectionDoc: madeOn?.doc ?? null,
    /**
     * The committed selection cannot take a comment: the file's markdown is
     * not the one it was made on, or it was made in the diff overlay and the
     * plain viewer shows the file now. That holds for a draft handed back and
     * for a form that stayed open. Its selection must not be painted either,
     * since the viewer would find the words somewhere else.
     */
    selectionUnplaceable: reason !== null,
    /** Why the committed selection cannot take a comment, or null when it can. */
    unplaceableReason: reason,
    /**
     * The committed selection still belongs to a file that is no longer on
     * screen: the commit that switches files renders before the selection is
     * cleared. Nothing may show or act on it.
     */
    selectionStale:
      selection !== null && owner.selection === selection && owner.file !== surfaceFile,
    /**
     * A key for the form that changes with each restore. The form of the file
     * being left can still be mounted when another file's draft comes back,
     * and it has to mount afresh to open on that draft.
     */
    formKey: restored?.id ?? 0,
  };
}
