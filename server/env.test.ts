import { afterEach, describe, expect, it, vi } from 'vitest';
import { homedir } from 'os';

import {
  FALLBACK_PORT,
  FALLBACK_VITE_PORT,
  resolveApiPort,
  resolveHomeDir,
  resolveVitePort,
} from './env';

describe('resolveApiPort', () => {
  // The prefixed name and the bare alias are both documented in the README's
  // config table, so this table is the contract for which one wins and for what
  // counts as "set".
  it.each([
    ['neither set', {}, FALLBACK_PORT],
    ['prefixed name only', { MD_REDLINE_PORT: '7100' }, 7100],
    ['bare alias only', { PORT: '7100' }, 7100],
    ['both set, prefixed wins', { MD_REDLINE_PORT: '7100', PORT: '7200' }, 7100],
    ['surrounding whitespace tolerated', { MD_REDLINE_PORT: ' 7100 ' }, 7100],
  ])('%s', (_label, env, expected) => {
    expect(resolveApiPort(env)).toBe(expected);
  });

  // The regression this function exists for. An empty prefixed name used to beat
  // a working alias and then parse to NaN, and because findAvailablePort loops
  // while `p < DEFAULT_PORT + MAX_PORT_ATTEMPTS`, NaN meant it tried no port at
  // all: startup died with "No available port found (tried NaN-NaN)" instead of
  // listening on the port the user had set.
  it.each(['', '   '])('an empty MD_REDLINE_PORT (%j) defers to PORT', (blank) => {
    expect(resolveApiPort({ MD_REDLINE_PORT: blank, PORT: '7100' })).toBe(7100);
  });

  it('an empty MD_REDLINE_PORT with no alias falls back rather than becoming NaN', () => {
    expect(resolveApiPort({ MD_REDLINE_PORT: '' })).toBe(FALLBACK_PORT);
  });

  // Warn and defer rather than throw: this runs during module evaluation, before
  // the startup chain that turns errors into a readable one-line message.
  it.each([
    ['not a number', 'nonsense'],
    ['trailing garbage, not silently truncated', '7100nonsense'],
    ['zero', '0'],
    ['negative', '-1'],
    ['above the port range', '65536'],
    ['fractional', '7100.5'],
  ])('rejects %s and warns', (_label, value) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(resolveApiPort({ MD_REDLINE_PORT: value })).toBe(FALLBACK_PORT);
      expect(warn).toHaveBeenCalledOnce();
      expect(warn.mock.calls[0][0]).toContain('MD_REDLINE_PORT');
    } finally {
      warn.mockRestore();
    }
  });

  it('defers from an invalid prefixed name to a valid alias', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(resolveApiPort({ MD_REDLINE_PORT: 'nonsense', PORT: '7100' })).toBe(7100);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('resolveVitePort', () => {
  it.each([
    ['unset', {}, FALLBACK_VITE_PORT],
    ['set', { MD_REDLINE_VITE_PORT: '5300' }, 5300],
    ['blank', { MD_REDLINE_VITE_PORT: '' }, FALLBACK_VITE_PORT],
    ['whitespace only', { MD_REDLINE_VITE_PORT: '   ' }, FALLBACK_VITE_PORT],
  ])('%s', (_label, env, expected) => {
    expect(resolveVitePort(env)).toBe(expected);
  });

  // Blank here used to reach Vite as `server.port: NaN`, which fails the dev
  // server outright with ERR_SOCKET_BAD_PORT rather than degrading to a default.
  it('rejects a malformed value and warns rather than yielding NaN', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(resolveVitePort({ MD_REDLINE_VITE_PORT: 'nonsense' })).toBe(FALLBACK_VITE_PORT);
      expect(warn.mock.calls[0][0]).toContain('MD_REDLINE_VITE_PORT');
    } finally {
      warn.mockRestore();
    }
  });

  // MD_REDLINE_PORT is the API server's variable. Reading it here would point the
  // dev client at the API port.
  it('ignores the API port variables', () => {
    expect(resolveVitePort({ MD_REDLINE_PORT: '7100', PORT: '7200' })).toBe(FALLBACK_VITE_PORT);
  });
});

describe('resolveHomeDir', () => {
  // Blank is the case that matters. A plain `?? homedir()` kept the empty string,
  // and an empty base directory sends `.md-redline.json` to the current working
  // directory, so trusted roots and the update cache are written wherever the
  // user launched from and quietly fail to persist.
  it.each([
    ['unset', {}],
    ['empty', { MD_REDLINE_HOME: '' }],
    ['whitespace only', { MD_REDLINE_HOME: '   ' }],
  ])('falls back to the OS home directory when %s', (_label, env) => {
    expect(resolveHomeDir(env)).toBe(homedir());
  });

  it('uses an explicit value', () => {
    expect(resolveHomeDir({ MD_REDLINE_HOME: '/tmp/mdr-home' })).toBe('/tmp/mdr-home');
  });

  it('trims surrounding whitespace', () => {
    expect(resolveHomeDir({ MD_REDLINE_HOME: '  /tmp/mdr-home  ' })).toBe('/tmp/mdr-home');
  });
});

// The claim this module exists for, asserted against the real Vite config instead
// of by calling one function twice. Importing vite.config.ts fresh under a stubbed
// environment is the only way to observe the value it computes at module scope, and
// the hazard is concrete: while each reader had its own inline copy, a documented
// PORT=7100 bound the server and aimed this proxy at 7100 while the CLI scanned
// from 6373. Re-inline that expression in vite.config.ts and this goes red.
describe('vite.config.ts aims its dev proxy at the port the server binds', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it.each([
    { MD_REDLINE_PORT: '', PORT: '7100' },
    { MD_REDLINE_PORT: '7100nonsense' },
    { MD_REDLINE_PORT: '5300' },
    {},
  ])('agrees for %j', async (env) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      vi.stubEnv('MD_REDLINE_PORT', env.MD_REDLINE_PORT ?? '');
      vi.stubEnv('PORT', env.PORT ?? '');
      vi.resetModules();
      const config = (await import('../vite.config')).default as {
        server: { proxy: Record<string, string> };
      };
      expect(config.server.proxy['/api']).toBe(`http://127.0.0.1:${resolveApiPort(env)}`);
    } finally {
      warn.mockRestore();
    }
  });
});
