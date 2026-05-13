/**
 * UUID generation that works in both secure and non-secure browser contexts.
 *
 * `crypto.randomUUID()` is only exposed in secure contexts (HTTPS or
 * loopback origins like `http://localhost`). When mdr is served over
 * plain HTTP from an FQDN (the MDR_HOST workflow for remote dev hosts),
 * `crypto.randomUUID` is undefined and any code that calls it explodes.
 * `crypto.getRandomValues()` IS available in non-secure contexts, so we
 * fall back to a manual RFC 4122 v4 generator built on top of it.
 */
export function safeRandomUUID(): string {
  // Prefer the native API when the platform exposes it. crypto.randomUUID
  // is the gold standard: it uses the same CSPRNG and produces a properly
  // versioned/variant-tagged v4 UUID.
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  // Fallback for non-secure contexts. crypto.getRandomValues is universally
  // available (it predates randomUUID and isn't gated behind secure context).
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    // Set version (4) and variant (10xx) bits per RFC 4122 §4.4.
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex: string[] = [];
    for (let i = 0; i < bytes.length; i++) {
      hex.push(bytes[i].toString(16).padStart(2, '0'));
    }
    return (
      hex.slice(0, 4).join('') +
      '-' +
      hex.slice(4, 6).join('') +
      '-' +
      hex.slice(6, 8).join('') +
      '-' +
      hex.slice(8, 10).join('') +
      '-' +
      hex.slice(10, 16).join('')
    );
  }

  // No crypto at all — should be unreachable in any browser that loads the
  // SPA. Throw so the failure is loud rather than producing a duplicate ID.
  throw new Error('No secure random source available for UUID generation');
}
