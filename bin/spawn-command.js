/**
 * Build the single command string handed to cmd.exe when spawning with
 * `shell: true` on Windows. Node concatenates command and args WITHOUT
 * quoting in that mode (the DEP0190 footgun), so a stock node.exe under
 * "C:\Program Files" split at the space and cmd ran "C:\Program": the
 * child died instantly and the CLI reported "app failed to start".
 *
 * Parts are quoted only when cmd.exe would split or misparse them, so
 * clean invocations keep their exact historical shape (npm.cmd run dev,
 * cmd /c start "" <url>). Quoting is plain double-quote wrapping with no
 * escape handling: the quote character is illegal in Windows paths, and
 * every URL we pass has gone through encodeURIComponent (%22). Percent
 * signs are left alone because quoting does not stop %VAR% expansion
 * anyway.
 */

// Whitespace splits words; & | < > ^ ( ) are cmd operators; , ; = are
// token delimiters for cmd builtins like `start`.
const NEEDS_QUOTING = /[\s&|<>^(),;=]/;

export function buildWindowsCommand(command, args = []) {
  return [command, ...args]
    .map((part) => (part === '' || NEEDS_QUOTING.test(part) ? `"${part}"` : part))
    .join(' ');
}
