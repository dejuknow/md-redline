export const FALLBACK_PORT: number;
export function resolvePort(
  env: Record<string, string | undefined>,
  names: readonly string[],
  fallback: number,
): number;
export function resolveApiPort(env?: Record<string, string | undefined>): number;
