import { describe, expect, it } from 'vitest';
import { isNewerVersion } from './version-compare.js';

describe('isNewerVersion', () => {
  it('detects strictly newer x.y.z versions', () => {
    expect(isNewerVersion('0.7.0', '0.6.0')).toBe(true);
    expect(isNewerVersion('1.0.0', '0.9.9')).toBe(true);
    expect(isNewerVersion('0.6.10', '0.6.9')).toBe(true); // numeric, not lexicographic
  });

  it('rejects equal and older versions', () => {
    expect(isNewerVersion('0.6.0', '0.6.0')).toBe(false);
    expect(isNewerVersion('0.5.9', '0.6.0')).toBe(false);
  });

  it('conservatively rejects prerelease and malformed input', () => {
    expect(isNewerVersion('0.7.0-beta.1', '0.6.0')).toBe(false);
    expect(isNewerVersion('0.7.0', '0.6.0-beta.1')).toBe(false);
    expect(isNewerVersion('1.2', '0.6.0')).toBe(false);
    expect(isNewerVersion('banana', '0.6.0')).toBe(false);
    expect(isNewerVersion(undefined, '0.6.0')).toBe(false);
    expect(isNewerVersion('0.7.0', undefined)).toBe(false);
  });
});
