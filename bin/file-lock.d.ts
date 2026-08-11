export const LOCK_SUFFIX: string;
export const LOCK_STALE_MS: number;
export const LOCK_MAX_WAIT_MS: number;

/**
 * Thrown when the attempt budget runs out, as opposed to a filesystem error,
 * which is rethrown with its errno intact.
 */
export class LockContentionError extends Error {
  constructor(lockPath: string, cause?: unknown);
  readonly code: 'ELOCKBUSY';
  readonly lockPath: string;
}

export function acquireFileLock(filePath: string): Promise<() => Promise<void>>;
