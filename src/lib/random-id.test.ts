import { describe, it, expect, afterEach, vi } from 'vitest';
import { randomId } from './random-id';

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('randomId', () => {
  it('uses crypto.randomUUID when it exists', () => {
    const spy = vi.spyOn(crypto, 'randomUUID');
    expect(randomId()).toMatch(V4);
    expect(spy).toHaveBeenCalled();
  });

  // The whole reason this helper exists. crypto.randomUUID is secure-context
  // only, so it is undefined when the app is served over plain HTTP from
  // anything but localhost, which is how md-redline is reached from a tablet on
  // the LAN. Neither node nor jsdom reproduces that, so without this test the
  // fallback branch never executes in CI and a later simplification could break
  // comment creation on that path while staying green.
  describe('without crypto.randomUUID (non-secure context)', () => {
    // `delete crypto.randomUUID` does not work: it is non-configurable in
    // Node's webcrypto. Stubbing the global with an object that simply lacks it
    // is what a non-secure context actually looks like to the helper.
    const withoutRandomUUID = <T>(fn: () => T): T => {
      const realGetRandomValues = crypto.getRandomValues.bind(crypto);
      vi.stubGlobal('crypto', {
        getRandomValues: (b: Uint8Array) => realGetRandomValues(b),
      });
      try {
        return fn();
      } finally {
        vi.unstubAllGlobals();
      }
    };

    it('still returns a well-formed v4', () => {
      withoutRandomUUID(() => {
        expect(crypto.randomUUID).toBeUndefined();
        expect(randomId()).toMatch(V4);
      });
    });

    it('sets the version and variant bits, not just the shape', () => {
      withoutRandomUUID(() => {
        // getRandomValues returning all zeroes isolates the bit math from
        // entropy: version must be 4 and the variant nibble must be 8.
        vi.stubGlobal('crypto', {
          getRandomValues: (b: Uint8Array) => {
            b.fill(0);
            return b;
          },
        });
        expect(randomId()).toBe('00000000-0000-4000-8000-000000000000');
      });
    });

    it('does not repeat across many draws', () => {
      withoutRandomUUID(() => {
        const ids = new Set(Array.from({ length: 5000 }, () => randomId()));
        expect(ids.size).toBe(5000);
      });
    });
  });
});
