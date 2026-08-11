export const LOCK_SUFFIX: string;
export const LOCK_STALE_MS: number;
export const LOCK_MAX_WAIT_MS: number;
export function acquireFileLock(filePath: string): Promise<() => Promise<void>>;
