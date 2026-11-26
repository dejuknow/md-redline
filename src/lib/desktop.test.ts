// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { desktopAppVersion } from './desktop';

afterEach(() => {
  delete window.__mdrDesktop;
  delete window.__mdrDesktopVersion;
});

describe('desktopAppVersion', () => {
  it('is null in a browser', () => {
    expect(desktopAppVersion()).toBeNull();
  });

  it('returns the version in the desktop app', () => {
    window.__mdrDesktop = true;
    window.__mdrDesktopVersion = '0.6.0';
    expect(desktopAppVersion()).toBe('0.6.0');
  });

  it('is null when the shell did not set a version', () => {
    window.__mdrDesktop = true;
    expect(desktopAppVersion()).toBeNull();
  });

  it('is null when a version is set without the desktop flag', () => {
    window.__mdrDesktopVersion = '0.6.0';
    expect(desktopAppVersion()).toBeNull();
  });
});
