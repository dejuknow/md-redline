import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MdComment } from '../types';
import { getEffectiveStatus } from '../types';
import type { SidebarCommentEditorState } from '../lib/comment-editor-state';

/** What a card editor writes: the comment's own text, a new reply, or a reply's text. */
export type CardEditorTarget =
  | { mode: 'comment-edit'; commentId: string }
  | { mode: 'reply-compose'; commentId: string }
  | { mode: 'reply-edit'; commentId: string; replyId: string };

export interface CardDraft {
  target: CardEditorTarget;
  text: string;
  /**
   * The text the editor opened on: the comment's or the reply's text for an
   * edit, empty for a new reply. An edit is only saved over that text, so a
   * change to it under the draft means saving would overwrite someone else's.
   */
  base: string;
  /** The caret (selection start and end) as last left in the field. */
  caret: [number, number];
}

/**
 * Why a kept draft cannot go back into its card. A reply belongs to one
 * comment and an edit to one text, so a draft whose comment, reply or text is
 * gone is never put anywhere else.
 */
export type CardDraftProblem = 'comment-gone' | 'reply-gone' | 'resolved' | 'changed';

export interface SetAsideCardDraft {
  key: string;
  draft: CardDraft;
  problem: CardDraftProblem;
}

export function cardDraftKey(target: CardEditorTarget): string {
  return target.mode === 'reply-edit'
    ? `reply-edit:${target.commentId}:${target.replyId}`
    : `${target.mode}:${target.commentId}`;
}

export function editorTarget(editor: NonNullable<SidebarCommentEditorState>): CardEditorTarget {
  return editor.mode === 'reply-edit'
    ? { mode: 'reply-edit', commentId: editor.commentId, replyId: editor.replyId }
    : { mode: editor.mode, commentId: editor.commentId };
}

/** Whether the text is worth keeping: something typed, and not just the text it opened on. */
export function isMeaningfulCardDraft(text: string, base: string): boolean {
  return text.trim() !== '' && text !== base;
}

/**
 * Whether a target can still take an editor in this file, and, given its
 * draft, whether that draft can go back in. Null when it can.
 */
export function judgeCardTarget(
  target: CardEditorTarget,
  draft: CardDraft | undefined,
  comments: readonly MdComment[],
): CardDraftProblem | null {
  const comment = comments.find((c) => c.id === target.commentId);
  if (!comment) return 'comment-gone';
  // Every card hides its editors on a resolved thread, so a draft there has
  // nowhere to show until the thread is reopened.
  if (getEffectiveStatus(comment) === 'resolved') return 'resolved';
  if (target.mode === 'reply-compose') return null;
  if (target.mode === 'comment-edit') {
    return draft && comment.text !== draft.base ? 'changed' : null;
  }
  const reply = comment.replies?.find((r) => r.id === target.replyId);
  if (!reply) return 'reply-gone';
  return draft && reply.text !== draft.base ? 'changed' : null;
}

interface FileDrafts {
  /** The card editor open in this file, kept while the file is away. */
  editor: SidebarCommentEditorState;
  drafts: Map<string, CardDraft>;
  /**
   * Drafts set aside for good: their editor was opened again afresh while
   * they could not go back in, so they no longer belong to it.
   */
  detached: SetAsideCardDraft[];
}

interface Params {
  /**
   * The file whose cards can show: the active file once it has loaded without
   * an error, in either view (the comments drawer shows cards in the raw view
   * too). Null otherwise, which keeps every draft as it is.
   */
  file: string | null;
  /** The active file's comments. */
  comments: readonly MdComment[];
  /** An editor asked for from outside the cards (the context menu's Edit and Reply). */
  requestedEditor: SidebarCommentEditorState;
  /**
   * The file came back with a card editor that can show again: select its
   * card, and make sure a surface is there to show it.
   */
  onEditorBack: (commentId: string) => void;
}

/**
 * Keeps unsent reply and edit drafts on comment cards, per file, for the
 * session (#213). The new-comment form has its own store (useCommentDrafts).
 *
 * Card surfaces (the rail in either density, the comments drawer) used to
 * keep the open editor in their own state and the card its text, so a tab
 * switch, the raw view or a density change dropped both. Here each file
 * keeps its open editor and one draft per editor target, so:
 *
 * - leaving the file and coming back opens the same editor on the same text
 *   and caret, and selects its card again;
 * - opening another card's editor keeps the first one's draft for when that
 *   editor is opened again;
 * - a draft whose comment or reply is gone, whose thread was resolved, or
 *   whose edited text changed under it is never shown in its card or put on
 *   another one. It is set aside, offered to copy, and goes back in by itself
 *   if its comment does (an undo, a reopen).
 *
 * Kept in memory like the comment form's drafts: closing a tab keeps them,
 * a page reload drops them.
 */
export function useCardDrafts({ file, comments, requestedEditor, onEditorBack }: Params) {
  const filesRef = useRef(new Map<string, FileDrafts>());
  // Drafts live in a ref so typing does not re-render the app. This changes
  // whenever something a render reads does: a draft added or removed, or an
  // editor opened or closed.
  const [version, setVersion] = useState(0);
  const bump = useCallback(() => setVersion((v) => v + 1), []);

  const fileRef = useRef(file);
  fileRef.current = file;
  // The token of an editor just opened by the reader, until its card has
  // focused it. An editor shown again later (the file coming back, its
  // thread reopened) is not fresh, and takes focus only if nothing has it.
  const freshTokenRef = useRef<number | null>(null);
  const commentsRef = useRef(comments);
  commentsRef.current = comments;
  const detachedSeqRef = useRef(0);

  const entry = useCallback((path: string): FileDrafts => {
    let found = filesRef.current.get(path);
    if (!found) {
      found = { editor: null, drafts: new Map(), detached: [] };
      filesRef.current.set(path, found);
    }
    return found;
  }, []);

  const setEditor = useCallback(
    (editor: SidebarCommentEditorState) => {
      const path = fileRef.current;
      if (path === null) return;
      const files = entry(path);
      if (files.editor === editor) return;
      files.editor = editor;
      freshTokenRef.current = editor?.token ?? null;
      // Opening an editor whose kept draft cannot go back in (the text it
      // edits changed) starts it afresh. The draft stays offered, apart from
      // it, or it would keep the editor from showing at all.
      if (editor) {
        const key = cardDraftKey(editorTarget(editor));
        const kept = files.drafts.get(key);
        const problem = kept && judgeCardTarget(kept.target, kept, commentsRef.current);
        if (kept && problem) {
          files.drafts.delete(key);
          files.detached.push({
            key: `detached:${++detachedSeqRef.current}`,
            draft: kept,
            problem,
          });
        }
      }
      bump();
    },
    [entry, bump],
  );

  // The context menu's Edit and Reply, for the file on screen when asked.
  const lastRequestRef = useRef(requestedEditor);
  useEffect(() => {
    if (lastRequestRef.current === requestedEditor) return;
    lastRequestRef.current = requestedEditor;
    if (requestedEditor) setEditor(requestedEditor);
  }, [requestedEditor, setEditor]);

  // Leaving a file: an editor with nothing typed in it closes, as the comment
  // form does. Coming back: the card whose editor is open is selected again.
  const prevFileRef = useRef(file);
  useEffect(() => {
    const prev = prevFileRef.current;
    if (prev === file) return;
    prevFileRef.current = file;
    if (prev !== null) {
      const left = filesRef.current.get(prev);
      if (left?.editor && !left.drafts.has(cardDraftKey(editorTarget(left.editor)))) {
        left.editor = null;
      }
    }
    if (file !== null) {
      const back = filesRef.current.get(file)?.editor;
      if (back) {
        const target = editorTarget(back);
        const draft = filesRef.current.get(file)?.drafts.get(cardDraftKey(target));
        if (judgeCardTarget(target, draft, comments) === null) onEditorBack(back.commentId);
      }
    }
    // Only on a change of file; comments are read as they are then.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file]);

  const readDraft = useCallback((target: CardEditorTarget): CardDraft | null => {
    const path = fileRef.current;
    if (path === null) return null;
    return filesRef.current.get(path)?.drafts.get(cardDraftKey(target)) ?? null;
  }, []);

  const writeDraft = useCallback(
    (target: CardEditorTarget, text: string, base: string, caret: [number, number]) => {
      const path = fileRef.current;
      if (path === null) return;
      const drafts = entry(path).drafts;
      const key = cardDraftKey(target);
      const had = drafts.has(key);
      if (isMeaningfulCardDraft(text, base)) {
        drafts.set(key, { target, text, base, caret });
        if (!had) bump();
      } else if (had) {
        drafts.delete(key);
        bump();
      }
    },
    [entry, bump],
  );

  const takeFreshOpen = useCallback((token: number) => {
    if (freshTokenRef.current !== token) return false;
    freshTokenRef.current = null;
    return true;
  }, []);

  const setCaret = useCallback((target: CardEditorTarget, caret: [number, number]) => {
    const path = fileRef.current;
    if (path === null) return;
    const draft = filesRef.current.get(path)?.drafts.get(cardDraftKey(target));
    if (draft) draft.caret = caret;
  }, []);

  const discardDraft = useCallback(
    (target: CardEditorTarget) => {
      const path = fileRef.current;
      if (path === null) return;
      if (filesRef.current.get(path)?.drafts.delete(cardDraftKey(target))) bump();
    },
    [bump],
  );

  const discardSetAside = useCallback(
    (key: string) => {
      const path = fileRef.current;
      if (path === null) return;
      const files = filesRef.current.get(path);
      if (!files) return;
      const detachedAt = files.detached.findIndex((d) => d.key === key);
      if (detachedAt >= 0) {
        files.detached.splice(detachedAt, 1);
        bump();
        return;
      }
      if (!files.drafts.delete(key)) return;
      if (files.editor && cardDraftKey(editorTarget(files.editor)) === key) files.editor = null;
      bump();
    },
    [bump],
  );

  const current = file !== null ? filesRef.current.get(file) : undefined;
  const storedEditor = current?.editor ?? null;

  // The editor the cards show: the stored one while its comment can still
  // take it. Kept in the store either way, so it shows again if the comment
  // comes back (an undo, a reopen).
  const editor = useMemo<SidebarCommentEditorState>(() => {
    if (!storedEditor || !current) return null;
    const target = editorTarget(storedEditor);
    const draft = current.drafts.get(cardDraftKey(target));
    return judgeCardTarget(target, draft, comments) === null ? storedEditor : null;
    // `version` stands in for the drafts held in the ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storedEditor, current, comments, version]);

  // Drafts that cannot go back into their cards, oldest first.
  const setAside = useMemo<SetAsideCardDraft[]>(() => {
    if (!current) return [];
    const out: SetAsideCardDraft[] = [...current.detached];
    for (const [key, draft] of current.drafts) {
      const problem = judgeCardTarget(draft.target, draft, comments);
      if (problem) out.push({ key, draft, problem });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, comments, version]);

  const api = useMemo<CardDraftsApi | null>(
    () =>
      file === null
        ? null
        : { file, editor, setEditor, takeFreshOpen, readDraft, writeDraft, setCaret, discardDraft },
    [file, editor, setEditor, takeFreshOpen, readDraft, writeDraft, setCaret, discardDraft],
  );

  return {
    /** For CardDraftsContext. Null while no file's cards can show. */
    api,
    /** Drafts kept aside in the active file because their card cannot take them. */
    setAside,
    discardSetAside,
  };
}

export interface CardDraftsApi {
  /** The file the cards on screen belong to. */
  file: string;
  /** The open card editor in that file, while its comment can take it. */
  editor: SidebarCommentEditorState;
  setEditor: (editor: SidebarCommentEditorState) => void;
  /**
   * Whether the editor with this token was just opened by the reader, and has
   * not taken focus yet. True once per open.
   */
  takeFreshOpen: (token: number) => boolean;
  /** The draft kept for a target, if any, whether or not it can go back in. */
  readDraft: (target: CardEditorTarget) => CardDraft | null;
  /** Record the field's text; text not worth keeping drops the draft. */
  writeDraft: (
    target: CardEditorTarget,
    text: string,
    base: string,
    caret: [number, number],
  ) => void;
  setCaret: (target: CardEditorTarget, caret: [number, number]) => void;
  /** Cancel, Escape, Save and Reply: the draft is done with. */
  discardDraft: (target: CardEditorTarget) => void;
}
