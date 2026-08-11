import { afterEach, describe, expect, it, vi } from 'vitest';

import { FALLBACK_PORT, isValidPort, resolveNamedApiPort } from './ports.js';

// resolveApiPort itself is covered in server/env.test.ts, where it is re-exported.
// What lives here is what the CLI needs and the server does not: whether a port
// was NAMED at all. The order to go looking in lives with the code that acts on
// a running server, in server-control.

// Restored here rather than at the end of each test body: a failing assertion
// would skip an inline mockRestore and leave console.warn stubbed for every
// test after it, so the next failure reports with its diagnostics swallowed.
afterEach(() => {
  vi.restoreAllMocks();
});

describe('isValidPort', () => {
  it.each([1, 80, 6373, 65535])('accepts %i', (port) => {
    expect(isValidPort(port)).toBe(true);
  });

  it.each([0, -1, 65536, 80.5, NaN])('rejects %j', (port) => {
    expect(isValidPort(port)).toBe(false);
  });
});

describe('resolveNamedApiPort', () => {
  it('returns the port when the prefixed name holds one', () => {
    expect(resolveNamedApiPort({ MD_REDLINE_PORT: '7441' })).toBe(7441);
  });

  it('accepts the documented PORT alias', () => {
    expect(resolveNamedApiPort({ PORT: '7100' })).toBe(7100);
  });

  it('prefers the prefixed name over the alias', () => {
    expect(resolveNamedApiPort({ MD_REDLINE_PORT: '7441', PORT: '7100' })).toBe(7441);
  });

  it('is null when nothing is set', () => {
    expect(resolveNamedApiPort({})).toBeNull();
  });

  it.each(['', '   '])('treats a blank value (%j) as naming nothing', (blank) => {
    expect(resolveNamedApiPort({ MD_REDLINE_PORT: blank })).toBeNull();
  });

  it('reports the default port as named when it was set on purpose', () => {
    // The distinction this function exists for. resolveApiPort answers 6373 to
    // both this and an empty environment, which is what made a command aimed at
    // a specific server indistinguishable from one that would take any server.
    expect(resolveNamedApiPort({ MD_REDLINE_PORT: String(FALLBACK_PORT) })).toBe(FALLBACK_PORT);
    expect(resolveNamedApiPort({})).toBeNull();
  });

  it.each(['nonsense', '0', '65536', '80.5', '-1'])(
    'does not treat an unusable value (%j) as a name',
    (value) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect(resolveNamedApiPort({ MD_REDLINE_PORT: value })).toBeNull();
      expect(warn).toHaveBeenCalled();
    },
  );

  it('falls through a typo to the alias behind it', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(resolveNamedApiPort({ MD_REDLINE_PORT: 'nonsense', PORT: '7100' })).toBe(7100);
  });
});
