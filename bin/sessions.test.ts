import { describe, expect, it } from 'vitest';
import { formatAge, formatSessions } from './sessions.js';

const NOW = Date.parse('2026-09-23T12:00:00Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe('formatAge', () => {
  it.each([
    [0, '0s'],
    [59_999, '59s'],
    [60_000, '1m'],
    [59 * 60_000, '59m'],
    [(2 * 60 + 5) * 60_000, '2h 5m'],
    [26 * 60 * 60_000, '1d 2h'],
  ])('%i ms reads as %s', (ms, expected) => {
    expect(formatAge(ms)).toBe(expected);
  });

  it('clamps a clock-skewed future timestamp to 0s rather than going negative', () => {
    expect(formatAge(-5_000)).toBe('0s');
  });
});

describe('formatSessions', () => {
  it('says so when nothing is open', () => {
    expect(formatSessions([], { now: NOW, homeDir: '/home/u' })).toBe('No open review sessions.');
  });

  it('lists oldest first, with ages, a short caller, and home-relative paths', () => {
    const out = formatSessions(
      [
        {
          id: 'rev_new',
          origin: 'user',
          filePaths: ['/home/u/b.md'],
          createdAt: ago(30_000),
          lastHeartbeatAt: ago(4_000),
        },
        {
          id: 'rev_old',
          origin: 'agent',
          clientId: 'mcp_7f3e1a2b-0000-4000-8000-000000000000',
          filePaths: ['/home/u/specs/a.md', '/elsewhere/c.md'],
          createdAt: ago(2 * 3_600_000),
          lastHeartbeatAt: ago(31 * 60_000),
        },
      ],
      { now: NOW, homeDir: '/home/u' },
    );

    expect(out.split('\n')).toEqual([
      '2 open review sessions',
      '',
      'ID       ORIGIN  CALLER        OPENED     HEARTBEAT  FILES',
      'rev_old  agent   mcp_7f3e1a2b  2h 0m ago  31m ago    ~/specs/a.md, /elsewhere/c.md',
      'rev_new  user    -             30s ago    4s ago     ~/b.md',
    ]);
  });

  it('does not shorten a path that only shares a prefix with home', () => {
    const out = formatSessions(
      [
        {
          id: 'rev_1',
          origin: 'user',
          filePaths: ['/home/user2/a.md'],
          createdAt: ago(0),
          lastHeartbeatAt: ago(0),
        },
      ],
      { now: NOW, homeDir: '/home/user' },
    );
    expect(out).toContain('/home/user2/a.md');
    expect(out.split('\n')[0]).toBe('1 open review session');
  });
});
