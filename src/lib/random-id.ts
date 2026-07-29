/**
 * A UUID v4 that works outside a secure context.
 *
 * `crypto.randomUUID` is secure-context only, so it is undefined when the app
 * is served over plain HTTP from anything other than localhost. That is exactly
 * what happens when you reach md-redline from another device on the LAN, and
 * the failure is bad: creating a comment threw a TypeError mid-save, so the
 * comment silently never appeared.
 *
 * `crypto.getRandomValues` carries no such restriction, so the fallback is a
 * real v4 from the same entropy source rather than a downgrade to Math.random.
 * Both paths require `crypto` itself, which every browser this app supports has
 * regardless of secure context; only `randomUUID` and `subtle` are gated.
 */
// Byte-to-hex table, built once rather than per call.
const HEX = Array.from({ length: 256 }, (_, i) => (i + 0x100).toString(16).slice(1));

export function randomId(): string {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  // Set the version (4) and variant (10xx) bits.
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const b = Array.from(bytes, (v) => HEX[v]);
  return `${b[0]}${b[1]}${b[2]}${b[3]}-${b[4]}${b[5]}-${b[6]}${b[7]}-${b[8]}${b[9]}-${b[10]}${b[11]}${b[12]}${b[13]}${b[14]}${b[15]}`;
}
