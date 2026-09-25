import { execFile } from 'node:child_process';

const TIMEOUT_MS = 180_000; // 3 minutes

// Pinned so scores stay comparable across runs. Left to the CLI default, a
// model upgrade shows up as an unexplained score change.
export const DEFAULT_MODEL = 'claude-opus-5-5';
let model = DEFAULT_MODEL;

export function setClaudeModel(m: string): void {
  model = m;
}

/** Shared claude CLI invocation used by every claude-based adapter. */
export function runClaude(prompt: string, cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'claude',
      ['-p', prompt, '--model', model, '--allowedTools', 'Read,Edit,Write'],
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
