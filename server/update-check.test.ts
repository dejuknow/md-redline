import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'http';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { createUpdateChecker, isUpdateCheckDisabled, type UpdateChecker } from './update-check';
import { readPreferences } from './preferences';

let homeDir: string;
let stub: Server | null = null;
let requestCount = 0;
let checker: UpdateChecker | null = null;

const DAY_MS = 24 * 60 * 60 * 1000;

function startRegistryStub(body: string, status = 200, delayMs = 0): Promise<string> {
  return new Promise((resolveUrl) => {
    stub = createServer((_req, res) => {
      requestCount++;
      setTimeout(() => {
        res.statusCode = status;
        res.setHeader('content-type', 'application/json');
        res.end(body);
      }, delayMs);
    });
    stub.listen(0, '127.0.0.1', () => {
      const { port } = stub!.address() as { port: number };
      resolveUrl(`http://127.0.0.1:${port}`);
    });
  });
}

async function seedCache(latestKnown: string, checkedAt: string) {
  await writeFile(
    join(homeDir, '.md-redline.json'),
    JSON.stringify({ updateCheck: { latestKnown, checkedAt } }),
  );
}

beforeEach(async () => {
  homeDir = await mkdtemp(join(tmpdir(), 'md-redline-update-'));
  requestCount = 0;
});

afterEach(async () => {
  checker?.stop();
  checker = null;
  if (stub) {
    await new Promise((res) => stub!.close(res));
    stub = null;
  }
  await rm(homeDir, { recursive: true, force: true });
});

function makeChecker(registryUrl: string, now?: () => number): UpdateChecker {
  checker = createUpdateChecker({
    currentVersion: '0.6.0',
    packageName: 'md-redline',
    homeDir,
    registryUrl,
    now,
  });
  return checker;
}

describe('createUpdateChecker', () => {
  it('fetches dist-tags, exposes a newer latest, and persists the cache', async () => {
    const url = await startRegistryStub(JSON.stringify({ latest: '9.9.9' }));
    const c = makeChecker(url, () => Date.parse('2026-07-17T12:00:00.000Z'));
    await c.start();
    expect(c.getLatest()).toBe('9.9.9');
    expect(requestCount).toBe(1);
    expect((await readPreferences(homeDir)).updateCheck).toEqual({
      latestKnown: '9.9.9',
      checkedAt: '2026-07-17T12:00:00.000Z',
    });
  });

  it('returns null when the registry latest is not newer', async () => {
    const url = await startRegistryStub(JSON.stringify({ latest: '0.6.0' }));
    const c = makeChecker(url);
    await c.start();
    expect(c.getLatest()).toBeNull();
  });

  it('skips the fetch when the cache is fresh', async () => {
    const now = Date.parse('2026-07-17T12:00:00.000Z');
    await seedCache('9.9.9', new Date(now - DAY_MS / 2).toISOString());
    const url = await startRegistryStub(JSON.stringify({ latest: '8.8.8' }));
    const c = makeChecker(url, () => now);
    await c.start();
    expect(requestCount).toBe(0);
    expect(c.getLatest()).toBe('9.9.9'); // served from cache
  });

  it('treats a future checkedAt as stale and refetches', async () => {
    const now = Date.parse('2026-07-17T12:00:00.000Z');
    await seedCache('9.9.9', new Date(now + DAY_MS).toISOString());
    const url = await startRegistryStub(JSON.stringify({ latest: '8.8.8' }));
    const c = makeChecker(url, () => now);
    await c.start();
    expect(requestCount).toBe(1);
    expect(c.getLatest()).toBe('8.8.8');
  });

  it('stays silent on fetch failure and keeps the stale cache', async () => {
    const now = Date.parse('2026-07-17T12:00:00.000Z');
    await seedCache('9.9.9', new Date(now - 2 * DAY_MS).toISOString());
    // Port 1 is never listening; fetch rejects fast.
    const c = makeChecker('http://127.0.0.1:1', () => now);
    await expect(c.start()).resolves.toBeUndefined();
    expect(c.getLatest()).toBe('9.9.9');
  });

  it('ignores non-JSON and non-2xx responses', async () => {
    const url = await startRegistryStub('not json', 500);
    const c = makeChecker(url);
    await expect(c.start()).resolves.toBeUndefined();
    expect(c.getLatest()).toBeNull();
  });

  it('ignores overlapping start calls: one fetch, one armed interval', async () => {
    const url = await startRegistryStub(JSON.stringify({ latest: '9.9.9' }));
    const c = makeChecker(url);
    await Promise.all([c.start(), c.start()]);
    expect(requestCount).toBe(1);
    expect(c.getLatest()).toBe('9.9.9');
  });

  it('stop during an in-flight start prevents the interval from arming', async () => {
    const url = await startRegistryStub(JSON.stringify({ latest: '9.9.9' }), 200, 25);
    checker = createUpdateChecker({
      currentVersion: '0.6.0',
      packageName: 'md-redline',
      homeDir,
      registryUrl: url,
      intervalMs: 30,
    });
    const inFlight = checker.start();
    checker.stop();
    await inFlight;
    await new Promise((r) => setTimeout(r, 100));
    expect(requestCount).toBe(1);
  });

  it('ignores a 200 response with a malformed JSON body', async () => {
    const url = await startRegistryStub('not json', 200);
    const c = makeChecker(url);
    await expect(c.start()).resolves.toBeUndefined();
    expect(c.getLatest()).toBeNull();
  });
});

describe('isUpdateCheckDisabled', () => {
  it('is a presence check on NO_UPDATE_NOTIFIER and CI', () => {
    expect(isUpdateCheckDisabled({})).toBe(false);
    expect(isUpdateCheckDisabled({ NO_UPDATE_NOTIFIER: '' })).toBe(true);
    expect(isUpdateCheckDisabled({ NO_UPDATE_NOTIFIER: '1' })).toBe(true);
    expect(isUpdateCheckDisabled({ CI: '' })).toBe(true);
    expect(isUpdateCheckDisabled({ CI: 'true' })).toBe(true);
  });
});
