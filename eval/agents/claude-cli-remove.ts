import { readFile, mkdtemp, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildAddressCommentsPrompt } from '../../src/lib/agent-prompts.js';
import { parseComments } from '../../src/lib/comment-parser.js';
import { runClaude } from './run-claude.js';
import type { AgentAdapter } from '../types.js';

/**
 * Remove-mode adapter driving the SHIPPED prompt.
 *
 * `claude-cli` also runs remove mode, but against a hand-written preamble that
 * tells the agent to delete every marker and to leave the file with none. That
 * is the old contract, and because it is hard-coded here rather than imported,
 * the real remove-mode hand-off text was never under test at all. A defect in
 * it reached a user's review instead: a comment that asked a question was
 * deleted along with the question, and no answer was recorded anywhere.
 *
 * This adapter closes that gap the way `claude-cli-resolve` does for the other
 * mode. It hands over exactly what the app produces, so the wording itself is
 * what gets scored.
 */
export const claudeCliRemove: AgentAdapter = {
  name: 'claude-cli-remove',
  markerMode: 'remove',

  async run(inputPath: string, casePrompt: string): Promise<string> {
    const tempDir = await mkdtemp(join(tmpdir(), 'md-eval-remove-'));
    const tempFile = join(tempDir, 'input.md');

    try {
      await cp(inputPath, tempFile);

      const raw = await readFile(tempFile, 'utf-8');
      const { comments } = parseComments(raw);

      const handoff = buildAddressCommentsPrompt({
        filePaths: [tempFile],
        commentCounts: new Map([[tempFile, comments.length]]),
        enableResolve: false,
      });

      await runClaude(`${handoff}\n\n## This review\n\n${casePrompt}`, tempDir);

      return await readFile(tempFile, 'utf-8');
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  },
};
