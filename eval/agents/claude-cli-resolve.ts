import { readFile, mkdtemp, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildAddressCommentsPrompt } from '../../src/lib/agent-prompts.js';
import { parseComments } from '../../src/lib/comment-parser.js';
import { runClaude } from './run-claude.js';
import type { AgentAdapter } from '../types.js';

/**
 * Resolve-mode adapter. Where `claude-cli` hands the agent a hand-written
 * summary of the marker contract and asks it to delete markers, this one hands
 * it the exact prompt the app's "copy hand-off" button produces, in the mode
 * the app ships by default: markers stay in the file, gain a reply, and are
 * marked resolved.
 *
 * Using the shipped prompt verbatim is the point. It puts the real wording
 * under test, so a regression in the hand-off text — an anchor rule that stops
 * landing, an instruction the model reads past — shows up as a score drop
 * rather than as a surprise in someone's review session.
 */
export const claudeCliResolve: AgentAdapter = {
  name: 'claude-cli-resolve',
  markerMode: 'resolve',

  async run(inputPath: string, casePrompt: string): Promise<string> {
    const tempDir = await mkdtemp(join(tmpdir(), 'md-eval-resolve-'));
    const tempFile = join(tempDir, 'input.md');

    try {
      await cp(inputPath, tempFile);

      const raw = await readFile(tempFile, 'utf-8');
      const { comments } = parseComments(raw);

      const handoff = buildAddressCommentsPrompt({
        filePaths: [tempFile],
        commentCounts: new Map([[tempFile, comments.length]]),
        enableResolve: true,
      });

      await runClaude(`${handoff}\n\n## This review\n\n${casePrompt}`, tempDir);

      return await readFile(tempFile, 'utf-8');
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  },
};
