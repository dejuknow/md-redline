import { test, expect } from '@playwright/test';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMP_FIXTURE_DIR = resolve(__dirname, 'fixtures', 'agent-review-wait-tmp');

function makeFixtureDir(testName: string): string {
  mkdirSync(TEMP_FIXTURE_DIR, { recursive: true });
  const dir = resolve(TEMP_FIXTURE_DIR, `${testName}-${process.pid}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function abortAllSessions(
  baseURL: string,
  request: import('@playwright/test').APIRequestContext,
) {
  const res = await request.get(`${baseURL}/api/review-sessions`);
  if (!res.ok()) return;
  const { sessions } = (await res.json()) as { sessions: { id: string; status: string }[] };
  for (const s of sessions.filter((s) => s.status === 'open')) {
    await request.post(`${baseURL}/api/review-sessions/${s.id}/abort`, {
      headers: { 'content-type': 'application/json' },
    });
  }
}

test.describe('Agent review mdr_wait flow', () => {
  let fixtureDir = '';

  test.beforeAll(() => { mkdirSync(TEMP_FIXTURE_DIR, { recursive: true }); });
  test.afterAll(() => { rmSync(TEMP_FIXTURE_DIR, { recursive: true, force: true }); });
  test.beforeEach(async ({ request, baseURL }) => { await abortAllSessions(baseURL!, request); });
  test.afterEach(async () => {
    if (fixtureDir) { rmSync(fixtureDir, { recursive: true, force: true }); fixtureDir = ''; }
  });

  test('agent posts comments → calls /agent-wait → user clicks Done → /agent-wait returns done', async ({
    page,
    request,
    baseURL,
  }) => {
    fixtureDir = makeFixtureDir('happy');
    const file = resolve(fixtureDir, 'spec.md');
    writeFileSync(file, '# Spec\n\nThe timeout is 30 seconds.\n', 'utf8');

    // 1. Create agent session
    const create = await request.post(`${baseURL}/api/review-sessions`, {
      data: { filePaths: [file], origin: 'agent' },
    });
    expect(create.status()).toBe(201);
    const { sessionId } = (await create.json()) as { sessionId: string };

    // 2. Navigate to the session
    await page.goto(`/?review=${encodeURIComponent(sessionId)}`);
    await expect(page.getByTestId('review-banner')).toBeVisible({ timeout: 12_000 });
    await page.waitForTimeout(500);

    // 3. Post a comment (fire-and-forget — no expectsReply)
    const post = await request.post(`${baseURL}/api/review-sessions/${sessionId}/agent-comments`, {
      data: {
        comments: [{ filePath: file, anchor: 'timeout is 30 seconds', text: 'Should this be configurable?' }],
      },
    });
    expect(post.status()).toBe(201);
    const postBody = (await post.json()) as { commentIds?: string[] };
    expect(postBody.commentIds).toHaveLength(1);
    // No askId — fire-and-forget
    expect((postBody as { askId?: string }).askId).toBeUndefined();

    // 4. Start /agent-wait long-poll
    const waitPromise = request.get(`${baseURL}/api/review-sessions/${sessionId}/agent-wait?timeout=30`);

    // 5. Banner shows "End review" button (no pending ask)
    const banner = page.getByTestId('review-banner');
    await expect(banner.getByRole('button', { name: /end review/i })).toBeVisible({ timeout: 10_000 });

    // 6. Click Done
    await banner.getByRole('button', { name: /end review/i }).click();

    // 7. /agent-wait should return { status: 'done' }
    const waitRes = await waitPromise;
    expect(waitRes.status()).toBe(200);
    const waitBody = (await waitRes.json()) as { status: string };
    expect(waitBody.status).toBe('done');
  });

  test('/agent-wait returns done immediately if user already clicked Done', async ({
    request,
    baseURL,
  }) => {
    fixtureDir = makeFixtureDir('already-done');
    const file = resolve(fixtureDir, 'spec.md');
    writeFileSync(file, '# Spec\n\nSome content.\n', 'utf8');

    const create = await request.post(`${baseURL}/api/review-sessions`, {
      data: { filePaths: [file], origin: 'agent' },
    });
    const { sessionId } = (await create.json()) as { sessionId: string };

    // POST /agent-done first
    const doneRes = await request.post(`${baseURL}/api/review-sessions/${sessionId}/agent-done`, {
      headers: { 'content-type': 'application/json' },
    });
    expect(doneRes.status()).toBe(200);

    // Then /agent-wait — should return immediately
    const waitRes = await request.get(`${baseURL}/api/review-sessions/${sessionId}/agent-wait?timeout=5`);
    expect(waitRes.status()).toBe(200);
    const body = (await waitRes.json()) as { status: string };
    expect(body.status).toBe('done');
  });

  test('/agent-wait returns pending when timeout elapses without Done', async ({
    request,
    baseURL,
  }) => {
    fixtureDir = makeFixtureDir('pending');
    const file = resolve(fixtureDir, 'spec.md');
    writeFileSync(file, '# Spec\n\nSome content.\n', 'utf8');

    const create = await request.post(`${baseURL}/api/review-sessions`, {
      data: { filePaths: [file], origin: 'agent' },
    });
    const { sessionId } = (await create.json()) as { sessionId: string };

    // Short 1s timeout — should return pending
    const waitRes = await request.get(`${baseURL}/api/review-sessions/${sessionId}/agent-wait?timeout=1`);
    expect(waitRes.status()).toBe(200);
    const body = (await waitRes.json()) as { status: string };
    expect(body.status).toBe('pending');
  });

  test('banner shows spinner when agent is actively posting, dot when idle', async ({
    page,
    request,
    baseURL,
  }) => {
    fixtureDir = makeFixtureDir('spinner');
    const file = resolve(fixtureDir, 'spec.md');
    writeFileSync(file, '# Spec\n\nSome text here.\n', 'utf8');

    const create = await request.post(`${baseURL}/api/review-sessions`, {
      data: { filePaths: [file], origin: 'agent' },
    });
    const { sessionId } = (await create.json()) as { sessionId: string };

    await page.goto(`/?review=${encodeURIComponent(sessionId)}`);
    await expect(page.getByTestId('review-banner')).toBeVisible({ timeout: 12_000 });

    // A just-started session shows the spinner: the agent opened it and is
    // about to post. The idle dot is reserved for "posted a while ago and
    // gone quiet" (>30s after the last activity).
    await expect(page.locator('[aria-label="Agent is active"]')).toBeVisible({ timeout: 5_000 });

    // Post a comment
    await request.post(`${baseURL}/api/review-sessions/${sessionId}/agent-comments`, {
      data: {
        comments: [{ filePath: file, anchor: 'Some text here', text: 'Consider clarifying.' }],
      },
    });

    // Still spinning (lastAgentActivityAt is within the 30s window)
    await expect(page.locator('[aria-label="Agent is active"]')).toBeVisible({ timeout: 10_000 });
  });
});
