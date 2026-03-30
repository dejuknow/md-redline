import { useState, useCallback } from 'react';

export function useCommentCardTriggers() {
  const [requestEditId, setRequestEditId] = useState<string | null>(null);
  const [requestEditToken, setRequestEditToken] = useState(0);
  const [requestReplyId, setRequestReplyId] = useState<string | null>(null);
  const [requestReplyToken, setRequestReplyToken] = useState(0);

  const triggerEdit = useCallback((commentId: string) => {
    setRequestEditId(commentId);
    setRequestEditToken(Date.now());
  }, []);

  const triggerReply = useCallback((commentId: string) => {
    setRequestReplyId(commentId);
    setRequestReplyToken(Date.now());
  }, []);

  return {
    requestEditId,
    requestEditToken,
    requestReplyId,
    requestReplyToken,
    triggerEdit,
    triggerReply,
  };
}
