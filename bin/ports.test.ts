import { describe, expect, it, vi } from 'vitest';

import { FALLBACK_PORT, resolveNamedApiPort, serverProbeOrder } from './ports.js';

// resolveApiPort itself is covered in server/env.test.ts, where it is re-exported.
// What lives here is the pair the CLI needs and the server does not: whether a
// port was NAMED, and the order to go looking in.

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
      warn.mockRestore();
    },
  );

  it('falls through a typo to the alias behind it', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(resolveNamedApiPort({ MD_REDLINE_PORT: 'nonsense', PORT: '7100' })).toBe(7100);
    warn.mockRestore();
  });
});

describe('serverProbeOrder', () => {
  const scan = { scanBases: [6373, 3001], scanCount: 3 };

  it('probes a named port before the recorded one', () => {
    // The bug: two servers up, the port file naming the one that started last.
    // `MD_REDLINE_PORT=7441 mdr --stop` reported success and stopped 7440.
    const order = serverProbeOrder({ namedPort: 7441, portFilePort: 7440, ...scan });

    expect(order[0]).toBe(7441);
    expect(order.indexOf(7441)).toBeLessThan(order.indexOf(7440));
  });

  it('still probes the recorded port when nothing was named', () => {
    // Not a fallback worth losing: it is the only way to find a server that
    // scanned upward past a busy default.
    const order = serverProbeOrder({ namedPort: null, portFilePort: 6380, ...scan });

    expect(order[0]).toBe(6380);
  });

  it('scans both ranges in order after the specific candidates', () => {
    const order = serverProbeOrder({ namedPort: null, portFilePort: null, ...scan });

    expect(order).toEqual([6373, 6374, 6375, 3001, 3002, 3003]);
  });

  it('probes a port once, however many ways it was reached', () => {
    // The named port is usually inside the scan range, since resolveApiPort
    // makes the range start there.
    const order = serverProbeOrder({ namedPort: 6373, portFilePort: 6374, ...scan });

    expect(order).toEqual([6373, 6374, 6375, 3001, 3002, 3003]);
    expect(new Set(order).size).toBe(order.length);
  });

  it('keeps the recorded port ahead of the scan even when the scan would reach it', () => {
    const order = serverProbeOrder({ namedPort: null, portFilePort: 6375, ...scan });

    expect(order).toEqual([6375, 6373, 6374, 3001, 3002, 3003]);
  });

  it('is just the scan when there is nothing else to go on', () => {
    expect(
      serverProbeOrder({ namedPort: null, portFilePort: null, scanBases: [6373], scanCount: 1 }),
    ).toEqual([6373]);
  });
});
