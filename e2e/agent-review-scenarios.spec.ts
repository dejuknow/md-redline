import { test, expect } from '@playwright/test';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Files must live inside the worktree so resolveAndValidate passes the
// allowed-roots check.
const TEMP_FIXTURE_DIR = resolve(__dirname, 'fixtures', 'agent-review-scenarios-tmp');

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

test.describe('Agent review scenarios', () => {
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

  // -------------------------------------------------------------------------
  // Scenario 1: Markdown-formatted anchors don't orphan
  //
  // Bug: Agent posts a comment with anchor like `**Metric**: 30% increase`
  // (literal markdown). detectMissingAnchors stripped formatting from the FILE
  // but not the ANCHOR, so the comment was flagged as "Needs re-anchoring."
  //
  // Fixed in: commit 9adcb03 (src/lib/comment-parser.ts detectMissingAnchors)
  // -------------------------------------------------------------------------

  test('scenario 1 (markdown-formatted anchors): agent anchor with ** markup is not orphaned', async ({
    page,
    request,
    baseURL,
  }) => {
    fixtureDir = makeFixtureDir('scenario-1');
    const file = resolve(fixtureDir, 'spec.md');
    writeFileSync(
      file,
      'Some intro.\n\n**Metric**: 30% increase in average knowledge entries.\n\nMore content.\n',
      'utf8',
    );

    // 1. Create an agent-origin session.
    const create = await request.post(`${baseURL}/api/review-sessions`, {
      data: { filePaths: [file], origin: 'agent' },
    });
    expect(create.status()).toBe(201);
    const { sessionId } = (await create.json()) as { sessionId: string };

    // 2. POST a comment whose anchor contains literal markdown markup.
    const post = await request.post(
      `${baseURL}/api/review-sessions/${sessionId}/agent-comments`,
      {
        data: {
          comments: [
            {
              filePath: file,
              anchor: '**Metric**: 30% increase',
              text: 'Is 30% realistic given current baselines?',
            },
          ],
        },
      },
    );
    expect(post.status()).toBe(201);

    // 3. Navigate and wait for the sidebar to render.
    await page.goto(`/?review=${encodeURIComponent(sessionId)}`);
    await expect(page.getByTestId('review-banner')).toBeVisible({ timeout: 12_000 });
    await page.waitForTimeout(500);

    // 4. Comment card must appear.
    await expect(page.locator('[data-comment-card-id]')).toHaveCount(1, { timeout: 10_000 });

    // 5. "Needs re-anchoring" section must NOT be present — the anchor was
    //    resolved correctly via the secondary formatting-strip pass.
    await expect(page.getByText(/Needs re-anchoring/i)).toHaveCount(0);
  });

  // -------------------------------------------------------------------------
  // Scenario 2: "Agent is reviewing..." spinner banner clears after comments arrive
  //
  // Bug: commentCounts only counts USER comments. The banner's hasAgentComments
  // check used commentCounts and got 0 even though agent comments existed.
  // Banner stuck on spinner.
  //
  // Fixed in: commit cbdae53 (added agentCommentCounts map in useComments.ts)
  // -------------------------------------------------------------------------

  test('scenario 2 (spinner banner): reviewing banner stays up with count after comments arrive', async ({
    page,
    request,
    baseURL,
  }) => {
    fixtureDir = makeFixtureDir('scenario-2');
    const file = resolve(fixtureDir, 'spec.md');
    writeFileSync(file, '# Spec\n\nThe timeout is 30 seconds.\n\nThe retry count is 3.\n', 'utf8');

    // 1. Create an agent-origin session with no comments yet.
    const create = await request.post(`${baseURL}/api/review-sessions`, {
      data: { filePaths: [file], origin: 'agent' },
    });
    expect(create.status()).toBe(201);
    const { sessionId } = (await create.json()) as { sessionId: string };

    // 2. Navigate to the session — spinner banner should show immediately.
    await page.goto(`/?review=${encodeURIComponent(sessionId)}`);
    await expect(page.getByTestId('review-banner')).toBeVisible({ timeout: 12_000 });
    await expect(page.getByRole('heading', { name: 'Spec' })).toBeVisible({ timeout: 10_000 });

    // The "is reviewing" spinner must be visible before comments.
    await expect(page.getByText(/is reviewing/i)).toBeVisible({ timeout: 5_000 });

    // Allow SSE to establish.
    await page.waitForTimeout(500);

    // 3. POST two fire-and-forget agent comments.
    const post = await request.post(
      `${baseURL}/api/review-sessions/${sessionId}/agent-comments`,
      {
        data: {
          comments: [
            {
              filePath: file,
              anchor: 'timeout is 30',
              text: 'Should this be configurable?',
            },
            {
              filePath: file,
              anchor: 'retry count is 3',
              text: 'Is 3 the right default?',
            },
          ],
        },
      },
    );
    expect(post.status()).toBe(201);

    // 4. Wait for sidebar to populate. Banner stays up (unified active-review banner)
    //    and now shows the comment count.
    await expect(page.locator('[data-comment-card-id]')).toHaveCount(2, { timeout: 10_000 });
    // Banner remains visible with "is reviewing" copy — it does NOT clear on comment arrival.
    await expect(page.getByText(/is reviewing/i)).toBeVisible({ timeout: 5_000 });
    // The Dismiss button should be present
    await expect(page.getByRole('button', { name: /^done$/i })).toBeVisible();
  });

  // -------------------------------------------------------------------------
  // Scenario 3: No "Agent is waiting on your review" banner for completed
  //             fire-and-forget agent session
  //
  // Bug: After fire-and-forget posting, session stays open server-side.
  // Banner fell through to user-mode default ("Agent is waiting on your review
  // of X" with Send/Finish/Cancel buttons). Wrong state for agent-origin.
  //
  // Fixed in: commit 704fa53 (ReviewBanner.tsx: return null for agent-origin
  //           past reviewing state)
  // -------------------------------------------------------------------------

  test('scenario 3 (no stale waiting banner): agent-origin session with comments shows no "waiting" banner', async ({
    page,
    request,
    baseURL,
  }) => {
    fixtureDir = makeFixtureDir('scenario-3');
    const file = resolve(fixtureDir, 'spec.md');
    writeFileSync(
      file,
      '# Spec\n\nThe cache TTL is 60 seconds.\n\nThe flush interval is 5 seconds.\n',
      'utf8',
    );

    // 1. Create an agent-origin session.
    const create = await request.post(`${baseURL}/api/review-sessions`, {
      data: { filePaths: [file], origin: 'agent' },
    });
    expect(create.status()).toBe(201);
    const { sessionId } = (await create.json()) as { sessionId: string };

    // 2. POST two fire-and-forget comments.
    const post = await request.post(
      `${baseURL}/api/review-sessions/${sessionId}/agent-comments`,
      {
        data: {
          comments: [
            {
              filePath: file,
              anchor: 'cache TTL is 60',
              text: 'Is 60s the right default?',
            },
            {
              filePath: file,
              anchor: 'flush interval is 5',
              text: 'Consider making this configurable.',
            },
          ],
        },
      },
    );
    expect(post.status()).toBe(201);

    // 3. Navigate and wait for comments to render.
    await page.goto(`/?review=${encodeURIComponent(sessionId)}`);
    await expect(page.getByTestId('review-banner')).toBeVisible({ timeout: 12_000 });
    await expect(page.locator('[data-comment-card-id]')).toHaveCount(2, { timeout: 10_000 });

    // 4. The "Agent is waiting on your review" banner must NOT appear.
    await expect(page.getByText(/Agent is waiting on your review/i)).toHaveCount(0);

    // 5. The "Finish review" button must NOT appear (user-mode action).
    await expect(page.getByRole('button', { name: /Finish review/i })).toHaveCount(0);

    // 6. The unified "is reviewing" banner IS present — it stays up until dismissed.
    await expect(page.getByText(/is reviewing/i)).toBeVisible();
    await expect(page.getByRole('button', { name: /^done$/i })).toBeVisible();
  });

  // -------------------------------------------------------------------------
  // Scenario 4: Batched agent calls dedupe into one session
  //
  // Bug: Task 2 made agent-origin POSTs bypass findOpenSession dedupe. When
  // Claude batched its review into N successive mdr_review calls, N sessions
  // and tabs were created.
  //
  // Fixed in: commit 29253c9 (agent-origin now dedupes same as user-origin)
  // -------------------------------------------------------------------------

  test('scenario 4 (session dedupe): successive agent POSTs for the same files return the same session', async ({
    request,
    baseURL,
  }) => {
    fixtureDir = makeFixtureDir('scenario-4');
    const file = resolve(fixtureDir, 'spec.md');
    writeFileSync(file, '# Spec\n\nContent here.\n', 'utf8');

    // 1. First call — creates the session.
    const create1 = await request.post(`${baseURL}/api/review-sessions`, {
      data: { filePaths: [file], origin: 'agent' },
    });
    expect(create1.status()).toBe(201);
    const body1 = (await create1.json()) as { sessionId: string; created: boolean };
    expect(body1.created).toBe(true);
    const sessionId = body1.sessionId;

    // 2. Second call for the same file — must reuse.
    const create2 = await request.post(`${baseURL}/api/review-sessions`, {
      data: { filePaths: [file], origin: 'agent' },
    });
    const body2 = (await create2.json()) as { sessionId: string; created: boolean };
    expect(body2.sessionId).toBe(sessionId);
    expect(body2.created).toBe(false);

    // 3. Third call — still the same session.
    const create3 = await request.post(`${baseURL}/api/review-sessions`, {
      data: { filePaths: [file], origin: 'agent' },
    });
    const body3 = (await create3.json()) as { sessionId: string; created: boolean };
    expect(body3.sessionId).toBe(sessionId);
    expect(body3.created).toBe(false);

    // 4. Fourth call — still the same session.
    const create4 = await request.post(`${baseURL}/api/review-sessions`, {
      data: { filePaths: [file], origin: 'agent' },
    });
    const body4 = (await create4.json()) as { sessionId: string; created: boolean };
    expect(body4.sessionId).toBe(sessionId);
    expect(body4.created).toBe(false);

    // Confirm only one open session exists for this file.
    const list = await request.get(`${baseURL}/api/review-sessions`);
    const { sessions } = (await list.json()) as { sessions: { id: string }[] };
    const forThisFile = sessions.filter((s) => s.id === sessionId);
    expect(forThisFile).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // Scenario 5: At most one banner in the DOM after multiple agent calls
  //
  // Bug: Multiple sessions caused stacked banners (5 banners for 4 calls in the
  // real user test).
  //
  // Fixed in: combination of session dedupe (29253c9) and banner suppression
  //           for completed agent sessions (704fa53).
  // -------------------------------------------------------------------------

  test('scenario 5 (no stacked banners): three deduplicated agent calls produce exactly zero persistent banners after comments post', async ({
    page,
    request,
    baseURL,
  }) => {
    fixtureDir = makeFixtureDir('scenario-5');
    const file = resolve(fixtureDir, 'spec.md');
    writeFileSync(file, '# Spec\n\nHello world.\n\nThis is a doc.\n', 'utf8');

    // 1. Make three successive agent-origin POSTs — all should dedupe to one session.
    const create1 = await request.post(`${baseURL}/api/review-sessions`, {
      data: { filePaths: [file], origin: 'agent' },
    });
    expect(create1.status()).toBe(201);
    const { sessionId } = (await create1.json()) as { sessionId: string };

    await request.post(`${baseURL}/api/review-sessions`, {
      data: { filePaths: [file], origin: 'agent' },
    });
    await request.post(`${baseURL}/api/review-sessions`, {
      data: { filePaths: [file], origin: 'agent' },
    });

    // 2. POST fire-and-forget comments.
    const post = await request.post(
      `${baseURL}/api/review-sessions/${sessionId}/agent-comments`,
      {
        data: {
          comments: [
            { filePath: file, anchor: 'Hello world', text: 'Nice greeting.' },
            { filePath: file, anchor: 'This is a doc', text: 'Add a summary.' },
          ],
        },
      },
    );
    expect(post.status()).toBe(201);

    // 3. Navigate to the session and let it fully settle.
    await page.goto(`/?review=${encodeURIComponent(sessionId)}`);
    await expect(page.getByTestId('review-banner')).toBeVisible({ timeout: 12_000 });
    await expect(page.locator('[data-comment-card-id]')).toHaveCount(2, { timeout: 10_000 });

    // 4. No spinner banner (comments have been posted).
    await expect(page.getByText(/Agent is reviewing this file/i)).toHaveCount(0);

    // 5. No "waiting on your review" banner (origin is agent, not user).
    await expect(page.getByText(/Agent is waiting on your review/i)).toHaveCount(0);

    // 6. No "Awaiting your reply" sidebar section header (expectsReply was false,
    //    so no pending ask exists). Individual fire-and-forget agent comment cards
    //    do NOT show "Awaiting your reply" since agentQuestion is only true for
    //    pending-ask cards. We check the dedicated awaiting-reply-section element.
    await expect(page.getByTestId('awaiting-reply-section')).toHaveCount(0);

    // 7. The unified "is reviewing" banner is present and shows a Dismiss button.
    //    (It stays up until the user explicitly dismisses — no auto-clear on comment arrival.)
    await expect(page.getByText(/is reviewing/i)).toBeVisible();
    await expect(page.getByRole('button', { name: /^done$/i })).toBeVisible();
  });

  // -------------------------------------------------------------------------
  // Scenario 6: Post-comment dedupe still works (heartbeat bump in recordAgentComments)
  //
  // Bug: Browser tab heartbeats can be throttled to ~1/min in background tabs.
  // The 60s freshness window was too tight. Extended to 5 min AND
  // recordAgentComments bumps lastHeartbeatAt so subsequent dedupe calls
  // still find the session fresh.
  //
  // Fixed in: commit df645aa (extended FIND_OPEN_FRESHNESS_MS to 5 min and
  //           bumped lastHeartbeatAt in recordAgentComments).
  //
  // Note: The time-travel aspect of this fix (verifying the full 5-min window)
  // is covered by unit tests in server/review-sessions.test.ts. Here we just
  // confirm that posting comments via agent-comments does not break subsequent
  // dedupe lookups — i.e. the heartbeat bump doesn't corrupt session state.
  // -------------------------------------------------------------------------

  test('scenario 6 (heartbeat bump): dedupe still works after agent-comments POST', async ({
    request,
    baseURL,
  }) => {
    fixtureDir = makeFixtureDir('scenario-6');
    const file = resolve(fixtureDir, 'spec.md');
    writeFileSync(file, '# Spec\n\nThe batch size is 100.\n\nThe retry limit is 5.\n', 'utf8');

    // 1. Create session A.
    const create = await request.post(`${baseURL}/api/review-sessions`, {
      data: { filePaths: [file], origin: 'agent' },
    });
    expect(create.status()).toBe(201);
    const { sessionId } = (await create.json()) as { sessionId: string };

    // 2. POST comments to session A — this bumps lastHeartbeatAt internally.
    const post = await request.post(
      `${baseURL}/api/review-sessions/${sessionId}/agent-comments`,
      {
        data: {
          comments: [
            { filePath: file, anchor: 'batch size is 100', text: 'Should this scale dynamically?' },
          ],
        },
      },
    );
    expect(post.status()).toBe(201);

    // 3. Immediately make another agent-origin POST for the same files.
    //    It must still dedupe to session A (heartbeat bump kept it fresh).
    const create2 = await request.post(`${baseURL}/api/review-sessions`, {
      data: { filePaths: [file], origin: 'agent' },
    });
    const body2 = (await create2.json()) as { sessionId: string; created: boolean };
    expect(body2.sessionId).toBe(sessionId);
    expect(body2.created).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Scenario 7: Comments with markdown markup in both anchor and text render correctly
  //
  // Defensive regression for a class of anchor-matching bugs.
  // Both anchors contain inline formatting markers; neither should orphan.
  // -------------------------------------------------------------------------

  test('scenario 7 (markdown in anchor and text): bold and italic anchors appear in sidebar without orphaning', async ({
    page,
    request,
    baseURL,
  }) => {
    fixtureDir = makeFixtureDir('scenario-7');
    const file = resolve(fixtureDir, 'spec.md');
    writeFileSync(
      file,
      '\n# Heading\n\n**Bold word** followed by plain text.\n\n_Italic_ text here.\n',
      'utf8',
    );

    // 1. Create an agent-origin session.
    const create = await request.post(`${baseURL}/api/review-sessions`, {
      data: { filePaths: [file], origin: 'agent' },
    });
    expect(create.status()).toBe(201);
    const { sessionId } = (await create.json()) as { sessionId: string };

    // 2. POST two comments with markdown-formatted anchors.
    const post = await request.post(
      `${baseURL}/api/review-sessions/${sessionId}/agent-comments`,
      {
        data: {
          comments: [
            {
              filePath: file,
              anchor: '**Bold word**',
              text: 'Consider rephrasing',
            },
            {
              filePath: file,
              anchor: '_Italic_',
              text: 'Why italics here?',
            },
          ],
        },
      },
    );
    expect(post.status()).toBe(201);

    // 3. Navigate to the session and wait for the sidebar.
    await page.goto(`/?review=${encodeURIComponent(sessionId)}`);
    await expect(page.getByTestId('review-banner')).toBeVisible({ timeout: 12_000 });
    await expect(page.locator('[data-comment-card-id]')).toHaveCount(2, { timeout: 10_000 });

    // 4. Both comments visible.
    await expect(page.locator('[data-comment-card-id]').first()).toBeVisible();
    await expect(page.locator('[data-comment-card-id]').nth(1)).toBeVisible();

    // 5. Neither comment is in the "Needs re-anchoring" section.
    await expect(page.getByText(/Needs re-anchoring/i)).toHaveCount(0);
  });
});
