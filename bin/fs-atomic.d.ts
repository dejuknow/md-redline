export const FS_MAX_ATTEMPTS: number;
export const FS_RETRY_BASE_MS: number;
export const FS_RETRY_BUDGET_MS: number;
export function isTransientFsError(err: unknown): boolean;
export function sleep(ms: number): Promise<void>;
export function retryTransient<T>(op: () => Promise<T>): Promise<T>;
export function retryTransientSync<T>(op: () => T): T;
export function atomicWriteFile(path: string, content: string): Promise<void>;
