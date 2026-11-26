import { createContext, useContext, useEffect, useState } from 'react';
import type { MdComment } from '../types';
import type { SidebarCommentEditorState } from '../lib/comment-editor-state';
import type { CardDraftsApi } from '../hooks/useCardDrafts';

/**
 * The app's card draft store (useCardDrafts), for the cards and the surfaces
 * that host them. Absent outside the app (unit tests, a surface rendered on
 * its own), where a surface keeps its editor in its own state and a card its
 * text, as before #213.
 */
export const CardDraftsContext = createContext<CardDraftsApi | null>(null);

export function useCardDraftsApi(): CardDraftsApi | null {
  return useContext(CardDraftsContext);
}

/**
 * The open card editor for a surface that hosts cards. With the app's store,
 * it is the file's own editor, shared by every surface and kept while the
 * file is away; the store also takes the context menu's requests and drops
 * an editor whose comment is gone. Without it, the surface keeps its own.
 */
export function useSurfaceCardEditor(
  requestedEditor: SidebarCommentEditorState | undefined,
  comments: readonly MdComment[],
): [SidebarCommentEditorState, (editor: SidebarCommentEditorState) => void] {
  const store = useCardDraftsApi();
  const [local, setLocal] = useState<SidebarCommentEditorState>(null);

  useEffect(() => {
    if (!store && requestedEditor) setLocal(requestedEditor);
    // The store reads requests itself, once. A surface mounting later must
    // not replay an old one over the file's open editor.
  }, [store, requestedEditor]);

  useEffect(() => {
    if (store || !local) return;
    const comment = comments.find((candidate) => candidate.id === local.commentId);
    if (
      !comment ||
      (local.mode === 'reply-edit' && !comment.replies?.some((reply) => reply.id === local.replyId))
    ) {
      setLocal(null);
    }
  }, [store, comments, local]);

  return store ? [store.editor, store.setEditor] : [local, setLocal];
}
