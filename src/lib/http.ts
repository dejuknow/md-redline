export interface ApiErrorPayload {
  error?: string;
}

export async function readJsonResponse<T>(res: Response): Promise<T | null> {
  const text = await res.text();
  if (!text) return null;

  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

export function getApiErrorMessage(res: Response, data: unknown, fallback: string): string {
  if (data && typeof data === 'object' && 'error' in data) {
    const error = (data as ApiErrorPayload).error;
    if (typeof error === 'string' && error.trim()) {
      return error;
    }
  }

  if (res.status === 502 || res.status === 503 || res.status === 504) {
    return 'Backend unavailable. Start the md-redline server.';
  }

  return fallback;
}
