import { useState, useCallback } from 'react';
import type { SidebarCommentEditorState } from '../lib/comment-editor-state';

export function useCommentCardTriggers() {
  const [requestedEditor, setRequestedEditor] = useState<SidebarCommentEditorState>(null);

  const triggerEdit = useCallback((commentId: string) => {
    setRequestedEditor({ mode: 'comment-edit', commentId, token: Date.now() });
  }, []);

  const triggerReply = useCallback((commentId: string) => {
    setRequestedEditor({ mode: 'reply-compose', commentId, token: Date.now() });
  }, []);

  return {
    requestedEditor,
    triggerEdit,
    triggerReply,
  };
}
