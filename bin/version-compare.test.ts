import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isNewerVersion, readInstalledVersion } from './version-compare.js';

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

describe('readInstalledVersion (#134)', () => {
  it('reads the version on disk each time, so an upgrade under a running process is seen', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mdr-version-'));
    try {
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: '0.9.1' }));
      expect(readInstalledVersion(dir)).toBe('0.9.1');
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: '0.9.2' }));
      expect(readInstalledVersion(dir)).toBe('0.9.2');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is null when package.json is missing, half-written, or has no version', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mdr-version-'));
    try {
      expect(readInstalledVersion(dir)).toBeNull();
      writeFileSync(join(dir, 'package.json'), '{"version": "0.9');
      expect(readInstalledVersion(dir)).toBeNull();
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'md-redline' }));
      expect(readInstalledVersion(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
