import type { MdComment } from '../types';

export function selectAgentAsks(comments: MdComment[], activeSessionId: string | null): MdComment[] {
  if (!activeSessionId) return [];
  return comments.filter((c) => c.agentInitiated === true && c.sessionId === activeSessionId);
}
