import {
  useState,
  useMemo,
  useCallback,
  useRef,
  type RefObject,
  type Dispatch,
  type SetStateAction,
} from 'react';
import {
  parseComments,
  insertComment,
  removeComment,
  editComment,
  editReply,
  updateCommentAnchor,
  moveComment,
  resolveComment,
  unresolveComment,
  addReply,
  removeReply,
  removeAllComments,
  resolveAllComments,
  removeResolvedComments,
  detectMissingAnchors,
  orderCommentsByAnchor,
} from '../lib/comment-parser';
import { randomId } from '../lib/random-id';
import { computeUserRepliedLast } from '../lib/answered-comments';
import { getEffectiveStatus, type MdComment } from '../types';
import { renderMarkdown } from '../markdown/pipeline';
import { DEFAULT_HIDDEN_COMMENT_PREFIXES } from '../lib/settings';
import type { MarkdownViewerHandle } from '../components/MarkdownViewer';
import type { RawViewHandle } from '../components/RawView';
import { buildAddressCommentsPrompt } from '../lib/agent-prompts';
import type { ShowToast } from './useToast';
import type { UndoEntry, UndoSlot } from './useUndoSlot';

interface TabInfo {
  filePath: string;
  rawMarkdown: string;
}

/**
 * Why a comment-focus request was made. Declared once: App owns the state and
 * this hook is handed the setter, and the two copies had already drifted
 * ('highlight' was added to App's union only).
 *
 * Only 'highlight' leaves DOM focus where it is. It means the reviewer clicked
 * a highlight in the prose (or its density tick) while reading, and the card
 * they want is being scrolled into view beside the text; moving focus there
 * would take the caret, the space bar and a screen reader out of the passage
 * mid-sentence. The rest are deliberate requests to go to a card: 'reveal'
 * opened a surface to hold it, 'jump' came from the palette or an agent ask,
 * 'creation' just wrote it.
 */
export type CommentFocusOrigin = 'creation' | 'jump' | 'highlight' | 'reveal';

export interface UseCommentsParams {
  rawMarkdown: string | undefined;
  rawMarkdownRef: RefObject<string | undefined>;
  setRawMarkdown: (content: string) => void;
  saveFile: (content: string) => void;
  author: string;
  enableResolve: boolean;
  /** Render single source newlines as line breaks (the Keep line breaks setting). */
  keepLineBreaks: boolean;
  /** Render ordinary HTML comments, and the prefixes that keep one hidden. */
  renderHtmlComments?: boolean;
  hiddenCommentPrefixes?: string[];
  tabs: TabInfo[];
  activeFilePath: string | null;
  viewerRef: RefObject<MarkdownViewerHandle | null>;
  rawViewRef: RefObject<RawViewHandle | null>;
  showToast: ShowToast;
  clearSelection: () => void;
  setAutoExpandForm: Dispatch<SetStateAction<boolean>>;
  requestCommentFocus: (commentId: string, origin?: CommentFocusOrigin) => void;
  /** Where a delete leaves its undo for Cmd+Z and the palette (useUndoSlot). */
  undoSlot: Pick<UndoSlot, 'offer' | 'holds' | 'take'>;
}

export function useComments(params: UseCommentsParams) {
  const {
    rawMarkdown,
    rawMarkdownRef,
    setRawMarkdown,
    saveFile,
    author,
    enableResolve,
    keepLineBreaks,
    renderHtmlComments = true,
    hiddenCommentPrefixes = DEFAULT_HIDDEN_COMMENT_PREFIXES,
    tabs,
    activeFilePath,
    viewerRef,
    rawViewRef,
    showToast,
    clearSelection,
    setAutoExpandForm,
    requestCommentFocus,
    undoSlot: { offer: offerUndo, holds: undoHolds, take: takeUndo },
  } = params;

  const [activeCommentId, setActiveCommentId] = useState<string | null>(null);

  // Parse comments from raw markdown
  const { cleanMarkdown, comments } = useMemo(
    () => parseComments(rawMarkdown ?? ''),
    [rawMarkdown],
  );

  // Render markdown to HTML
  const html = useMemo(
    () =>
      cleanMarkdown
        ? renderMarkdown(cleanMarkdown, activeFilePath ?? undefined, {
            keepLineBreaks,
            renderHtmlComments,
            hiddenCommentPrefixes,
          })
        : '',
    [cleanMarkdown, activeFilePath, keepLineBreaks, renderHtmlComments, hiddenCommentPrefixes],
  );

  // Detect missing anchors
  const missingAnchors = useMemo(
    () => detectMissingAnchors(cleanMarkdown, comments),
    [cleanMarkdown, comments],
  );

  // Transition signal — ids that became orphaned since the previous render.
  // Uses a during-render ref-compare pattern so newOrphanIds has stable
  // identity when missingAnchors identity is unchanged, preventing downstream
  // effects (e.g. debounced orphan toast) from re-running on unrelated renders.
  const prevMissingRef = useRef<Set<string>>(missingAnchors);
  const newOrphanIdsRef = useRef<Set<string>>(new Set());

  if (missingAnchors !== prevMissingRef.current) {
    const next = new Set<string>();
    for (const id of missingAnchors) {
      if (!prevMissingRef.current.has(id)) next.add(id);
    }
    newOrphanIdsRef.current = next;
    prevMissingRef.current = missingAnchors;
  }

  const newOrphanIds = newOrphanIdsRef.current;

  // Comment counts per tab (for badges) + comment IDs grouped by file path.
  // Agent-initiated comments (mdr_ask questions) are excluded — they're tracked
  // and surfaced separately via the "Awaiting your reply" section, and they
  // must NOT be sent back to the agent as part of a user batch.
  //
  // A resolved comment is finished in either mode (#159), so it leaves the
  // badge and the Send set whether or not the resolve workflow is on. Resolve
  // mode only decides what happens to a comment once it is addressed. A file
  // can carry resolved markers with the workflow off: one resolved in an
  // earlier resolve-mode session, by an agent session started with it on, by
  // a collaborator, or by hand. Every surface shows those as resolved too, so
  // nothing offers a reply that would never be sent.
  const { commentCounts, resolvedCommentCounts, commentIdsByFile, agentCommentCounts } =
    useMemo(() => {
      const counts = new Map<string, number>();
      const resolvedCounts = new Map<string, number>();
      const idsByFile = new Map<string, string[]>();
      const agentCounts = new Map<string, number>();
      const isCounted = (c: MdComment) => getEffectiveStatus(c) !== 'resolved';
      for (const tab of tabs) {
        if (tab.filePath === activeFilePath) {
          const userComments = comments.filter((c) => !c.agentInitiated);
          const countedComments = userComments.filter(isCounted);
          counts.set(tab.filePath, countedComments.length);
          idsByFile.set(
            tab.filePath,
            countedComments.map((c) => c.id),
          );
          resolvedCounts.set(
            tab.filePath,
            userComments.filter((c) => getEffectiveStatus(c) === 'resolved').length,
          );
          const agentComments = comments.filter(
            (c) => c.agentInitiated && getEffectiveStatus(c) !== 'resolved',
          );
          agentCounts.set(tab.filePath, agentComments.length);
        } else {
          try {
            const { comments: tabComments } = parseComments(tab.rawMarkdown);
            const userTabComments = tabComments.filter((c) => !c.agentInitiated);
            const countedTabComments = userTabComments.filter(isCounted);
            counts.set(tab.filePath, countedTabComments.length);
            idsByFile.set(
              tab.filePath,
              countedTabComments.map((c) => c.id),
            );
            resolvedCounts.set(
              tab.filePath,
              userTabComments.filter((c) => getEffectiveStatus(c) === 'resolved').length,
            );
            const agentTabComments = tabComments.filter(
              (c) => c.agentInitiated && getEffectiveStatus(c) !== 'resolved',
            );
            agentCounts.set(tab.filePath, agentTabComments.length);
          } catch {
            counts.set(tab.filePath, 0);
          }
        }
      }
      return {
        commentCounts: counts,
        resolvedCommentCounts: resolvedCounts,
        commentIdsByFile: idsByFile,
        agentCommentCounts: agentCounts,
      };
    }, [tabs, activeFilePath, comments]);

  // Threads the reviewer replied to after the agent's last reply, each mapped
  // to that reply's key (id plus a hash of its text). A sent thread is pending
  // again for a reply, or an edit of one, that has not gone out yet, so a reply
  // alone enables Send.
  const userRepliedLast = useMemo(() => {
    const lastReplyKeys = new Map<string, string>();
    for (const tab of tabs) {
      let tabComments = comments;
      if (tab.filePath !== activeFilePath) {
        try {
          tabComments = parseComments(tab.rawMarkdown).comments;
        } catch {
          continue;
        }
      }
      const userTabComments = tabComments.filter((c) => !c.agentInitiated);
      for (const [id, replyKey] of computeUserRepliedLast(userTabComments)) {
        lastReplyKeys.set(id, replyKey);
      }
    }
    return lastReplyKeys;
  }, [tabs, activeFilePath, comments]);

  const commentCount = comments.filter((c) => getEffectiveStatus(c) !== 'resolved').length;

  // Core update helper — synchronously updates the ref so back-to-back
  // mutations (e.g. rapid keyboard shortcuts) each read the latest state.
  const updateAndSave = useCallback(
    (newRaw: string) => {
      rawMarkdownRef.current = newRaw;
      setRawMarkdown(newRaw);
      saveFile(newRaw);
    },
    [setRawMarkdown, saveFile, rawMarkdownRef],
  );

  // An Undo toast outlives the render that showed it, so its click handler
  // reads the active file path through a ref rather than closing over the one
  // from the moment of the delete.
  const activeFilePathRef = useRef(activeFilePath);
  activeFilePathRef.current = activeFilePath;

  // After a single comment or reply is deleted, offer to put it back: in the
  // toast, and through the shared undo slot (Cmd+Z, the palette) once the
  // toast is gone. The undo restores the whole pre-delete document, so it only
  // runs when nothing else has touched the file since: the same file is still
  // open and the markdown is exactly what the delete wrote. Anything else (an
  // agent edit, another comment action, a different tab) would be silently
  // overwritten by `before`.
  const offerDeleteUndo = useCallback(
    (
      kind: 'comment-delete' | 'reply-delete',
      message: string,
      restoredMessage: string,
      before: string,
      after: string,
      onRestored?: () => void,
    ) => {
      const filePath = activeFilePathRef.current;
      const entry: UndoEntry = {
        kind,
        what: 'delete',
        filePath,
        run: () => {
          // Already undone (the toast's Undo after Cmd+Z), or a newer undo
          // replaced it.
          if (!undoHolds(entry)) return;
          // Only the toast's Undo gets here from another file. The delete
          // stays kept, so Cmd+Z still undoes it once its own file is back.
          if (activeFilePathRef.current !== filePath) {
            showToast("Couldn't undo. The delete was in another file.", 'error');
            return;
          }
          // On its own file the delete is used up whether or not it restores.
          takeUndo(entry);
          if (rawMarkdownRef.current !== after) {
            showToast("Couldn't undo. The file changed after the delete.", 'error');
            return;
          }
          // The path check above means this delete-time writer still targets
          // the open file, and saveFileAt reads the file's mtime when it runs.
          updateAndSave(before);
          onRestored?.();
          showToast(restoredMessage, 'info');
        },
        isCurrent: () => activeFilePathRef.current === filePath && rawMarkdownRef.current === after,
      };
      offerUndo(entry);
      showToast(message, 'info', { label: 'Undo', onClick: entry.run });
    },
    [showToast, rawMarkdownRef, updateAndSave, offerUndo, undoHolds, takeUndo],
  );

  const handleAddComment = useCallback(
    (
      anchor: string,
      text: string,
      contextBefore?: string,
      contextAfter?: string,
      hintOffset?: number,
    ) => {
      const newCommentId = randomId();
      const newRaw = insertComment(
        rawMarkdownRef.current ?? '',
        anchor,
        text,
        author,
        contextBefore,
        contextAfter,
        hintOffset,
        newCommentId,
      );
      // insertComment returns the document unchanged when it cannot place the
      // marker (anchor not found in the source). Saving that as if it worked
      // loses the comment with no marker, no error, and a focus request for an
      // id that was never written. The MCP route already reports this case;
      // the UI used to swallow it.
      if (newRaw === (rawMarkdownRef.current ?? '')) {
        showToast("Couldn't anchor that comment. Try selecting the text again.", 'error');
        clearSelection();
        setAutoExpandForm(false);
        return;
      }
      updateAndSave(newRaw);
      requestCommentFocus(newCommentId, 'creation');
      clearSelection();
      setAutoExpandForm(false);
    },
    [
      updateAndSave,
      clearSelection,
      author,
      rawMarkdownRef,
      requestCommentFocus,
      setAutoExpandForm,
      showToast,
    ],
  );

  const handleResolve = useCallback(
    (id: string) => {
      updateAndSave(resolveComment(rawMarkdownRef.current ?? '', id));
    },
    [updateAndSave, rawMarkdownRef],
  );

  const handleUnresolve = useCallback(
    (id: string) => {
      updateAndSave(unresolveComment(rawMarkdownRef.current ?? '', id));
    },
    [updateAndSave, rawMarkdownRef],
  );

  const handleDelete = useCallback(
    (id: string) => {
      const before = rawMarkdownRef.current ?? '';
      const after = removeComment(before, id);
      updateAndSave(after);
      setActiveCommentId((prev) => (prev === id ? null : prev));
      // Nothing was removed (unknown id): there is nothing to undo, and a toast
      // would replace a still-live Undo for a real delete.
      if (after === before) return;
      // The same request "Jump to agent question" makes: scroll to the card,
      // focus it, and select it in Anchored density.
      offerDeleteUndo(
        'comment-delete',
        'Comment deleted.',
        'Comment restored.',
        before,
        after,
        () => requestCommentFocus(id, 'jump'),
      );
    },
    [updateAndSave, rawMarkdownRef, offerDeleteUndo, requestCommentFocus],
  );

  const handleEdit = useCallback(
    (id: string, newText: string) => {
      updateAndSave(editComment(rawMarkdownRef.current ?? '', id, newText));
    },
    [updateAndSave, rawMarkdownRef],
  );

  const handleReply = useCallback(
    (id: string, text: string) => {
      updateAndSave(addReply(rawMarkdownRef.current ?? '', id, text, author));
    },
    [updateAndSave, author, rawMarkdownRef],
  );

  const handleEditReply = useCallback(
    (commentId: string, replyId: string, newText: string) => {
      updateAndSave(editReply(rawMarkdownRef.current ?? '', commentId, replyId, newText));
    },
    [updateAndSave, rawMarkdownRef],
  );

  const handleDeleteReply = useCallback(
    (commentId: string, replyId: string) => {
      const before = rawMarkdownRef.current ?? '';
      const after = removeReply(before, commentId, replyId);
      updateAndSave(after);
      if (after === before) return;
      offerDeleteUndo('reply-delete', 'Reply deleted.', 'Reply restored.', before, after);
    },
    [updateAndSave, rawMarkdownRef, offerDeleteUndo],
  );

  const handleBulkDelete = useCallback(() => {
    updateAndSave(removeAllComments(rawMarkdownRef.current ?? ''));
  }, [updateAndSave, rawMarkdownRef]);

  const handleBulkResolve = useCallback(() => {
    updateAndSave(resolveAllComments(rawMarkdownRef.current ?? ''));
  }, [updateAndSave, rawMarkdownRef]);

  const handleBulkDeleteResolved = useCallback(() => {
    updateAndSave(removeResolvedComments(rawMarkdownRef.current ?? ''));
  }, [updateAndSave, rawMarkdownRef]);

  const handleCopyAgentPrompt = useCallback(
    (filePaths: string[]) => {
      if (filePaths.length === 0) return;
      const prompt = buildAddressCommentsPrompt({
        filePaths,
        commentCounts,
        enableResolve,
      });

      const fileCount = filePaths.length;
      navigator.clipboard.writeText(prompt).then(
        () =>
          showToast(
            `Copied agent instructions for ${fileCount} file${fileCount !== 1 ? 's' : ''}. Now tracking changes.`,
            'success',
          ),
        // The clipboard API needs a secure context. "Try from localhost" was
        // wrong advice for anyone reaching md-redline through a proxy, which
        // MD_REDLINE_ALLOWED_HOSTS now makes a supported setup.
        () => showToast("Couldn't copy to clipboard. Needs https:// or localhost.", 'error'),
      );
    },
    [commentCounts, showToast, enableResolve],
  );

  const handleHighlightClick = useCallback((commentId: string) => {
    setActiveCommentId(commentId);
  }, []);

  const handleSidebarActivate = useCallback(
    (commentId: string) => {
      setActiveCommentId(commentId);
      viewerRef.current?.scrollToComment(commentId);
      rawViewRef.current?.scrollToComment(commentId);
    },
    [viewerRef, rawViewRef],
  );

  const handleAnchorChange = useCallback(
    (commentIds: string[], newAnchor: string) => {
      let newRaw = rawMarkdownRef.current ?? '';
      for (const id of commentIds) {
        newRaw = updateCommentAnchor(newRaw, id, newAnchor);
      }
      updateAndSave(newRaw);
    },
    [updateAndSave, rawMarkdownRef],
  );

  const handleReanchorToSelection = useCallback(
    (commentId: string, newAnchor: string, hintOffset?: number) => {
      const next = moveComment(rawMarkdownRef.current ?? '', commentId, newAnchor, hintOffset);
      updateAndSave(next);
    },
    [updateAndSave, rawMarkdownRef],
  );

  // Document order, not array order: markers relocated out of frontmatter or a
  // code fence share one offset, so the raw array visits them in the order they
  // were written rather than the order they appear.
  const orderedComments = useMemo(
    () => orderCommentsByAnchor(cleanMarkdown, comments),
    [cleanMarkdown, comments],
  );

  // Open comments only, in either mode: a resolved one has no card in the
  // Anchored rail to land on.
  const handleJumpToNext = useCallback(() => {
    const navigable = orderedComments.filter((c) => getEffectiveStatus(c) === 'open');
    if (navigable.length === 0) return;

    const currentIdx = activeCommentId ? navigable.findIndex((c) => c.id === activeCommentId) : -1;
    const nextIdx = (currentIdx + 1) % navigable.length;
    const next = navigable[nextIdx];
    setActiveCommentId(next.id);
    viewerRef.current?.scrollToComment(next.id);
    rawViewRef.current?.scrollToComment(next.id);
  }, [orderedComments, activeCommentId, viewerRef, rawViewRef]);

  const handleJumpToPrev = useCallback(() => {
    const navigable = orderedComments.filter((c) => getEffectiveStatus(c) === 'open');
    if (navigable.length === 0) return;

    const currentIdx = activeCommentId ? navigable.findIndex((c) => c.id === activeCommentId) : -1;
    const prevIdx = currentIdx <= 0 ? navigable.length - 1 : currentIdx - 1;
    const prev = navigable[prevIdx];
    setActiveCommentId(prev.id);
    viewerRef.current?.scrollToComment(prev.id);
    rawViewRef.current?.scrollToComment(prev.id);
  }, [orderedComments, activeCommentId, viewerRef, rawViewRef]);

  return {
    activeCommentId,
    setActiveCommentId,
    comments,
    cleanMarkdown,
    html,
    missingAnchors,
    newOrphanIds,
    commentCounts,
    resolvedCommentCounts,
    commentIdsByFile,
    userRepliedLast,
    agentCommentCounts,
    commentCount,
    updateAndSave,
    handleAddComment,
    handleResolve,
    handleUnresolve,
    handleDelete,
    handleEdit,
    handleReply,
    handleEditReply,
    handleDeleteReply,
    handleBulkDelete,
    handleBulkResolve,
    handleBulkDeleteResolved,
    handleCopyAgentPrompt,
    handleHighlightClick,
    handleSidebarActivate,
    handleAnchorChange,
    handleReanchorToSelection,
    handleJumpToNext,
    handleJumpToPrev,
  };
}
