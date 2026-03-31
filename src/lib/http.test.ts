import { describe, expect, it } from 'vitest';
import { getApiErrorMessage, readJsonResponse } from './http';

describe('readJsonResponse', () => {
  it('parses valid JSON', async () => {
    const res = new Response(JSON.stringify({ ok: true }), {
      headers: { 'Content-Type': 'application/json' },
    });

    await expect(readJsonResponse<{ ok: boolean }>(res)).resolves.toEqual({ ok: true });
  });

  it('returns null for empty bodies', async () => {
    const res = new Response('', { status: 502 });

    await expect(readJsonResponse(res)).resolves.toBeNull();
  });

  it('returns null for invalid JSON', async () => {
    const res = new Response('not-json');

    await expect(readJsonResponse(res)).resolves.toBeNull();
  });
});

describe('getApiErrorMessage', () => {
  it('prefers an api error payload', () => {
    const res = new Response('', { status: 400 });
    expect(getApiErrorMessage(res, { error: 'Bad request' }, 'Fallback')).toBe('Bad request');
  });

  it('maps gateway failures to a backend-unavailable message', () => {
    const res = new Response('', { status: 502 });
    expect(getApiErrorMessage(res, null, 'Fallback')).toBe(
      'Backend unavailable. Start the md-redline server.',
    );
  });

  it('falls back when no api error payload exists', () => {
    const res = new Response('', { status: 500 });
    expect(getApiErrorMessage(res, null, 'Fallback')).toBe('Fallback');
  });
});
