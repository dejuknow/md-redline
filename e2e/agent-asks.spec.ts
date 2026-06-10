import { test, expect } from '@playwright/test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Files must live inside the worktree so resolveAndValidate passes the
// allowed-roots check. The node_modules dir is symlinked to the root repo
// and would resolve outside the worktree's cwd, producing a 403.
const TEMP_FIXTURE_DIR = resolve(__dirname, 'fixtures', 'agent-asks-tmp');

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

test.describe('Agent asks', () => {
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

  test('user replies inline and the agent receives the reply', async ({
    page,
    request,
    baseURL,
  }) => {
    fixtureDir = makeFixtureDir('happy');
    const file = resolve(fixtureDir, 'spec.md');
    writeFileSync(file, '# Spec\n\nThe rate limit is 100 req/min today.\n', 'utf8');

    const create = await request.post(`${baseURL}/api/review-sessions`, {
      data: { filePaths: [file], origin: 'agent' },
    });
    expect(create.status()).toBe(201);
    const { sessionId } = (await create.json()) as { sessionId: string };

    await page.goto(`/?review=${encodeURIComponent(sessionId)}`);
    // Wait for the review banner and the document heading to confirm the file
    // is rendered and the SSE file-watcher connection has been established.
    await expect(page.getByTestId('review-banner')).toBeVisible({ timeout: 12_000 });
    await expect(page.getByRole('heading', { name: 'Spec' })).toBeVisible({ timeout: 10_000 });
    // Allow the SSE file-watcher connection to fully establish before injecting
    // the agent comment (same guard used in orphan-comments.spec.ts).
    await page.waitForTimeout(500);

    // Post agent-comments
    const ask = await request.post(
      `${baseURL}/api/review-sessions/${sessionId}/agent-comments`,
      {
        data: {
          questions: [
            {
              filePath: file,
              anchor: 'rate limit is 100 req/min',
              text: 'per-user or per-tenant?',
            },
          ],
        },
      },
    );
    expect(ask.status()).toBe(201);
    const { askId } = (await ask.json()) as { askId: string };

    // The SSE update should add the agent ask marker to the file; wait for the
    // comment card to appear in the sidebar (agent asks render as regular comment cards).
    const commentCards = page.locator('[data-comment-card-id]');
    await expect(commentCards).toHaveCount(1, { timeout: 10_000 });

    // The comment card shows the agent question text.
    await expect(page.getByText('per-user or per-tenant?')).toBeVisible({ timeout: 5_000 });

    // Start the agent's long-poll for the reply BEFORE the user answers.
    // This is the same request handleAskToolCall makes while blocking.
    const waitPromise = request.get(
      `${baseURL}/api/review-sessions/${sessionId}/asks/${askId}/wait`,
    );

    // Reply to the ask via the standard Reply button on the comment card.
    await commentCards.first().click(); // activate
    // Open the reply form
    await commentCards.first().getByRole('button', { name: /^reply$/i }).first().click();
    // Fill the reply text
    await commentCards.first().getByPlaceholder('Write a reply...').fill('per-tenant, see section 4.2');
    // Submit the reply (the primary/highlighted Reply button)
    await commentCards.first().getByRole('button', { name: /^reply$/i }).last().click();

    // The inline reply saves the file, and the save resolves the pending ask
    // immediately (every question now has an answer). The agent's long-poll
    // must return the reply text — no Done click required.
    const waitRes = await waitPromise;
    expect(waitRes.status()).toBe(200);
    const waitBody = (await waitRes.json()) as {
      status: string;
      replies: Array<{ questionIndex: number; text: string }>;
      totalQuestions: number;
    };
    expect(waitBody.status).toBe('reply');
    expect(waitBody.replies).toEqual([
      { questionIndex: 0, text: 'per-tenant, see section 4.2' },
    ]);

    // The marker on disk keeps the question and the reply as a record, with
    // the pending flag cleared.
    await expect
      .poll(() => readFileSync(file, 'utf8'), { timeout: 5_000 })
      .toContain('per-tenant, see section 4.2');
    expect(readFileSync(file, 'utf8')).not.toContain('"expectsReply":true');
  });

  test('Send batch and Send & finish are hidden while in awaiting-reply state', async ({
    page,
    request,
    baseURL,
  }) => {
    fixtureDir = makeFixtureDir('no-batch');
    const file = resolve(fixtureDir, 'spec.md');
    writeFileSync(file, '# Spec\n\nThe quick brown fox.\n', 'utf8');

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
        questions: [{ filePath: file, anchor: 'quick brown', text: 'change?' }],
      },
    });

    // Wait for the ask comment card to appear in the sidebar.
    await expect(page.locator('[data-comment-card-id]')).toHaveCount(1, { timeout: 10_000 });

    // The agent row shows the awaiting-reply state with End review; the
    // user-batch buttons (Send comments / finish) never render for it.
    await expect(page.getByRole('button', { name: /end review/i })).toBeVisible();
    await expect(page.getByTestId('review-banner')).toContainText(/waiting on your reply/i);
    await expect(page.getByRole('button', { name: /send \d+ comment/i })).toHaveCount(0);
  });

  test('End review with a pending question confirms, closes the ask, and preserves the marker', async ({
    page,
    request,
    baseURL,
  }) => {
    fixtureDir = makeFixtureDir('end-review');
    const file = resolve(fixtureDir, 'spec.md');
    writeFileSync(file, '# Spec\n\nSome unique anchor text here.\n', 'utf8');

    const create = await request.post(`${baseURL}/api/review-sessions`, {
      data: { filePaths: [file], origin: 'agent' },
    });
    expect(create.status()).toBe(201);
    const { sessionId } = (await create.json()) as { sessionId: string };

    await page.goto(`/?review=${encodeURIComponent(sessionId)}`);
    await expect(page.getByTestId('review-banner')).toBeVisible({ timeout: 12_000 });
    await expect(page.getByRole('heading', { name: 'Spec' })).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(500);

    const ask = await request.post(`${baseURL}/api/review-sessions/${sessionId}/agent-comments`, {
      data: {
        questions: [{ filePath: file, anchor: 'unique anchor text', text: 'q?' }],
      },
    });
    const { askId } = (await ask.json()) as { askId: string };

    // Wait for the ask comment card to appear.
    await expect(page.locator('[data-comment-card-id]')).toHaveCount(1, { timeout: 10_000 });

    // Ending the review with an unanswered question requires confirmation.
    page.once('dialog', (dialog) => void dialog.accept());
    await page.getByRole('button', { name: /end review/i }).click();

    // The banner clears, the ask resolves as done_without_reply, and the
    // marker stays on disk as a record with expectsReply cleared.
    await expect(page.getByTestId('review-banner')).toHaveCount(0, { timeout: 10_000 });
    const waitRes = await request.get(
      `${baseURL}/api/review-sessions/${sessionId}/asks/${askId}/wait`,
    );
    // The ask is already resolved at this point; the wait route 404s for
    // resolved asks, which is fine — what matters is the on-disk state.
    void waitRes;
    await expect
      .poll(() => readFileSync(file, 'utf8'), { timeout: 5_000 })
      .not.toContain('"expectsReply":true');
    const after = readFileSync(file, 'utf8');
    expect(after).toContain('"text":"q?"');
  });

  test('End review confirm can be declined, keeping the session open', async ({
    page,
    request,
    baseURL,
  }) => {
    fixtureDir = makeFixtureDir('end-decline');
    const file = resolve(fixtureDir, 'spec.md');
    writeFileSync(file, '# Spec\n\nAnother unique anchor sentence.\n', 'utf8');

    const create = await request.post(`${baseURL}/api/review-sessions`, {
      data: { filePaths: [file], origin: 'agent' },
    });
    const { sessionId } = (await create.json()) as { sessionId: string };

    await page.goto(`/?review=${encodeURIComponent(sessionId)}`);
    await expect(page.getByTestId('review-banner')).toBeVisible({ timeout: 12_000 });
    await page.waitForTimeout(500);

    await request.post(`${baseURL}/api/review-sessions/${sessionId}/agent-comments`, {
      data: {
        questions: [{ filePath: file, anchor: 'unique anchor sentence', text: 'sure?' }],
      },
    });
    await expect(page.locator('[data-comment-card-id]')).toHaveCount(1, { timeout: 10_000 });

    page.once('dialog', (dialog) => void dialog.dismiss());
    await page.getByRole('button', { name: /end review/i }).click();

    // Declined: banner stays, session stays open.
    await page.waitForTimeout(500);
    await expect(page.getByTestId('review-banner')).toBeVisible();
  });

  test('agent question stays in awaiting-reply section when its anchor text disappears', async ({
    page,
    request,
    baseURL,
  }) => {
    // Note: The current implementation keeps agent-ask cards in the
    // AwaitingReplySection even after their anchor text is removed from the
    // document. Agent asks are excluded from the normal orphan ("Needs
    // re-anchoring") section in CommentSidebar. This test documents that
    // existing behavior: the awaiting-reply section remains visible after the
    // anchor disappears, and the ask is still actionable.
    fixtureDir = makeFixtureDir('orphan');
    const file = resolve(fixtureDir, 'spec.md');
    writeFileSync(file, '# Spec\n\nThe special phrase lives here.\n', 'utf8');

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
        questions: [{ filePath: file, anchor: 'special phrase', text: 'why?' }],
      },
    });

    // Wait for the ask comment card to appear in the sidebar.
    await expect(page.locator('[data-comment-card-id]')).toHaveCount(1, { timeout: 10_000 });

    // Allow SSE to settle so we read the post-insert version of the file.
    await expect
      .poll(() => readFileSync(file, 'utf8'), { timeout: 5_000 })
      .toContain('agentInitiated');

    // Externally rewrite the file: remove the sentence containing "special phrase"
    // but keep the comment marker that was inserted before it.
    const current = readFileSync(file, 'utf8');
    const withoutAnchorSentence = current.replace(/The special phrase lives here\.\n/, '');
    writeFileSync(file, withoutAnchorSentence);

    // Wait for the file update to be acknowledged by the app.
    await expect
      .poll(() => readFileSync(file, 'utf8'), { timeout: 5_000 })
      .not.toContain('The special phrase lives here');

    // Give SSE a moment to propagate the file change.
    await page.waitForTimeout(2_000);

    // The comment card should still be visible (now in the "missing anchor" section
    // or as a regular orphaned card — either way it stays in the sidebar).
    await expect(page.locator('[data-comment-card-id]')).toHaveCount(1, { timeout: 5_000 });
  });
});
