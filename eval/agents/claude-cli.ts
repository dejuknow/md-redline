import { execFile } from 'node:child_process';
import { readFile, writeFile, mkdtemp, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentAdapter } from '../types.js';

const TIMEOUT_MS = 180_000; // 3 minutes

const SYSTEM_CONTEXT = `You are reviewing a markdown file that contains inline review comments.

Comment format: <!-- @comment{JSON} -->
Each comment marker is placed immediately BEFORE the text it refers to.

The JSON contains these fields:
- "id": unique identifier
- "anchor": the text being commented on
- "text": the reviewer's feedback
- "replies": array of threaded replies with additional context

Your job:
1. Read each comment and understand what change the reviewer is requesting
2. Make the requested changes to the document content
3. After addressing a comment, DELETE its <!-- @comment{JSON} --> marker entirely from the file
4. If a comment has replies, read them for additional context on what changes to make
5. Ensure the final file contains no comment markers — all comments should be addressed and their markers removed`;

export const claudeCli: AgentAdapter = {
  name: 'claude-cli',

  async run(inputPath: string, casePrompt: string): Promise<string> {
    // Create a temp working directory with a copy of the input
    const tempDir = await mkdtemp(join(tmpdir(), 'md-eval-'));
    const tempFile = join(tempDir, 'input.md');

    try {
      await cp(inputPath, tempFile);

      const fullPrompt = `${SYSTEM_CONTEXT}

${casePrompt}

The file to review is at: ${tempFile}

Read the file, make the requested changes, and write the result back to the same path.`;

      await runClaude(fullPrompt, tempDir);

      return await readFile(tempFile, 'utf-8');
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  },
};

function runClaude(prompt: string, cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'claude',
      ['-p', prompt, '--allowedTools', 'Read,Edit,Write'],
      { cwd, timeout: TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(
              `claude-cli failed: ${error.message}\nstderr: ${stderr}`,
            ),
          );
          return;
        }
        resolve(stdout);
      },
    );
  });
}
