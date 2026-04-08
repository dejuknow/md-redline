import {
  useState,
  useMemo,
  useCallback,
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
  resolveComment,
  unresolveComment,
  addReply,
  removeReply,
  removeAllComments,
  resolveAllComments,
  removeResolvedComments,
  detectMissingAnchors,
} from '../lib/comment-parser';
import { getEffectiveStatus } from '../types';
import { renderMarkdown } from '../markdown/pipeline';
import type { MarkdownViewerHandle } from '../components/MarkdownViewer';
import type { RawViewHandle } from '../components/RawView';
import { buildAddressCommentsPrompt } from '../lib/agent-prompts';

interface TabInfo {
  filePath: string;
  rawMarkdown: string;
}

export interface UseCommentsParams {
  rawMarkdown: string | undefined;
  rawMarkdownRef: RefObject<string | undefined>;
  setRawMarkdown: (content: string) => void;
  saveFile: (content: string) => void;
  author: string;
  enableResolve: boolean;
  tabs: TabInfo[];
  activeFilePath: string | null;
  viewerRef: RefObject<MarkdownViewerHandle | null>;
  rawViewRef: RefObject<RawViewHandle | null>;
  showToast: (msg: string) => void;
  clearSelection: () => void;
  setAutoExpandForm: Dispatch<SetStateAction<boolean>>;
  requestCommentFocus: (commentId: string) => void;
}

export function useComments(params: UseCommentsParams) {
  const {
    rawMarkdown,
    rawMarkdownRef,
    setRawMarkdown,
    saveFile,
    author,
    enableResolve,
    tabs,
    activeFilePath,
    viewerRef,
    rawViewRef,
    showToast,
    clearSelection,
    setAutoExpandForm,
    requestCommentFocus,
  } = params;

  const [activeCommentId, setActiveCommentId] = useState<string | null>(null);

  // Parse comments from raw markdown
  const { cleanMarkdown, comments } = useMemo(
    () => parseComments(rawMarkdown ?? ''),
    [rawMarkdown],
  );

  // Render markdown to HTML
  const html = useMemo(
    () => (cleanMarkdown ? renderMarkdown(cleanMarkdown, activeFilePath ?? undefined) : ''),
    [cleanMarkdown, activeFilePath],
  );

  // Detect missing anchors
  const missingAnchors = useMemo(
    () => detectMissingAnchors(cleanMarkdown, comments),
    [cleanMarkdown, comments],
  );

  // Comment counts per tab (for badges)
  const { commentCounts, resolvedCommentCounts } = useMemo(() => {
    const counts = new Map<string, number>();
    const resolvedCounts = new Map<string, number>();
    for (const tab of tabs) {
      if (tab.filePath === activeFilePath) {
        const count = enableResolve
          ? comments.filter((c) => getEffectiveStatus(c) !== 'resolved').length
          : comments.length;
        counts.set(tab.filePath, count);
        if (enableResolve) {
          resolvedCounts.set(
            tab.filePath,
            comments.filter((c) => getEffectiveStatus(c) === 'resolved').length,
          );
        }
      } else {
        try {
          const { comments: tabComments } = parseComments(tab.rawMarkdown);
          const count = enableResolve
            ? tabComments.filter((c) => getEffectiveStatus(c) !== 'resolved').length
            : tabComments.length;
          counts.set(tab.filePath, count);
          if (enableResolve) {
            resolvedCounts.set(
              tab.filePath,
              tabComments.filter((c) => getEffectiveStatus(c) === 'resolved').length,
            );
          }
        } catch {
          counts.set(tab.filePath, 0);
        }
      }
    }
    return { commentCounts: counts, resolvedCommentCounts: resolvedCounts };
  }, [tabs, activeFilePath, comments, enableResolve]);

  const commentCount = enableResolve
    ? comments.filter((c) => getEffectiveStatus(c) !== 'resolved').length
    : comments.length;

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

  const handleAddComment = useCallback(
    (
      anchor: string,
      text: string,
      contextBefore?: string,
      contextAfter?: string,
      hintOffset?: number,
    ) => {
      const newCommentId = crypto.randomUUID();
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
      updateAndSave(newRaw);
      setActiveCommentId(newCommentId);
      requestCommentFocus(newCommentId);
      clearSelection();
      setAutoExpandForm(false);
    },
    [updateAndSave, clearSelection, author, rawMarkdownRef, requestCommentFocus, setAutoExpandForm],
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
      updateAndSave(removeComment(rawMarkdownRef.current ?? '', id));
      setActiveCommentId((prev) => (prev === id ? null : prev));
    },
    [updateAndSave, rawMarkdownRef],
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
      updateAndSave(removeReply(rawMarkdownRef.current ?? '', commentId, replyId));
    },
    [updateAndSave, rawMarkdownRef],
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
            `Copied agent instructions for ${fileCount} file${fileCount !== 1 ? 's' : ''} (snapshot saved)`,
          ),
        () => showToast("Couldn't copy to clipboard. Try from localhost."),
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

  const handleJumpToNext = useCallback(() => {
    const navigable = enableResolve
      ? comments.filter((c) => getEffectiveStatus(c) === 'open')
      : comments;
    if (navigable.length === 0) return;

    const currentIdx = activeCommentId ? navigable.findIndex((c) => c.id === activeCommentId) : -1;
    const nextIdx = (currentIdx + 1) % navigable.length;
    const next = navigable[nextIdx];
    setActiveCommentId(next.id);
    viewerRef.current?.scrollToComment(next.id);
    rawViewRef.current?.scrollToComment(next.id);
  }, [comments, activeCommentId, enableResolve, viewerRef, rawViewRef]);

  const handleJumpToPrev = useCallback(() => {
    const navigable = enableResolve
      ? comments.filter((c) => getEffectiveStatus(c) === 'open')
      : comments;
    if (navigable.length === 0) return;

    const currentIdx = activeCommentId ? navigable.findIndex((c) => c.id === activeCommentId) : -1;
    const prevIdx = currentIdx <= 0 ? navigable.length - 1 : currentIdx - 1;
    const prev = navigable[prevIdx];
    setActiveCommentId(prev.id);
    viewerRef.current?.scrollToComment(prev.id);
    rawViewRef.current?.scrollToComment(prev.id);
  }, [comments, activeCommentId, enableResolve, viewerRef, rawViewRef]);

  return {
    activeCommentId,
    setActiveCommentId,
    comments,
    cleanMarkdown,
    html,
    missingAnchors,
    commentCounts,
    resolvedCommentCounts,
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
    handleJumpToNext,
    handleJumpToPrev,
  };
}
