import { afterEach, describe, expect, it, vi } from 'vitest';

import { safeRandomUUID } from './uuid';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('safeRandomUUID', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns a valid v4 UUID when crypto.randomUUID is available', () => {
    const id = safeRandomUUID();
    expect(id).toMatch(UUID_RE);
  });

  it('returns unique values across calls', () => {
    const a = safeRandomUUID();
    const b = safeRandomUUID();
    expect(a).not.toBe(b);
  });

  it('falls back to getRandomValues when randomUUID is unavailable', () => {
    // Simulate a non-secure context: keep getRandomValues but blank out
    // randomUUID. Browsers expose getRandomValues in non-secure contexts
    // but withhold randomUUID, which is what triggered the original bug.
    const realCrypto = globalThis.crypto;
    vi.stubGlobal('crypto', {
      getRandomValues: realCrypto.getRandomValues.bind(realCrypto),
    });

    const id = safeRandomUUID();
    expect(id).toMatch(UUID_RE);
    // Verify the version (4) and variant (10xx) bits per RFC 4122 §4.4.
    expect(id[14]).toBe('4');
    expect(['8', '9', 'a', 'b']).toContain(id[19]);
  });

  it('throws when no crypto source is available at all', () => {
    vi.stubGlobal('crypto', undefined);
    expect(() => safeRandomUUID()).toThrow(/no secure random source/i);
  });
});
