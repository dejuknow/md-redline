import { execFile } from 'node:child_process';

const TIMEOUT_MS = 180_000; // 3 minutes

/** Shared claude CLI invocation used by every claude-based adapter. */
export function runClaude(prompt: string, cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'claude',
      ['-p', prompt, '--allowedTools', 'Read,Edit,Write'],
      { cwd, timeout: TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`claude-cli failed: ${error.message}\nstderr: ${stderr}`));
          return;
        }
        resolve(stdout);
      },
    );
  });
}
