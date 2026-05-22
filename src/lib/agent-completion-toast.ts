import type { MdComment } from '../types';
import type { ReviewSession } from '../hooks/useReviewSession';
import type { PendingAskSummary } from '../components/ReviewBanner';

export interface AgentCompletionInfo {
  sessionId: string;
  agentName: string;
  commentCount: number;
}

/**
 * Determines which agent-origin sessions have completed fire-and-forget reviews
 * and should fire a completion toast.
 *
 * A session is considered "done" when:
 * 1. It has `origin === 'agent'`
 * 2. It has at least one agent-initiated comment (`agentInitiated === true && sessionId === session.id`)
 * 3. It has no pending asks (i.e. the agent is not waiting for replies)
 * 4. Its ID is not already in `alreadyToasted`
 *
 * The caller is responsible for updating `alreadyToasted` after acting on the result.
 */
export function detectAgentCompletions(
  sessions: ReviewSession[],
  /** Comments grouped by file path — typically from all open tabs */
  commentsByFile: Map<string, MdComment[]>,
  pendingAsksBySession: Map<string, PendingAskSummary>,
  alreadyToasted: Set<string>,
): AgentCompletionInfo[] {
  const results: AgentCompletionInfo[] = [];

  for (const session of sessions) {
    if (session.origin !== 'agent') continue;
    if (alreadyToasted.has(session.id)) continue;

    let agentCommentCount = 0;
    let firstAuthor: string | undefined;

    for (const filePath of session.filePaths) {
      const fileParsedComments = commentsByFile.get(filePath);
      if (!fileParsedComments) continue;
      for (const c of fileParsedComments) {
        if (c.agentInitiated === true && c.sessionId === session.id) {
          agentCommentCount++;
          if (!firstAuthor && c.author) firstAuthor = c.author;
        }
      }
    }

    if (agentCommentCount === 0) continue;

    const hasPendingAsks = (pendingAsksBySession.get(session.id)?.commentIds.length ?? 0) > 0;
    if (hasPendingAsks) continue;

    results.push({
      sessionId: session.id,
      agentName: firstAuthor ?? 'Agent',
      commentCount: agentCommentCount,
    });
  }

  return results;
}
