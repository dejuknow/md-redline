import { test, expect } from '@playwright/test';
import { writeFileSync, unlinkSync, existsSync } from 'fs';
import { resolve, dirname, basename } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Use a fixture file inside the worktree so it's within the server's allowed
// roots (the cwd root). Files in /tmp are outside allowed roots and cannot be
// granted access via /api/grant-access.
const FIXTURE_PATH = resolve(__dirname, 'fixtures/review-session-fixture.md');
const FIXTURE_CONTENT = '# Review Session Fixture\n\nThis file is used by the review-session E2E tests.\n\n<!-- @comment{"id":"e2e-c1","anchor":"Fixture","text":"Test comment for E2E","author":"e2e-test","replies":[]} -->Fixture paragraph.\n';
const FIXTURE_BASENAME = basename(FIXTURE_PATH);

test.beforeAll(() => {
  writeFileSync(FIXTURE_PATH, FIXTURE_CONTENT);
});

test.afterAll(() => {
  if (existsSync(FIXTURE_PATH)) {
    unlinkSync(FIXTURE_PATH);
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Abort every open session so retries don't see stale sessions from a prior run. */
async function abortAllSessions(baseURL: string, request: import('@playwright/test').APIRequestContext) {
  const res = await request.get(`${baseURL}/api/review-sessions`);
  if (!res.ok()) return;
  const { sessions } = (await res.json()) as { sessions: { id: string; status: string }[] };
  for (const s of sessions.filter((s) => s.status === 'open')) {
    await request.post(`${baseURL}/api/review-sessions/${s.id}/abort`, {
      headers: { 'content-type': 'application/json' },
    });
  }
}

async function createSession(baseURL: string, request: import('@playwright/test').APIRequestContext): Promise<string> {
  const res = await request.post(`${baseURL}/api/review-sessions`, {
    data: { filePaths: [FIXTURE_PATH], enableResolve: false },
  });
  expect(res.status()).toBe(201);
  const body = await res.json() as { sessionId: string };
  return body.sessionId;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe('Review session banner', () => {
  // Clean up stale sessions from prior runs/retries so each test starts with a single session.
  test.beforeEach(async ({ request, baseURL }) => {
    await abortAllSessions(baseURL!, request);
  });

  test('happy path: banner appears and Send & finish hands off the session', async ({
    page,
    request,
    baseURL,
  }) => {
    const sessionId = await createSession(baseURL!, request);
    await page.goto(`/?review=${encodeURIComponent(sessionId)}`);

    const banner = page.getByTestId('review-banner');
    await expect(banner).toBeVisible({ timeout: 12_000 });
    await expect(banner).toContainText('Agent is waiting');
    await expect(banner).toContainText(FIXTURE_BASENAME);

    const waitPromise = request.get(`${baseURL}/api/review-sessions/${sessionId}/wait`);

    await banner.getByRole('button', { name: 'Send & finish' }).click();

    const waitRes = await waitPromise;
    expect(waitRes.status()).toBe(200);
    const waitBody = await waitRes.json() as { status: string; prompt?: string };
    expect(waitBody.status).toBe('done');
    expect(typeof waitBody.prompt).toBe('string');
    expect(waitBody.prompt).toContain(FIXTURE_PATH);
  });

  test('cancel path: Cancel review aborts the session', async ({
    page,
    request,
    baseURL,
  }) => {
    const sessionId = await createSession(baseURL!, request);

    await page.goto(`/?review=${encodeURIComponent(sessionId)}`);

    const banner = page.getByTestId('review-banner');
    await expect(banner).toBeVisible({ timeout: 12_000 });

    // Start the /wait long-poll BEFORE clicking Cancel to avoid race.
    const waitPromise = request.get(`${baseURL}/api/review-sessions/${sessionId}/wait`);

    // Click the "Cancel review" button
    await banner.getByRole('button', { name: 'Cancel review' }).click();

    // Await the /wait response
    const waitRes = await waitPromise;
    expect(waitRes.status()).toBe(200);
    const waitBody = await waitRes.json() as { status: string; reason?: string };
    expect(waitBody.status).toBe('aborted');
    expect(waitBody.reason).toBe('user_cancelled');
  });

  test('batched review: send batch keeps session open, send & finish closes it', async ({ page, request, baseURL }) => {
    const sessionId = await createSession(baseURL!, request);
    await page.goto(`/?review=${encodeURIComponent(sessionId)}`);

    const banner = page.getByTestId('review-banner');
    await expect(banner).toBeVisible({ timeout: 12_000 });

    // Wait for the file to load (Send batch should be enabled once files are ready)
    const batchButton = banner.getByRole('button', { name: /send batch/i });
    await expect(batchButton).toBeEnabled({ timeout: 10_000 });

    // Start /wait long-poll, then click Send batch
    const waitPromise = request.get(`${baseURL}/api/review-sessions/${sessionId}/wait`);
    await batchButton.click();

    const batchResponse = await waitPromise;
    expect(batchResponse.status()).toBe(200);
    const batchBody = await batchResponse.json() as { status: string };
    expect(batchBody.status).toBe('batch');

    // Banner should still be visible (session still open)
    await expect(banner).toBeVisible();

    // The batch button should now show "Waiting for agent..." (waitingForAgent is true)
    // We need the agent to "pick up" by calling waitForSession, which clears waitingForAgent.
    // In E2E, the /wait endpoint itself calls waitForSession. Start a new /wait.
    const waitPromise2 = request.get(`${baseURL}/api/review-sessions/${sessionId}/wait`);

    // After the batch sends the only comment, the optimistic sentCommentIds update
    // makes unsentIds empty, so the button text becomes "Finish review" (not "Send & finish").
    const finishButton = banner.getByRole('button', { name: /finish/i });
    await finishButton.click();

    const finishResponse = await waitPromise2;
    expect(finishResponse.status()).toBe(200);
    const finishBody = await finishResponse.json() as { status: string };
    expect(finishBody.status).toBe('done');
  });

  test('review session navigates the Explorer to the file\'s parent directory', async ({
    page,
    request,
    baseURL,
  }) => {
    const sessionId = await createSession(baseURL!, request);
    await page.goto(`/?review=${encodeURIComponent(sessionId)}`);

    // Wait for the review banner so we know the review flow has executed.
    await expect(page.getByTestId('review-banner')).toBeVisible({ timeout: 12_000 });

    // The Explorer is visible by default and should have navigated to the
    // fixture's parent directory, listing the fixture file as a sibling entry.
    // Scope to the Explorer's file-row styling to disambiguate from the tab
    // button, which also uses the file path as its title.
    await expect(
      page.locator(`button.w-full.text-left[title="${FIXTURE_PATH}"]`),
    ).toBeVisible({ timeout: 5_000 });
  });

  test('no banner without an active session', async ({ page }) => {
    // Navigate to the app with no review param and no active session.
    await page.goto('/');

    // The hook polls /api/review-sessions every 5s starting on mount, so if
    // a banner were going to appear it would do so within the first poll
    // cycle. Playwright's expect+toHaveCount polls continuously; a generous
    // timeout gives the banner a fair chance to appear if the test ever
    // regresses, and fails fast if it does.
    await expect(page.getByTestId('review-banner')).toHaveCount(0, { timeout: 8_000 });
  });
});
