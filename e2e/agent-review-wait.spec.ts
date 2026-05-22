import { test, expect } from '@playwright/test';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Files must live inside the worktree so resolveAndValidate passes the
// allowed-roots check.
const TEMP_FIXTURE_DIR = resolve(__dirname, 'fixtures', 'agent-review-wait-tmp');

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

test.describe('Agent review wait mode', () => {
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

  test('user replies and simulator receives them via long-poll', async ({
    page,
    request,
    baseURL,
  }) => {
    fixtureDir = makeFixtureDir('happy');
    const file = resolve(fixtureDir, 'spec.md');
    writeFileSync(
      file,
      '# Spec\n\nThe timeout is set to 30 seconds.\n\nThe retry count is 3 by default.\n',
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

    // 3. Post two comments with expectsReply: true (default) to get an askId.
    const post = await request.post(
      `${baseURL}/api/review-sessions/${sessionId}/agent-comments`,
      {
        data: {
          comments: [
            {
              filePath: file,
              anchor: 'timeout is set to 30 seconds',
              text: 'Should this be configurable?',
            },
            {
              filePath: file,
              anchor: 'retry count is 3',
              text: 'Is 3 the right default for production?',
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
    await expect(page.getByText(/Awaiting your reply \(0 of 2\)/)).toBeVisible();

    // The banner switches to the ask state — agent name + question count.
    await expect(page.getByText(/has 2 questions/i)).toBeVisible();

    // Send replies button starts disabled (no drafts yet).
    await expect(
      page.getByRole('button', { name: /Send replies \(0\/2\)/i }),
    ).toBeDisabled();

    // 6. Fill the reply textareas for each agent comment card.
    const textareas = page.getByTestId('agent-reply-textarea');
    await expect(textareas).toHaveCount(2, { timeout: 5_000 });
    await textareas.nth(0).fill('reply to question 1');
    await textareas.nth(1).fill('reply to question 2');

    // The count in the sidebar header updates optimistically.
    await expect(page.getByText(/Awaiting your reply \(2 of 2\)/)).toBeVisible();

    // The Send replies button is now enabled.
    const sendBtn = page.getByRole('button', { name: /Send replies \(2\/2\)/i });
    await expect(sendBtn).toBeEnabled();

    // 7. Click "Send 2 replies".
    await sendBtn.click();

    // 8. Await the long-poll result — the agent simulator receives the replies.
    const repliesRes = await repliesPromise;
    expect(repliesRes.status()).toBe(200);
    const body = (await repliesRes.json()) as {
      status: string;
      replies: Array<{ questionIndex: number; text: string }>;
    };
    expect(body.status).toBe('reply');
    expect(body.replies).toHaveLength(2);
    expect(body.replies[0].text).toMatch(/reply to question 1/);
    expect(body.replies[1].text).toMatch(/reply to question 2/);

    // 9. After sending, the awaiting-reply section disappears and banner reverts.
    await expect(page.getByTestId('awaiting-reply-section')).toHaveCount(0, { timeout: 10_000 });
    await expect(page.getByText(/has 2 questions/i)).toHaveCount(0, { timeout: 5_000 });
  });

  test('Send batch and Send & finish are hidden while in awaiting-reply state for agent sessions', async ({
    page,
    request,
    baseURL,
  }) => {
    fixtureDir = makeFixtureDir('no-batch');
    const file = resolve(fixtureDir, 'spec.md');
    writeFileSync(file, '# Spec\n\nThe cache TTL is 60 seconds.\n', 'utf8');

    const create = await request.post(`${baseURL}/api/review-sessions`, {
      data: { filePaths: [file], origin: 'agent' },
    });
    expect(create.status()).toBe(201);
    const { sessionId } = (await create.json()) as { sessionId: string };

    await page.goto(`/?review=${encodeURIComponent(sessionId)}`);
    await expect(page.getByTestId('review-banner')).toBeVisible({ timeout: 12_000 });
    await expect(page.getByRole('heading', { name: 'Spec' })).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(500);

    await request.post(`${baseURL}/api/review-sessions/${sessionId}/agent-comments`, {
      data: {
        comments: [{ filePath: file, anchor: 'cache TTL is 60', text: 'Is 60s the right TTL?' }],
        expectsReply: true,
      },
    });

    // Wait for the ask state to render in the banner.
    await expect(page.getByText(/has 1 question/i)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('awaiting-reply-section')).toBeVisible({ timeout: 10_000 });

    // In ask state the banner only shows Send replies + Cancel review.
    // "Send batch", "Send & finish", and "Finish review" must not appear.
    await expect(page.getByRole('button', { name: /^Send batch$/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Send & finish$/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Finish review$/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Cancel review/i })).toBeVisible();
  });
});
