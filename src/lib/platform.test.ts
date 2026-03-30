import { describe, it, expect, afterEach } from 'vitest';
import { isApplePlatform, getPrimaryModifierLabel } from './platform';

const originalPlatform = Object.getOwnPropertyDescriptor(navigator, 'platform');
const originalUserAgent = Object.getOwnPropertyDescriptor(navigator, 'userAgent');

function mockNavigator(platform?: string, userAgent?: string) {
  if (platform !== undefined) {
    Object.defineProperty(navigator, 'platform', { value: platform, configurable: true });
  }
  if (userAgent !== undefined) {
    Object.defineProperty(navigator, 'userAgent', { value: userAgent, configurable: true });
  }
}

afterEach(() => {
  if (originalPlatform) Object.defineProperty(navigator, 'platform', originalPlatform);
  if (originalUserAgent) Object.defineProperty(navigator, 'userAgent', originalUserAgent);
});

describe('isApplePlatform', () => {
  it('returns true for MacIntel platform', () => {
    mockNavigator('MacIntel', '');
    expect(isApplePlatform()).toBe(true);
  });

  it('returns true for iPhone userAgent', () => {
    mockNavigator('', 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X)');
    expect(isApplePlatform()).toBe(true);
  });

  it('returns true for iPad userAgent', () => {
    mockNavigator('', 'Mozilla/5.0 (iPad; CPU OS 16_0 like Mac OS X)');
    expect(isApplePlatform()).toBe(true);
  });

  it('returns false for Windows platform', () => {
    mockNavigator('Win32', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)');
    expect(isApplePlatform()).toBe(false);
  });

  it('returns false for Linux platform', () => {
    mockNavigator('Linux x86_64', 'Mozilla/5.0 (X11; Linux x86_64)');
    expect(isApplePlatform()).toBe(false);
  });
});

describe('getPrimaryModifierLabel', () => {
  it('returns "Cmd" on Apple platforms', () => {
    mockNavigator('MacIntel', '');
    expect(getPrimaryModifierLabel()).toBe('Cmd');
  });

  it('returns "Ctrl" on non-Apple platforms', () => {
    mockNavigator('Win32', 'Mozilla/5.0 (Windows NT 10.0)');
    expect(getPrimaryModifierLabel()).toBe('Ctrl');
  });
});
