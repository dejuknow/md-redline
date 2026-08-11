/**
 * Server-side view of the crash-safe write helpers. The implementation lives
 * in `bin/fs-atomic.js` because the CLI is plain JS shipped as is and cannot
 * import a `.ts` module, yet writes the same two files this server does: the
 * user's `.md-redline.json` and, on `mdr mcp install`, a JSON config another
 * process owns. One implementation, imported from both sides, is the only way
 * those stay in step. `server/env.ts` has the same arrangement with
 * `bin/ports.js`.
 */
export {
  atomicWriteFile,
  FS_MAX_ATTEMPTS,
  FS_RETRY_BASE_MS,
  FS_RETRY_BUDGET_MS,
  isTransientFsError,
  retryTransient,
  retryTransientSync,
  sleep,
} from '../bin/fs-atomic.js';
