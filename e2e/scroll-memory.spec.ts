import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { appendFileSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { withMod } from './helpers/shortcuts';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Inside the worktree, so the server's allowed-roots check passes (see
// agent-asks.spec.ts).
const TEMP_FIXTURE_DIR = resolve(__dirname, 'fixtures', 'scroll-memory-tmp');

test.use({ viewport: { width: 1700, height: 950 } });

/** A document of `count` sections, each a heading (`{label} {n}`) and one paragraph. */
function sections(count: number, label = 'Section', title = 'Long document'): string {
  let md = `# ${title}\n\n`;
  for (let i = 1; i <= count; i++) {
    md += `## ${label} ${i}\n\nParagraph ${i}, long enough to wrap onto a second line at this width so that every section takes up some real height in the document view.\n\n`;
  }
  return md;
}

const MERMAID_FENCE = '```mermaid\ngraph TD\n  A[Start] --> B[Finish]\n```\n';

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

const tabFor = (page: Page, path: string) => page.locator(`[title="${path}"].rounded-t-md`);

/** The scroll container the documents share. */
function scrollerTop(page: Page): Promise<number> {
  return page.evaluate(() => document.querySelector('[data-doc-page]')!.parentElement!.scrollTop);
}

function scrollerMax(page: Page): Promise<number> {
  return page.evaluate(() => {
    const el = document.querySelector('[data-doc-page]')!.parentElement!;
    return el.scrollHeight - el.clientHeight;
  });
}

/** Scroll as a reader would land there, without the viewer's smooth scrolling. */
async function scrollTo(page: Page, top: number) {
  await page.evaluate((top) => {
    document
      .querySelector('[data-doc-page]')!
      .parentElement!.scrollTo({ top, behavior: 'instant' });
  }, top);
  // Let the scroll event and anything it schedules run.
  await page.waitForTimeout(100);
}

async function scrollToHeading(page: Page, name: string) {
  const top = await page.evaluate((name) => {
    const el = document.querySelector('[data-doc-page]')!.parentElement!;
    const heading = Array.from(el.querySelectorAll('h2')).find((h) => h.textContent === name)!;
    return el.scrollTop + heading.getBoundingClientRect().top - el.getBoundingClientRect().top;
  }, name);
  await scrollTo(page, top);
}

function savedPositions(page: Page): Promise<Record<string, { top: number }>> {
  return page.evaluate(() =>
    JSON.parse(sessionStorage.getItem('md-redline-scroll-positions') ?? '{}'),
  );
}

/** How far heading `name` sits below the top of the scroller's viewport. */
function headingOffset(page: Page, name: string): Promise<number> {
  return page.evaluate((name) => {
    const el = document.querySelector('[data-doc-page]')!.parentElement!;
    const heading = Array.from(el.querySelectorAll('h2')).find((h) => h.textContent === name);
    if (!heading) return Number.NaN;
    return heading.getBoundingClientRect().top - el.getBoundingClientRect().top;
  }, name);
}

/** The reader is on heading `name`, where scrollToHeading put it. */
async function expectReadingAt(page: Page, name: string) {
  await expect
    .poll(async () => Math.abs(await headingOffset(page, name)), { timeout: 3_000 })
    .toBeLessThanOrEqual(2);
}

/** The raw view's own scroller: where it is, or where to put it. */
function rawScrollTop(page: Page, top?: number): Promise<number> {
  return page.evaluate((top) => {
    const el = document.querySelector('.raw-view-table')!.closest<HTMLElement>('.overflow-y-auto')!;
    if (top !== undefined) el.scrollTo({ top, behavior: 'instant' });
    return el.scrollTop;
  }, top);
}

async function toggleRaw(page: Page) {
  await page.locator('button[title="View raw markdown"]').click();
  await expect(page.locator('.raw-view-table')).toBeVisible();
}

async function toggleRendered(page: Page) {
  await page.locator('button[title="Switch to rendered view"]').click();
  await expect(page.locator('[data-doc-page] .prose')).toBeVisible();
}

/**
 * Write `files` into a fresh fixture folder and open them as a review, the
 * first one active. `beforeOpen` runs once the files exist and before the page
 * loads. Returns their paths, in order.
 */
async function openReview(
  page: Page,
  request: import('@playwright/test').APIRequestContext,
  baseURL: string,
  testInfo: TestInfo,
  files: Record<string, string>,
  beforeOpen?: (paths: string[]) => Promise<void>,
): Promise<{ dir: string; paths: string[] }> {
  await abortAllSessions(baseURL, request);
  const dir = resolve(TEMP_FIXTURE_DIR, `${process.pid}-${testInfo.retry}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const paths = Object.entries(files).map(([name, content]) => {
    const path = resolve(dir, name);
    writeFileSync(path, content);
    return path;
  });
  await beforeOpen?.(paths);
  const res = await request.post(`${baseURL}/api/review-sessions`, {
    data: { filePaths: paths, origin: 'agent' },
  });
  expect(res.status()).toBe(201);
  const { sessionId } = (await res.json()) as { sessionId: string };
  await page.goto(`/?review=${encodeURIComponent(sessionId)}`);
  return { dir, paths };
}

/**
 * An agent's before copy of `path` (mdr_baseline), then its edit to Paragraph
 * 5: the document opens with a diff to show, whose one change is near the top.
 */
async function agentEditsNearTheTop(
  request: import('@playwright/test').APIRequestContext,
  baseURL: string,
  path: string,
) {
  const captured = await request.post(`${baseURL}/api/baselines`, {
    headers: { 'content-type': 'application/json' },
    data: { filePaths: [path], agentName: 'Claude' },
  });
  expect(captured.status()).toBe(201);
  writeFileSync(
    path,
    sections(80).replace('Paragraph 5, long enough', 'Paragraph 5, revised, long enough'),
  );
}

const diffToggle = (page: Page, state: 'Show' | 'Hide') =>
  page.locator(`.raw-toolbar button[title^="${state} diff"]`);

test.describe('Reading position across tabs', () => {
  let fixtureDir = '';
  let longPath = '';
  let shortPath = '';

  test.beforeEach(async ({ page, request, baseURL }, testInfo) => {
    await abortAllSessions(baseURL!, request);
    fixtureDir = resolve(TEMP_FIXTURE_DIR, `${process.pid}-${testInfo.retry}-${Date.now()}`);
    mkdirSync(fixtureDir, { recursive: true });
    longPath = resolve(fixtureDir, 'long.md');
    shortPath = resolve(fixtureDir, 'short.md');
    writeFileSync(longPath, sections(80));
    writeFileSync(shortPath, '# Short document\n\nOne paragraph.\n');

    const res = await request.post(`${baseURL}/api/review-sessions`, {
      data: { filePaths: [longPath, shortPath], origin: 'agent' },
    });
    expect(res.status()).toBe(201);
    const { sessionId } = (await res.json()) as { sessionId: string };
    testInfo.annotations.push({ type: 'session', description: sessionId });
    await page.goto(`/?review=${encodeURIComponent(sessionId)}`);
    await expect(page.getByRole('heading', { name: 'Section 80' })).toBeAttached({
      timeout: 12_000,
    });
    // The SSE file-watcher connection, which delivers the edits below.
    await page.waitForTimeout(500);
  });

  test.afterEach(() => {
    if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
  });

  test.afterAll(() => {
    rmSync(TEMP_FIXTURE_DIR, { recursive: true, force: true });
  });

  /**
   * Leave the long document at Section 61, cut it to 20 sections while it is
   * in the background, and come back. Its saved block is gone and its saved
   * offset is past the end, so the restore cannot land.
   */
  async function returnToCutDocument(page: Page) {
    await scrollToHeading(page, 'Section 61');
    await tabFor(page, shortPath).click();
    await expect(page.getByRole('heading', { name: 'Short document' })).toBeVisible();

    // The background tabs' watcher reconnects on every switch, and an edit made
    // before it is up never reaches the tab. Nothing on screen shows a
    // background tab's content arriving, so wait it out.
    await page.waitForTimeout(500);
    writeFileSync(longPath, sections(20));
    await page.waitForTimeout(1000);
    await tabFor(page, longPath).click();
    await expect(page.getByRole('heading', { name: 'Section 20' })).toBeAttached();
    await expect(page.getByRole('heading', { name: 'Section 21' })).toHaveCount(0);
    await page.waitForTimeout(200);
    expect(await scrollerTop(page)).toBe(await scrollerMax(page));
  }

  test('a restore that cannot land does not pull the reader back on the next edit', async ({
    page,
  }) => {
    await returnToCutDocument(page);

    await scrollTo(page, 800);
    appendFileSync(longPath, 'An appended line.\n');
    await expect(page.getByText('An appended line.')).toBeAttached();
    await page.waitForTimeout(200);

    expect(await scrollerTop(page)).toBe(800);
  });

  test('leaving a document whose restore could not land saves where the reader is', async ({
    page,
  }) => {
    await returnToCutDocument(page);

    await scrollTo(page, 800);
    await tabFor(page, shortPath).click();
    await expect(page.getByRole('heading', { name: 'Short document' })).toBeVisible();

    expect((await savedPositions(page))[longPath]).toMatchObject({ top: 800 });
    await tabFor(page, longPath).click();
    await page.waitForTimeout(200);
    expect(await scrollerTop(page)).toBe(800);
  });

  test('a jump to a question in another document stays put on the next edit', async ({
    page,
    request,
    baseURL,
  }, testInfo) => {
    await returnToCutDocument(page);
    await tabFor(page, shortPath).click();
    await expect(page.getByRole('heading', { name: 'Short document' })).toBeVisible();
    // Back at the unreachable position: the reader has not scrolled since.
    expect((await savedPositions(page))[longPath].top).toBeGreaterThan(await scrollerMax(page));

    const sessionId = testInfo.annotations.find((a) => a.type === 'session')!.description!;
    const ask = await request.post(`${baseURL}/api/review-sessions/${sessionId}/agent-comments`, {
      data: {
        questions: [{ filePath: longPath, anchor: 'Paragraph 12, long', text: 'Is 12 right?' }],
      },
    });
    expect(ask.status()).toBe(201);

    await page.getByRole('button', { name: /Jump to the first question/ }).click();
    const mark = page.locator('[data-doc-page] mark').first();
    await expect(mark).toBeInViewport({ timeout: 5_000 });
    // Let the jump's smooth scroll finish.
    await page.waitForTimeout(800);
    const afterJump = await scrollerTop(page);
    expect(afterJump).toBeLessThan(await scrollerMax(page));

    appendFileSync(longPath, 'An appended line.\n');
    await expect(page.getByText('An appended line.')).toBeAttached();
    await page.waitForTimeout(200);

    expect(await scrollerTop(page)).toBe(afterJump);
    await expect(mark).toBeInViewport();
  });
});

test.describe('Reading position when the view is rebuilt', () => {
  let dir = '';

  test.afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  test.afterAll(() => {
    rmSync(TEMP_FIXTURE_DIR, { recursive: true, force: true });
  });

  test('switching between a document with a diagram and one without returns to each place', async ({
    page,
    request,
    baseURL,
  }, testInfo) => {
    // The viewer is a different element for a document with a Mermaid fence,
    // so React swaps it on this switch, in both directions.
    const review = await openReview(page, request, baseURL!, testInfo, {
      'long.md': sections(80),
      'diagram.md': `# Diagram document\n\n${MERMAID_FENCE}\n${sections(80, 'Part', 'Parts')}`,
    });
    dir = review.dir;
    const [longPath, diagramPath] = review.paths;
    await expect(page.getByRole('heading', { name: 'Section 80' })).toBeAttached({
      timeout: 12_000,
    });

    await scrollToHeading(page, 'Section 61');
    await tabFor(page, diagramPath).click();
    await expect(page.locator('[data-doc-page] .mermaid-svg > svg')).toBeAttached({
      timeout: 10_000,
    });
    await scrollToHeading(page, 'Part 40');

    await tabFor(page, longPath).click();
    await expectReadingAt(page, 'Section 61');
    await tabFor(page, diagramPath).click();
    await expectReadingAt(page, 'Part 40');
  });

  test("an agent edit that adds the document's first diagram keeps the reader in place", async ({
    page,
    request,
    baseURL,
  }, testInfo) => {
    const review = await openReview(page, request, baseURL!, testInfo, {
      'long.md': sections(80),
    });
    dir = review.dir;
    const [longPath] = review.paths;
    await expect(page.getByRole('heading', { name: 'Section 80' })).toBeAttached({
      timeout: 12_000,
    });
    // The SSE file-watcher connection, which delivers the edit.
    await page.waitForTimeout(500);

    await scrollToHeading(page, 'Section 61');
    appendFileSync(longPath, `\n${MERMAID_FENCE}`);
    await expect(page.locator('[data-doc-page] .mermaid-svg > svg')).toBeAttached({
      timeout: 10_000,
    });
    await page.waitForTimeout(200);

    await expectReadingAt(page, 'Section 61');
  });

  test('a first diagram inserted above the reader keeps them on the same text', async ({
    page,
    request,
    baseURL,
  }, testInfo) => {
    // The document had no diagram, so the edit is its first Mermaid fence.
    // The viewer used to be a different element for a document with one, and
    // the remount left nothing to hold the reader's place with.
    const review = await openReview(page, request, baseURL!, testInfo, {
      'long.md': sections(80),
    });
    dir = review.dir;
    const [longPath] = review.paths;
    await expect(page.getByRole('heading', { name: 'Section 80' })).toBeAttached({
      timeout: 12_000,
    });
    // The SSE file-watcher connection, which delivers the edit.
    await page.waitForTimeout(500);

    await scrollToHeading(page, 'Section 61');
    writeFileSync(
      longPath,
      sections(80).replace('## Section 10\n\n', `## Section 10\n\n${MERMAID_FENCE}\n`),
    );
    await expect(page.locator('[data-doc-page] .mermaid-svg > svg')).toBeAttached({
      timeout: 10_000,
    });
    await page.waitForTimeout(300);

    await expectReadingAt(page, 'Section 61');
  });

  test('an agent edit with the find bar open keeps the reader where they are', async ({
    page,
    request,
    baseURL,
  }, testInfo) => {
    // The reader found a match, then read on. An edit above them must neither
    // send them back to the match nor leave them displaced by the edit.
    const review = await openReview(page, request, baseURL!, testInfo, {
      'long.md': sections(80),
    });
    dir = review.dir;
    const [longPath] = review.paths;
    await expect(page.getByRole('heading', { name: 'Section 80' })).toBeAttached({
      timeout: 12_000,
    });
    await page.waitForTimeout(500);

    await page.keyboard.press(withMod('f'));
    const searchBar = page.locator('[data-testid="search-bar"]');
    await searchBar.getByPlaceholder('Find...').fill('Paragraph 5,');
    await expect(page.locator('[data-doc-page] mark[data-search-active]')).toBeInViewport();
    await page.waitForTimeout(800);
    await scrollToHeading(page, 'Section 61');

    writeFileSync(
      longPath,
      sections(80).replace('## Section 10\n\n', '## Section 10\n\nAn inserted paragraph.\n\n'),
    );
    await expect(page.getByText('An inserted paragraph.')).toBeAttached();
    // Long enough for a scroll to the match to have run its course.
    await page.waitForTimeout(800);

    await expect(searchBar).toBeVisible();
    await expectReadingAt(page, 'Section 61');
  });

  test('closing the diff returns the reader to where they were reading', async ({
    page,
    request,
    baseURL,
  }, testInfo) => {
    const review = await openReview(
      page,
      request,
      baseURL!,
      testInfo,
      { 'long.md': sections(80) },
      ([longPath]) => agentEditsNearTheTop(request, baseURL!, longPath),
    );
    dir = review.dir;
    await expect(page.getByRole('heading', { name: 'Section 80' })).toBeAttached({
      timeout: 12_000,
    });
    await expect(diffToggle(page, 'Show')).toBeEnabled({ timeout: 10_000 });

    await scrollToHeading(page, 'Section 61');
    await diffToggle(page, 'Show').click();
    await expect(page.locator('[data-doc-page] [data-chunk-index]').first()).toBeAttached();
    // The diff scrolls itself to its first change, near the top. Let that
    // scroll finish, as a reader reading the diff would: Chrome applies one
    // more step of a smooth scroll still in flight after an instant scrollTo.
    await expect
      .poll(async () => {
        const top = await scrollerTop(page);
        await page.waitForTimeout(150);
        return (await scrollerTop(page)) === top;
      })
      .toBe(true);
    expect(Math.abs(await headingOffset(page, 'Section 61'))).toBeGreaterThan(500);
    await diffToggle(page, 'Hide').click();

    await expectReadingAt(page, 'Section 61');
  });

  test("raw view's inline diff does not overwrite the raw view's place", async ({
    page,
    request,
    baseURL,
  }, testInfo) => {
    const review = await openReview(
      page,
      request,
      baseURL!,
      testInfo,
      { 'long.md': sections(80), 'short.md': '# Short document\n\nOne paragraph.\n' },
      ([longPath]) => agentEditsNearTheTop(request, baseURL!, longPath),
    );
    dir = review.dir;
    const [longPath, shortPath] = review.paths;
    await expect(page.getByRole('heading', { name: 'Section 80' })).toBeAttached({
      timeout: 12_000,
    });
    await expect(diffToggle(page, 'Show')).toBeEnabled({ timeout: 10_000 });

    // Raw view opens its inline diff when there are changes; close it, and
    // read the plain raw view.
    await toggleRaw(page);
    await diffToggle(page, 'Hide').click();
    await expect(diffToggle(page, 'Show')).toBeVisible();
    await rawScrollTop(page, 1500);
    await page.waitForTimeout(100);

    // Open the diff and scroll it somewhere else, then leave.
    await diffToggle(page, 'Show').click();
    await expect(diffToggle(page, 'Hide')).toBeVisible();
    await page.waitForTimeout(800);
    await rawScrollTop(page, 4000);
    await page.waitForTimeout(100);
    await tabFor(page, shortPath).click();
    await expect(page.locator('.raw-view-table')).toContainText('Short document');

    await tabFor(page, longPath).click();
    await expect(page.locator('.raw-view-table')).toContainText('Section 80');
    await expect.poll(() => rawScrollTop(page)).toBe(1500);
  });

  test('the find bar shows its match in the document a tab switch brings in', async ({
    page,
    request,
    baseURL,
  }, testInfo) => {
    const other = sections(80, 'Item', 'Other document').replace(
      '## Item 70\n\n',
      '## Item 70\n\nThe needle sits here.\n\n',
    );
    const review = await openReview(page, request, baseURL!, testInfo, {
      'long.md': sections(80),
      'other.md': other,
    });
    dir = review.dir;
    const [longPath, otherPath] = review.paths;
    await expect(page.getByRole('heading', { name: 'Section 80' })).toBeAttached({
      timeout: 12_000,
    });
    // Give the other document a saved place of its own, far from the match.
    await tabFor(page, otherPath).click();
    await expect(page.getByRole('heading', { name: 'Other document' })).toBeAttached();
    await scrollToHeading(page, 'Item 10');
    await tabFor(page, longPath).click();
    await expect(page.getByRole('heading', { name: 'Long document' })).toBeAttached();

    await page.keyboard.press(withMod('f'));
    const searchBar = page.locator('[data-testid="search-bar"]');
    await searchBar.getByPlaceholder('Find...').fill('needle');
    await tabFor(page, otherPath).click();

    await expect(searchBar).toBeVisible();
    await expect(searchBar.locator('[data-testid="search-match-count"]')).toContainText('1');
    const match = page.locator('[data-doc-page] mark[data-search-active]');
    await expect(match).toBeInViewport({ timeout: 3_000 });
    // Still there once every scroll has settled.
    await page.waitForTimeout(800);
    await expect(match).toBeInViewport();
  });

  test('reopening a document after closing the last tab returns to its place', async ({
    page,
    request,
    baseURL,
  }, testInfo) => {
    const review = await openReview(page, request, baseURL!, testInfo, {
      'long.md': sections(80),
    });
    dir = review.dir;
    const [longPath] = review.paths;
    await expect(page.getByRole('heading', { name: 'Section 80' })).toBeAttached({
      timeout: 12_000,
    });

    await scrollToHeading(page, 'Section 61');
    await page.getByRole('button', { name: 'Close long.md', exact: true }).click();
    await expect(tabFor(page, longPath)).toHaveCount(0);
    await page.waitForTimeout(200);

    await page.locator(`button.w-full.text-left[title="${longPath}"]`).click();
    await expect(page.getByRole('heading', { name: 'Section 80' })).toBeAttached();
    await expectReadingAt(page, 'Section 61');
  });

  test('a Raw/Rendered round trip does not cost the document its place', async ({
    page,
    request,
    baseURL,
  }, testInfo) => {
    // Each view mounts a scroller of its own, so the one the document was
    // opened in is gone after the round trip.
    const review = await openReview(page, request, baseURL!, testInfo, {
      'long.md': sections(80),
      'short.md': '# Short document\n\nOne paragraph.\n',
    });
    dir = review.dir;
    const [longPath, shortPath] = review.paths;
    await expect(page.getByRole('heading', { name: 'Section 80' })).toBeAttached({
      timeout: 12_000,
    });

    await toggleRaw(page);
    await toggleRendered(page);
    await scrollToHeading(page, 'Section 40');
    await tabFor(page, shortPath).click();
    await expect(page.getByRole('heading', { name: 'Short document' })).toBeVisible();
    await tabFor(page, longPath).click();

    await expectReadingAt(page, 'Section 40');
  });

  test('raw view keeps its own place, apart from the rendered one', async ({
    page,
    request,
    baseURL,
  }, testInfo) => {
    const review = await openReview(page, request, baseURL!, testInfo, {
      'long.md': sections(80),
      'short.md': '# Short document\n\nOne paragraph.\n',
    });
    dir = review.dir;
    const [longPath, shortPath] = review.paths;
    await expect(page.getByRole('heading', { name: 'Section 80' })).toBeAttached({
      timeout: 12_000,
    });

    await scrollToHeading(page, 'Section 61');
    await tabFor(page, shortPath).click();
    await expect(page.getByRole('heading', { name: 'Short document' })).toBeVisible();
    await toggleRaw(page);
    await tabFor(page, longPath).click();
    await expect(page.locator('.raw-view-table')).toContainText('Section 80');
    await rawScrollTop(page, 1500);
    await page.waitForTimeout(100);
    await tabFor(page, shortPath).click();
    await expect(page.locator('.raw-view-table')).toContainText('Short document');

    await toggleRendered(page);
    await tabFor(page, longPath).click();
    await expectReadingAt(page, 'Section 61');

    await tabFor(page, shortPath).click();
    await expect(page.getByRole('heading', { name: 'Short document' })).toBeVisible();
    await toggleRaw(page);
    await tabFor(page, longPath).click();
    await expect(page.locator('.raw-view-table')).toContainText('Section 80');
    await expect.poll(() => rawScrollTop(page)).toBe(1500);
  });

  test('an overlay opened before settings arrive does not restore at the wrong width', async ({
    page,
    request,
    baseURL,
  }, testInfo) => {
    // The reader's Document width is narrow. Settings answer late on the
    // reload, and the command palette opens before they do, which reveals the
    // column. The restore must still wait for the width the text wraps at.
    let settingsDelayMs = 0;
    await page.route('**/api/preferences', async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      await new Promise((r) => setTimeout(r, settingsDelayMs));
      await route.fulfill({ json: { settings: { docWidth: 'narrow' } } });
    });
    const review = await openReview(page, request, baseURL!, testInfo, {
      'long.md': sections(80),
    });
    dir = review.dir;
    await expect(page.getByRole('heading', { name: 'Section 80' })).toBeAttached({
      timeout: 12_000,
    });
    await scrollToHeading(page, 'Section 61');

    settingsDelayMs = 800;
    await page.reload();
    await page.locator('[data-doc-page]').waitFor({ state: 'attached', timeout: 10_000 });
    await page.keyboard.press(withMod('k'));
    await expect(page.getByPlaceholder('Type a command...')).toBeVisible();
    // Settings land, and the restore with them.
    await page.waitForTimeout(1_500);
    await page.keyboard.press('Escape');

    await expectReadingAt(page, 'Section 61');
  });

  test('a document whose first load failed is restored once its content arrives', async ({
    page,
    request,
    baseURL,
  }, testInfo) => {
    const review = await openReview(page, request, baseURL!, testInfo, {
      'long.md': sections(80),
      'short.md': '# Short document\n\nOne paragraph.\n',
    });
    dir = review.dir;
    const [longPath] = review.paths;
    await expect(page.getByRole('heading', { name: 'Section 80' })).toBeAttached({
      timeout: 12_000,
    });
    await scrollToHeading(page, 'Section 61');

    // The reload saves the position on its way out, and its first load of the
    // document fails while the file is away.
    renameSync(longPath, `${longPath}.away`);
    await page.reload();
    await expect(page.getByText('File not found or not readable')).toBeVisible({
      timeout: 12_000,
    });
    await page.waitForTimeout(300);

    renameSync(`${longPath}.away`, longPath);
    await page.keyboard.press(withMod('k'));
    await page.getByPlaceholder('Type a command...').fill('Reload file');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: 'Section 80' })).toBeAttached();

    await expectReadingAt(page, 'Section 61');
  });
});
