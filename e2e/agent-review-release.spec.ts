import { test, expect } from '@playwright/test';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Files must live inside the worktree so resolveAndValidate passes the
// allowed-roots check.
const TEMP_FIXTURE_DIR = resolve(__dirname, 'fixtures', 'agent-review-release-tmp');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe('Agent review release', () => {
  let fixtureDir = '';

  test.beforeAll(() => {
    mkdirSync(TEMP_FIXTURE_DIR, { recursive: true });
  });

  test.afterAll(() => {
    rmSync(TEMP_FIXTURE_DIR, { recursive: true, force: true });
  });

  test.beforeEach(async ({ request, baseURL }) => {
    await abortAllSessions(baseURL!, request);
  });

  test.afterEach(async () => {
    if (fixtureDir) {
      rmSync(fixtureDir, { recursive: true, force: true });
      fixtureDir = '';
    }
  });

  test('user releases agent; simulator receives {status: no_reply, reason: released} and banner clears', async ({
    page,
    request,
    baseURL,
  }) => {
    fixtureDir = makeFixtureDir('happy');
    const file = resolve(fixtureDir, 'spec.md');
    writeFileSync(
      file,
      '# Spec\n\nThe batch size is 100 items.\n\nThe flush interval is 5 seconds.\n',
      'utf8',
    );

    // 1. Create an agent-origin session.
    const create = await request.post(`${baseURL}/api/review-sessions`, {
      data: { filePaths: [file], origin: 'agent' },
    });
    expect(create.status()).toBe(201);
    const { sessionId } = (await create.json()) as { sessionId: string };

    // 2. Navigate browser to the session URL and wait for the app to render.
    //    This must happen BEFORE posting comments so the SSE file-watcher
    //    connection is established when the file is rewritten with markers.
    await page.goto(`/?review=${encodeURIComponent(sessionId)}`);
    await expect(page.getByTestId('review-banner')).toBeVisible({ timeout: 12_000 });
    await expect(page.getByRole('heading', { name: 'Spec' })).toBeVisible({ timeout: 10_000 });
    // Allow the SSE file-watcher connection to fully establish before posting.
    await page.waitForTimeout(500);

    // 3. Post two comments with expectsReply: true to create a pending ask.
    const post = await request.post(
      `${baseURL}/api/review-sessions/${sessionId}/agent-comments`,
      {
        data: {
          comments: [
            {
              filePath: file,
              anchor: 'batch size is 100',
              text: 'Should this be configurable per environment?',
            },
            {
              filePath: file,
              anchor: 'flush interval is 5',
              text: 'Is 5 seconds the right default?',
            },
          ],
          expectsReply: true,
        },
      },
    );
    expect(post.status()).toBe(201);
    const { askId } = (await post.json()) as { askId: string };
    expect(askId).toMatch(/^ask_/);

    // 4. Start the long-poll for replies in background (simulates agent waiting).
    //    Playwright's request context is non-blocking; we await the promise later.
    const repliesPromise = request.get(
      `${baseURL}/api/review-sessions/${sessionId}/asks/${askId}/wait`,
    );

    // 5. The awaiting-reply section must appear in the sidebar after SSE delivers the markers.
    await expect(page.getByTestId('awaiting-reply-section')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/has 2 questions/i)).toBeVisible();

    // The Release agent button must be visible in the banner.
    const releaseBtn = page.getByRole('button', { name: /release agent/i });
    await expect(releaseBtn).toBeVisible();

    // 6. Click "Release agent" and wait for the release POST to complete.
    const [releaseRes] = await Promise.all([
      page.waitForResponse((r) => r.url().includes('/release') && r.request().method() === 'POST'),
      releaseBtn.click(),
    ]);
    expect(releaseRes.status()).toBe(200);

    // 7. The long-poll resolves with released status.
    const repliesRes = await repliesPromise;
    expect(repliesRes.status()).toBe(200);
    const body = (await repliesRes.json()) as { status: string; reason: string };
    expect(body.status).toBe('no_reply');
    expect(body.reason).toBe('released');

    // 8. The awaiting-reply section disappears and the banner reverts.
    await expect(page.getByTestId('awaiting-reply-section')).toHaveCount(0, { timeout: 10_000 });
    await expect(page.getByText(/has 2 questions/i)).toHaveCount(0, { timeout: 5_000 });
  });
});
