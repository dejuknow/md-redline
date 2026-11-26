import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { TEST_DOC_BASELINE, TEST_DOC_2_BASELINE } from './helpers/fixture-baselines';
import { getCard } from './helpers/comments';
import { resetTestAppState } from './helpers/test-state';

// Agent notifications (#244). The desktop shell takes ripe notifications
// through window.__mdrTakeAgentNotifications about once a second and posts
// them; here the test plays the shell, with the desktop flags set and the
// window's focus faked, and drives the core side: detection, batching,
// dedupe, and the click's way back in through __mdrOpenTarget.

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(__dirname, 'fixtures/test-doc.md');
const FIXTURE_2 = resolve(__dirname, 'fixtures/test-doc-2.md');
const PREFS = resolve(__dirname, '..', '.playwright-home', '.md-redline.json');
const TEMP_DIR = resolve(__dirname, 'fixtures', 'agent-notifications-tmp');

interface Item {
  id: string;
  title: string;
  body: string;
  group: string;
  target: { file?: string; commentId?: string; review?: string };
}

function restoreFixtures() {
  writeFileSync(FIXTURE, TEST_DOC_BASELINE);
  writeFileSync(FIXTURE_2, TEST_DOC_2_BASELINE);
}

function setNotificationsPref(on: boolean) {
  writeFileSync(
    PREFS,
    JSON.stringify({ settings: { enableResolve: false, agentNotifications: on } }),
    'utf8',
  );
}

const comment = (replies?: unknown[]) =>
  `<!-- @comment${JSON.stringify({
    id: 'notify-c1',
    anchor: 'valid credentials',
    text: 'Should we say "active credentials"?',
    author: 'Dana',
    timestamp: '2025-01-01T00:00:00.000Z',
    ...(replies ? { replies } : {}),
  })} -->valid credentials`;

const withComment = (replies?: unknown[]) =>
  TEST_DOC_BASELINE.replace('valid credentials', comment(replies));

const agentReply = {
  id: 'notify-r1',
  text: 'Yes, "active" is more precise.',
  author: 'Claude',
  timestamp: '2025-01-01T00:00:00.000Z',
  agent: true,
};

/** The page as the macOS app shows it, with the window's focus under test control. */
async function asDesktopApp(page: Page) {
  await page.addInitScript(() => {
    window.__mdrDesktop = true;
    window.__mdrDesktopNotifications = true;
    const w = window as unknown as { __e2eFocused?: boolean };
    Document.prototype.hasFocus = () => w.__e2eFocused !== false;
  });
}

async function setFocused(page: Page, focused: boolean) {
  await page.evaluate((f) => {
    (window as unknown as { __e2eFocused?: boolean }).__e2eFocused = f;
  }, focused);
}

/** One take, as the shell makes it. */
function take(page: Page, focused: boolean) {
  return page.evaluate(
    (f) => window.__mdrTakeAgentNotifications?.({ focused: f, permission: 'granted' }) ?? null,
    focused,
  );
}

/** Takes once a second, as the shell does, until something comes out. */
async function takeUntilItems(page: Page, timeout = 10_000): Promise<Item[]> {
  let items: Item[] = [];
  await expect
    .poll(
      async () => {
        const result = await take(page, false);
        items = (result?.items ?? []) as Item[];
        return items.length;
      },
      { timeout, intervals: [1_000] },
    )
    .toBeGreaterThan(0);
  return items;
}

async function openFixture(page: Page) {
  await page.goto(`/?file=${FIXTURE}`);
  await expect(page.getByRole('heading', { name: 'Test Document' })).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByText('Should we say "active credentials"?')).toBeVisible();
  // Let the file watcher connect.
  await page.waitForTimeout(1_000);
}

test.beforeEach(async ({ page }) => {
  restoreFixtures();
  await resetTestAppState(page);
});

test.afterAll(() => {
  restoreFixtures();
  setNotificationsPref(false);
  rmSync(TEMP_DIR, { recursive: true, force: true });
});

test.describe('Agent notifications (desktop app)', () => {
  test('an agent reply while the window is in the background notifies once, at its thread', async ({
    page,
  }) => {
    writeFileSync(FIXTURE, withComment());
    setNotificationsPref(true);
    await asDesktopApp(page);
    await openFixture(page);
    expect(await take(page, false)).toEqual({ enabled: true, items: [] });

    await setFocused(page, false);
    writeFileSync(FIXTURE, withComment([agentReply]));
    await expect(page.getByTestId('reply-summary')).toBeVisible({ timeout: 15_000 });

    const items = await takeUntilItems(page);
    expect(items).toEqual([
      {
        id: 'r:notify-r1',
        title: 'Claude replied on test-doc.md',
        body: 'Yes, "active" is more precise.',
        group: FIXTURE,
        target: { file: FIXTURE, commentId: 'notify-c1' },
      },
    ]);
    // Handed over once.
    expect((await take(page, false))?.items).toEqual([]);

    // A reload replays the file; nothing notifies again.
    await page.reload();
    await expect(page.getByText('Should we say "active credentials"?')).toBeVisible({
      timeout: 10_000,
    });
    await setFocused(page, false);
    await page.waitForTimeout(4_000);
    expect((await take(page, false))?.items).toEqual([]);
  });

  test('the watchers stay connected while the window is hidden', async ({ page }) => {
    writeFileSync(FIXTURE, withComment());
    setNotificationsPref(true);
    await asDesktopApp(page);
    await openFixture(page);
    await setFocused(page, false);
    // What a hidden window reports. Without notifications on, the watchers
    // close here (a browser's connection limit), and a reply waits for the
    // window to show again.
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => 'hidden',
      });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForTimeout(500);
    writeFileSync(FIXTURE, withComment([agentReply]));
    const items = await takeUntilItems(page, 15_000);
    expect(items.map((i) => i.id)).toEqual(['r:notify-r1']);
  });

  test('an agent question notifies ahead of replies', async ({ page }) => {
    writeFileSync(FIXTURE, withComment());
    setNotificationsPref(true);
    await asDesktopApp(page);
    await openFixture(page);
    await setFocused(page, false);

    const question = `<!-- @comment${JSON.stringify({
      id: 'notify-q1',
      anchor: 'Rate limiting',
      text: 'Keep the limit at five attempts?',
      author: 'Claude',
      timestamp: '2025-01-01T00:00:00.000Z',
      agentInitiated: true,
      expectsReply: true,
      sessionId: 'rev_e2e',
    })} -->Rate limiting`;
    writeFileSync(FIXTURE, withComment([agentReply]).replace('Rate limiting', question));

    const items = await takeUntilItems(page, 15_000);
    expect(items.map((i) => i.title)).toEqual([
      'Claude has a question on test-doc.md',
      'Claude replied on test-doc.md',
    ]);
    expect(items[0].target).toEqual({ file: FIXTURE, commentId: 'notify-q1' });
  });

  test('nothing notifies for what arrives while the reader is looking', async ({ page }) => {
    writeFileSync(FIXTURE, withComment());
    setNotificationsPref(true);
    await asDesktopApp(page);
    await openFixture(page);

    writeFileSync(FIXTURE, withComment([agentReply]));
    await expect(page.getByTestId('reply-summary')).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(3_500);
    expect((await take(page, true))?.items).toEqual([]);
    // Seen on screen, so leaving the window afterwards does not notify it.
    await setFocused(page, false);
    expect((await take(page, false))?.items).toEqual([]);
  });

  test('off by default: nothing is detected or handed over', async ({ page }) => {
    writeFileSync(FIXTURE, withComment());
    await asDesktopApp(page);
    await openFixture(page);
    await setFocused(page, false);
    writeFileSync(FIXTURE, withComment([agentReply]));
    await expect(page.getByTestId('reply-summary')).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(3_500);
    expect(await take(page, false)).toEqual({ enabled: false, items: [] });
  });

  test('an agent finishing its review notifies, pointing at the review', async ({
    page,
    request,
    baseURL,
  }) => {
    mkdirSync(TEMP_DIR, { recursive: true });
    const file = resolve(TEMP_DIR, `spec-${Date.now()}.md`);
    writeFileSync(file, '# Spec\n\nThe timeout is 30 seconds.\n', 'utf8');
    setNotificationsPref(true);
    await asDesktopApp(page);

    const create = await request.post(`${baseURL}/api/review-sessions`, {
      data: { filePaths: [file], origin: 'agent' },
    });
    expect(create.status()).toBe(201);
    const { sessionId } = (await create.json()) as { sessionId: string };
    await page.goto(`/?review=${encodeURIComponent(sessionId)}`);
    await expect(page.getByTestId('review-banner')).toBeVisible({ timeout: 12_000 });
    await setFocused(page, false);

    const post = await request.post(`${baseURL}/api/review-sessions/${sessionId}/agent-comments`, {
      data: {
        comments: [
          {
            filePath: file,
            anchor: 'timeout is 30 seconds',
            text: 'Should this be configurable?',
            author: 'Claude',
          },
        ],
      },
    });
    expect(post.status()).toBe(201);
    // The agent starts waiting on the reader: its review is done.
    const wait = await request.get(
      `${baseURL}/api/review-sessions/${sessionId}/agent-wait?timeout=1`,
    );
    expect(((await wait.json()) as { status: string }).status).toBe('pending');

    const items = await takeUntilItems(page, 15_000);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      title: 'Claude finished reviewing',
      group: `review:${sessionId}`,
      target: { review: sessionId },
    });

    await request.post(`${baseURL}/api/review-sessions/${sessionId}/abort`, {
      headers: { 'content-type': 'application/json' },
    });
  });

  test('a review that finished before the page loaded does not notify', async ({
    page,
    request,
    baseURL,
  }) => {
    mkdirSync(TEMP_DIR, { recursive: true });
    const file = resolve(TEMP_DIR, `done-${Date.now()}.md`);
    writeFileSync(file, '# Spec\n\nThe timeout is 30 seconds.\n', 'utf8');
    setNotificationsPref(true);
    await asDesktopApp(page);
    const create = await request.post(`${baseURL}/api/review-sessions`, {
      data: { filePaths: [file], origin: 'agent' },
    });
    const { sessionId } = (await create.json()) as { sessionId: string };
    await request.post(`${baseURL}/api/review-sessions/${sessionId}/agent-comments`, {
      data: {
        comments: [{ filePath: file, anchor: 'timeout is 30 seconds', text: 'Configurable?' }],
      },
    });
    await request.get(`${baseURL}/api/review-sessions/${sessionId}/agent-wait?timeout=1`);

    // Loaded (or reloaded, or the app restarted) after the round ended.
    await page.goto(`/?review=${encodeURIComponent(sessionId)}`);
    await expect(page.getByTestId('review-banner')).toBeVisible({ timeout: 12_000 });
    await setFocused(page, false);
    await page.waitForTimeout(7_000);
    expect((await take(page, false))?.items).toEqual([]);

    await request.post(`${baseURL}/api/review-sessions/${sessionId}/abort`, {
      headers: { 'content-type': 'application/json' },
    });
  });

  test('a click opens that file at that thread', async ({ page }) => {
    writeFileSync(FIXTURE, withComment([agentReply]));
    await asDesktopApp(page);
    await page.goto(`/?file=${FIXTURE_2}`);
    await expect(page.getByRole('heading', { name: 'Second Test Document' })).toBeVisible({
      timeout: 10_000,
    });

    await page.evaluate(
      (file) => window.__mdrOpenTarget?.({ file, commentId: 'notify-c1' }),
      FIXTURE,
    );
    await expect(page.getByRole('heading', { name: 'Test Document', exact: true })).toBeVisible();
    await expect(getCard(page, 'Should we say "active credentials"?')).toHaveClass(/ring-1/);
    // Opening the thread reads the reply.
    await expect(page.getByText('Yes, "active" is more precise.')).toBeVisible();
  });
});
