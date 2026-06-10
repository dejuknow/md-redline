import { test, expect } from '@playwright/test';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Files must live inside the worktree so resolveAndValidate passes the
// allowed-roots check.
const TEMP_FIXTURE_DIR = resolve(__dirname, 'fixtures', 'fire-and-forget-tmp');

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

test.describe('Agent review fire-and-forget', () => {
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

  test('agent posts comments without waiting; they appear inline and a toast fires', async ({
    page,
    request,
    baseURL,
  }) => {
    fixtureDir = makeFixtureDir('happy');
    const file = resolve(fixtureDir, 'spec.md');
    writeFileSync(
      file,
      '# Spec\n\nHello world.\n\nThis is a doc.\n',
      'utf8',
    );

    // 1. Create an agent-origin session.
    const create = await request.post(`${baseURL}/api/review-sessions`, {
      data: { filePaths: [file], origin: 'agent' },
    });
    expect(create.status()).toBe(201);
    const { sessionId } = (await create.json()) as { sessionId: string };

    // 2. Navigate the browser to the session URL and wait for the app to
    //    render the file and establish the SSE file-watcher connection.
    await page.goto(`/?review=${encodeURIComponent(sessionId)}`);
    await expect(page.getByTestId('review-banner')).toBeVisible({ timeout: 12_000 });
    await expect(page.getByRole('heading', { name: 'Spec' })).toBeVisible({ timeout: 10_000 });
    // Allow the SSE file-watcher connection to fully establish before injecting
    // agent comments (same guard used in agent-asks.spec.ts).
    await page.waitForTimeout(500);

    // 3. Post two fire-and-forget comments (expectsReply: false).
    const post = await request.post(
      `${baseURL}/api/review-sessions/${sessionId}/agent-comments`,
      {
        data: {
          comments: [
            {
              filePath: file,
              anchor: 'Hello world',
              text: 'Consider a more specific greeting.',
            },
            {
              filePath: file,
              anchor: 'This is a doc',
              text: 'Add a summary sentence here.',
            },
          ],
        },
      },
    );
    expect(post.status()).toBe(201);
    const { commentIds } = (await post.json()) as { commentIds: string[] };
    expect(commentIds).toHaveLength(2);

    // 4. The SSE update rewrites the file with the injected comment markers;
    //    the sidebar should show both comment cards.
    await expect(page.locator('[data-comment-card-id]')).toHaveCount(2, { timeout: 10_000 });

    // 5. No awaiting-reply section — fire-and-forget does not create pendingAsks.
    await expect(page.getByTestId('awaiting-reply-section')).toHaveCount(0);

    // 6. Banner shows "End review" button (fire-and-forget mode).
    const banner = page.getByTestId('review-banner');
    await expect(banner.getByRole('button', { name: /end review/i })).toBeVisible({ timeout: 5_000 });
  });
});
