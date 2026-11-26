import { mkdtempSync, rmSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, describe, expect, it } from 'vitest';

import { APP_PORT_SCAN, shouldPreferApp } from './app-handoff.js';
import { FALLBACK_PORT } from './ports.js';

const home = mkdtempSync(join(tmpdir(), 'mdr-handoff-home-'));
const other = mkdtempSync(join(tmpdir(), 'mdr-handoff-other-'));

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(other, { recursive: true, force: true });
});

const base = {
  platform: 'darwin',
  browserOverride: '',
  resolvedHome: home,
  userHome: home,
  serverPort: FALLBACK_PORT,
};

describe('shouldPreferApp', () => {
  it('prefers the app for the default instance on macOS', () => {
    expect(shouldPreferApp(base)).toBe(true);
    expect(shouldPreferApp({ ...base, serverPort: FALLBACK_PORT + APP_PORT_SCAN - 1 })).toBe(true);
  });

  it('keeps the browser off macOS', () => {
    expect(shouldPreferApp({ ...base, platform: 'linux' })).toBe(false);
    expect(shouldPreferApp({ ...base, platform: 'win32' })).toBe(false);
  });

  it('keeps the browser when a browser override is set', () => {
    expect(shouldPreferApp({ ...base, browserOverride: '/usr/bin/true' })).toBe(false);
  });

  it('keeps the browser for a server the app would not find', () => {
    expect(shouldPreferApp({ ...base, serverPort: null })).toBe(false);
    expect(shouldPreferApp({ ...base, serverPort: FALLBACK_PORT - 1 })).toBe(false);
    expect(shouldPreferApp({ ...base, serverPort: FALLBACK_PORT + APP_PORT_SCAN })).toBe(false);
    expect(shouldPreferApp({ ...base, serverPort: 7100 })).toBe(false);
  });

  it('keeps the browser for another home (MD_REDLINE_HOME)', () => {
    expect(shouldPreferApp({ ...base, resolvedHome: other })).toBe(false);
  });

  // Creating a symlink needs extra privileges on Windows.
  it.skipIf(process.platform === 'win32')(
    'treats a symlinked spelling of the home as the same home',
    () => {
      const link = join(other, 'home-link');
      symlinkSync(home, link);
      expect(shouldPreferApp({ ...base, resolvedHome: link })).toBe(true);
    },
  );
});
