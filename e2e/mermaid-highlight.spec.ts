import { test, expect, type Page } from '@playwright/test';
import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { resetTestAppState } from './helpers/test-state';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(__dirname, 'fixtures/mermaid-highlight-regression.md');
const FIXTURE_BASELINE = `# Mermaid Highlight Regression

## Flow

\`\`\`mermaid
flowchart TD
    A[Admin navigates to Knowledge Vaults] --> B[Clicks 'Create Knowledge Vault']
    B --> C[Selects 'Website' as source type]
    C --> D[Enters a website URL]
\`\`\`

## Sync Flow

\`\`\`mermaid
flowchart TD
    A[Admin opens existing Website Knowledge Vault] --> B[Clicks 'Sync']
    B --> C[System re-crawls the root URL]
    C --> D[Page selection UI appears with all discovered pages]
    D --> E[Admin reviews pages with status indicators]
    E --> F{Page state?}
    F -->|Existing + unchanged| G[Pre-checked, 'already ingested' badge]
    F -->|Existing + content changed| H[Pre-checked, 'content updated' indicator]
    F -->|Existing + removed from site| I[Flagged as 'page removed', admin decides to keep or delete]
    F -->|New page, not yet ingested| J[Unchecked, admin can opt in]
    G --> K[Admin adjusts selections and confirms]
    H --> K
    I --> K
    J --> K
    K --> L{System processes the diff}
    L -->|Selected + content changed| M[New entry version created, re-ingested]
    L -->|Selected + unchanged| N[No-op, 'last synced' timestamp updated]
    L -->|Newly selected| O[New entry created and ingested]
    L -->|Deselected| P[Entry removed from vault]
    L -->|Removed from site + user confirms removal| Q[Entry removed from vault]
\`\`\`

## Long Labels

\`\`\`mermaid
flowchart TD
    A[Enters a website URL]
    A --> B[Clicks 'Discover Pages' this is a test of really long text to see what happens]
    B --> C[System crawls the site and shows discovered pages will it actually wrap correctly or will it break. yep, it actually breaks if the box is too big.]
    C --> D[Admin reviews list of discovered pages, all pre-selected]
    D --> E[Admin adjusts selection if desired]
\`\`\`
`;

test.beforeEach(async ({ page }) => {
  writeFileSync(FIXTURE, FIXTURE_BASELINE);
  await resetTestAppState(page);
});

test.afterAll(() => {
  writeFileSync(FIXTURE, FIXTURE_BASELINE);
});

async function openFixture(page: Page) {
  await page.goto(`/?file=${FIXTURE}`);
  await page.locator('.prose').waitFor({ timeout: 10_000 });
  await page.locator('.mermaid-block .mermaid-svg svg').first().waitFor({ timeout: 10_000 });
}

async function selectText(page: Page, text: string) {
  await page.evaluate((targetText) => {
    const container = document.querySelector('.prose') || document.body;
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    const textNodes: Text[] = [];
    let node: Text | null;
    while ((node = walker.nextNode() as Text | null)) {
      textNodes.push(node);
    }

    const fullText = textNodes.map((textNode) => textNode.textContent || '').join('');
    const matchStart = fullText.indexOf(targetText);
    if (matchStart === -1) {
      throw new Error(`Text "${targetText}" not found in rendered markdown`);
    }
    const matchEnd = matchStart + targetText.length;

    let pos = 0;
    let startNode: Text | null = null;
    let startOffset = 0;
    let endNode: Text | null = null;
    let endOffset = 0;
    for (const textNode of textNodes) {
      const len = textNode.textContent?.length || 0;
      if (!startNode && pos + len > matchStart) {
        startNode = textNode;
        startOffset = matchStart - pos;
      }
      if (pos + len >= matchEnd) {
        endNode = textNode;
        endOffset = matchEnd - pos;
        break;
      }
      pos += len;
    }

    if (!startNode || !endNode) {
      throw new Error(`Could not build range for "${targetText}"`);
    }

    const range = document.createRange();
    range.setStart(startNode, startOffset);
    range.setEnd(endNode, endOffset);
    const selection = window.getSelection();
    if (!selection) {
      throw new Error('Selection API unavailable');
    }
    selection.removeAllRanges();
    selection.addRange(range);

    const rect = range.getBoundingClientRect();
    (startNode.parentElement || container).dispatchEvent(
      new MouseEvent('mouseup', {
        bubbles: true,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
      }),
    );
  }, text);
}

async function addComment(page: Page, anchorText: string, commentText: string) {
  await selectText(page, anchorText);
  await expect(page.locator('[data-comment-form] button', { hasText: 'Comment' })).toBeVisible();
  await page.locator('[data-comment-form] button', { hasText: 'Comment' }).click();
  await page.getByPlaceholder('Add your comment...').fill(commentText);
  await page.locator('[data-comment-form]').getByRole('button', { name: 'Comment' }).click();
  await expect(page.getByText(commentText, { exact: true })).toBeVisible();
}

test.skip('mermaid comments ignore hidden svg CSS text and keep active highlight on label text', async ({
  page,
}) => {
  const anchor = 'Admin navigates to Knowledge Vaults';
  const commentText = 'Mermaid wrap regression';

  await openFixture(page);
  await addComment(page, anchor, commentText);

  await expect.poll(() => readFileSync(FIXTURE, 'utf8')).toContain(`"text":"${commentText}"`);

  const saved = readFileSync(FIXTURE, 'utf8');
  expect(saved).not.toMatch(/trebuchet ms|sans-serif|edge-animation/i);

  await page.getByText(commentText, { exact: true }).click();

  const mermaidHighlight = await page.evaluate(() => {
    const mark = document.querySelector(
      '.mermaid-block .mermaid-comment-highlight-active',
    ) as HTMLElement | null;
    const node = document.querySelector('#flowchart-A-0');
    const rect = node?.querySelector('rect.label-container, rect.basic.label-container');
    const foreignObject = node?.querySelector('foreignObject');
    const htmlRoot = foreignObject?.firstElementChild;
    if (!mark) return null;

    const style = getComputedStyle(mark);
    return {
      className: mark.className,
      hasGenericActiveClass: mark.classList.contains('comment-highlight-active'),
      height: mark.getBoundingClientRect().height,
      lineHeight: Number.parseFloat(style.lineHeight),
      whiteSpace: style.whiteSpace,
      borderBottom: style.borderBottom,
      nodeRectHeight: Number(rect?.getAttribute('height') || 0),
      foreignObjectHeight: Number(foreignObject?.getAttribute('height') || 0),
      htmlRootHeight: htmlRoot instanceof HTMLElement ? htmlRoot.offsetHeight : 0,
    };
  });

  expect(mermaidHighlight).not.toBeNull();
  expect(mermaidHighlight!.hasGenericActiveClass).toBe(false);
  expect(mermaidHighlight!.className).toContain('mermaid-comment-highlight-active');
  expect(mermaidHighlight!.whiteSpace).toBe('pre-wrap');
  expect(mermaidHighlight!.borderBottom).not.toBe('0px none rgb(0, 0, 0)');
  expect(mermaidHighlight!.height).toBeGreaterThan(mermaidHighlight!.lineHeight * 1.5);
  expect(mermaidHighlight!.foreignObjectHeight).toBeGreaterThanOrEqual(
    mermaidHighlight!.htmlRootHeight,
  );
  expect(mermaidHighlight!.nodeRectHeight).toBeGreaterThan(mermaidHighlight!.foreignObjectHeight);

  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const secondDiagram = document.querySelectorAll('.mermaid-block .mermaid-svg')[1];
          if (!secondDiagram) return ['missing second diagram'];

          return Array.from(secondDiagram.querySelectorAll('.node'))
            .map((node) => {
              const foreignObject = node.querySelector('foreignObject');
              const htmlRoot = foreignObject?.firstElementChild;
              const labelRect = node.querySelector(
                'rect.label-container, rect.basic.label-container',
              );
              const text = htmlRoot?.textContent?.replace(/\s+/g, ' ').trim() || '';
              return {
                text,
                foreignObjectHeight: Number(foreignObject?.getAttribute('height') || 0),
                htmlRootHeight: htmlRoot instanceof HTMLElement ? htmlRoot.offsetHeight : 0,
                labelRectHeight: Number(labelRect?.getAttribute('height') || 0),
              };
            })
            .filter(
              (node) =>
                node.text &&
                (node.foreignObjectHeight + 1 < node.htmlRootHeight ||
                  (node.labelRectHeight > 0 && node.labelRectHeight <= node.foreignObjectHeight)),
            )
            .map(
              (node) =>
                `${node.text} (${node.foreignObjectHeight}/${node.htmlRootHeight}/${node.labelRectHeight})`,
            );
        }),
      { timeout: 5_000 },
    )
    .toEqual([]);

  const secondDiagramSizing = await page.evaluate(() => {
    const secondDiagram = document.querySelectorAll('.mermaid-block .mermaid-svg')[1] as
      | HTMLElement
      | undefined;
    const svg = secondDiagram?.querySelector('svg');
    if (!secondDiagram || !svg) return null;

    return {
      wrapperClientWidth: secondDiagram.clientWidth,
      wrapperScrollWidth: secondDiagram.scrollWidth,
      svgWidth: svg.getBoundingClientRect().width,
    };
  });

  expect(secondDiagramSizing).not.toBeNull();
  expect(secondDiagramSizing!.wrapperScrollWidth).toBeLessThanOrEqual(
    secondDiagramSizing!.wrapperClientWidth + 1,
  );
  expect(secondDiagramSizing!.svgWidth).toBeLessThanOrEqual(
    secondDiagramSizing!.wrapperClientWidth + 1,
  );

  const firstDiagramOrder = await page.evaluate(() => {
    const svg = document.querySelector('.mermaid-block .mermaid-svg svg');
    const root = svg?.querySelector('g.root');
    return root ? Array.from(root.children).map((el) => el.getAttribute('class')) : null;
  });

  expect(firstDiagramOrder).toEqual([
    'clusters',
    'edgePaths',
    'nodes',
    'edgeEndpointOverlays',
    'edgeLabels',
  ]);

  const overlayStyle = await page.evaluate(() => {
    const overlay = document.querySelector('.mermaid-block g.edgeEndpointOverlays path');
    if (!overlay) return null;
    const computed = getComputedStyle(overlay);
    return {
      style: overlay.getAttribute('style'),
      stroke: computed.stroke,
    };
  });

  expect(overlayStyle).not.toBeNull();
  expect(overlayStyle!.style).toContain('stroke: transparent');
  expect(overlayStyle!.stroke).toBe('rgba(0, 0, 0, 0)');

  const edgeLabelSizing = await page.evaluate(() => {
    const secondDiagram = document.querySelectorAll('.mermaid-block .mermaid-svg')[1];
    if (!secondDiagram) return [];

    return Array.from(secondDiagram.querySelectorAll('g.edgeLabel'))
      .map((edgeLabel) => {
        const foreignObject = edgeLabel.querySelector('foreignObject');
        const htmlRoot = foreignObject?.firstElementChild;
        return {
          text: htmlRoot?.textContent?.replace(/\s+/g, ' ').trim() || '',
          foreignObjectHeight: Number(foreignObject?.getAttribute('height') || 0),
          htmlRootHeight: htmlRoot instanceof HTMLElement ? htmlRoot.offsetHeight : 0,
        };
      })
      .filter((label) => label.text.includes('Removed from site'));
  });

  expect(edgeLabelSizing).toEqual([
    expect.objectContaining({
      text: 'Removed from site + user confirms removal',
      foreignObjectHeight: expect.any(Number),
      htmlRootHeight: expect.any(Number),
    }),
  ]);
  expect(edgeLabelSizing[0].foreignObjectHeight).toBeGreaterThanOrEqual(
    edgeLabelSizing[0].htmlRootHeight,
  );
});

test.skip('mermaid drag keeps mermaid-specific highlight styling and escape restores the anchor', async ({
  page,
}) => {
  const anchor = 'Admin navigates to Knowledge Vaults';
  const commentText = 'Mermaid drag regression';

  await openFixture(page);
  await addComment(page, anchor, commentText);

  const commentCardText = page.getByText(commentText, { exact: true });
  await commentCardText.click();
  await expect(page.locator('[data-drag-handle]')).toHaveCount(2);

  const endHandle = page.locator('[data-drag-handle]').last();
  const handleBox = await endHandle.boundingBox();
  expect(handleBox).not.toBeNull();

  await endHandle.hover();
  await page.mouse.down();
  await page.mouse.move(handleBox!.x - 30, handleBox!.y + handleBox!.height / 2, { steps: 6 });
  await page.waitForTimeout(100);

  const dragState = await page.evaluate(() => {
    const activeMark = document.querySelector(
      '.mermaid-block .mermaid-comment-highlight-active',
    ) as HTMLElement | null;
    const genericMark = document.querySelector('.mermaid-block .comment-highlight-active');
    if (!activeMark) return null;

    const style = getComputedStyle(activeMark);
    return {
      genericMarkExists: genericMark != null,
      whiteSpace: style.whiteSpace,
      inlineBackground: activeMark.style.backgroundColor,
      inlineBorderBottom: activeMark.style.borderBottom,
    };
  });

  expect(dragState).not.toBeNull();
  expect(dragState!.genericMarkExists).toBe(false);
  expect(dragState!.whiteSpace).toBe('pre-wrap');
  expect(dragState!.inlineBackground).not.toBe('');
  expect(dragState!.inlineBorderBottom).toContain('solid');

  await page.keyboard.press('Escape');

  const postEscapeState = await page.evaluate(() => {
    const activeMark = document.querySelector(
      '.mermaid-block .mermaid-comment-highlight-active',
    ) as HTMLElement | null;
    const genericMark = document.querySelector('.mermaid-block .comment-highlight-active');
    return {
      genericMarkExists: genericMark != null,
      text: activeMark?.textContent?.replace(/\s+/g, ' ').trim() || '',
    };
  });

  expect(postEscapeState.genericMarkExists).toBe(false);
  expect(postEscapeState.text).toBe(anchor);
});

test.skip('long wrapped mermaid labels do not overlap surrounding boxes', async ({ page }) => {
  await page.setViewportSize({ width: 1050, height: 900 });
  await openFixture(page);

  const longLabelGaps = await page.evaluate(() => {
    const thirdDiagram = document.querySelectorAll('.mermaid-block .mermaid-svg')[2];
    if (!thirdDiagram) return null;

    const nodes = Array.from(thirdDiagram.querySelectorAll('.node'))
      .map((node) => {
        const htmlRoot = node.querySelector('foreignObject')?.firstElementChild;
        const text = htmlRoot?.textContent?.replace(/\s+/g, ' ').trim() || '';
        const rect = (node as SVGGElement).getBoundingClientRect();
        return {
          text,
          top: rect.top,
          bottom: rect.bottom,
          height: rect.height,
        };
      })
      .filter((node) => node.text);

    return nodes.slice(0, -1).map((node, index) => ({
      text: node.text,
      nextText: nodes[index + 1].text,
      gap: nodes[index + 1].top - node.bottom,
    }));
  });

  expect(longLabelGaps).not.toBeNull();
  expect(longLabelGaps).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        text: expect.stringContaining("Clicks 'Discover Pages'"),
        nextText: expect.stringContaining('System crawls the site'),
        gap: expect.any(Number),
      }),
      expect.objectContaining({
        text: expect.stringContaining('System crawls the site'),
        nextText: expect.stringContaining('Admin reviews list of discovered pages'),
        gap: expect.any(Number),
      }),
    ]),
  );

  for (const item of longLabelGaps!) {
    expect(item.gap).toBeGreaterThan(50);
  }

  const overlayAlignment = await page.evaluate(() => {
    const thirdDiagram = document.querySelectorAll('.mermaid-block .mermaid-svg')[2];
    if (!thirdDiagram) return null;

    const parseTranslateY = (transform: string | null) => {
      if (!transform) return 0;
      const match = transform.match(
        /^translate\(\s*[-+]?\d*\.?\d+(?:e[-+]?\d+)?\s*(?:,|\s)\s*([-+]?\d*\.?\d+(?:e[-+]?\d+)?)\s*\)/i,
      );
      return match ? Number.parseFloat(match[1]) : 0;
    };

    const parseEndpoint = (pathData: string | null) => {
      if (!pathData) return null;
      const numbers = pathData
        .match(/[-+]?\d*\.?\d+(?:e[-+]?\d+)?/gi)
        ?.map((value) => Number.parseFloat(value));
      if (!numbers || numbers.length < 2) return null;
      return {
        x: numbers[numbers.length - 2],
        y: numbers[numbers.length - 1],
      };
    };

    const getMarkerForwardExtent = (path: SVGPathElement) => {
      const markerUrl = path.getAttribute('marker-end');
      const markerId = markerUrl?.match(/url\(#([^)]+)\)/)?.[1];
      if (!markerId) return 0;

      const marker = thirdDiagram.querySelector(
        `marker#${CSS.escape(markerId)}`,
      ) as SVGMarkerElement | null;
      if (!marker) return 0;

      const viewBox = marker.viewBox?.baseVal;
      const refX =
        marker.refX?.baseVal?.value ?? Number.parseFloat(marker.getAttribute('refX') || '0');
      let maxX = Number.isFinite(viewBox?.width) ? viewBox!.x + viewBox!.width : Number.NaN;

      for (const child of Array.from(marker.children)) {
        if (!(child instanceof SVGGraphicsElement)) continue;
        const bbox = child.getBBox();
        if (Number.isFinite(bbox.width)) {
          maxX = Number.isFinite(maxX) ? Math.max(maxX, bbox.x + bbox.width) : bbox.x + bbox.width;
        }
      }

      if (!Number.isFinite(maxX)) return 0;

      const markerWidth =
        marker.markerWidth?.baseVal?.value ??
        Number.parseFloat(marker.getAttribute('markerWidth') || '0');
      const scaleX =
        viewBox && viewBox.width > 0 && Number.isFinite(markerWidth) && markerWidth > 0
          ? markerWidth / viewBox.width
          : 1;

      return Math.max(0, (maxX - refX) * scaleX);
    };

    const nodes = Array.from(thirdDiagram.querySelectorAll('.node'))
      .map((node) => {
        const htmlRoot = node.querySelector('foreignObject')?.firstElementChild;
        const text = htmlRoot?.textContent?.replace(/\s+/g, ' ').trim() || '';
        const rect = node.querySelector('rect.label-container, rect.basic.label-container');
        return {
          text,
          top:
            parseTranslateY(node.getAttribute('transform')) +
            Number.parseFloat(rect?.getAttribute('y') || '0'),
        };
      })
      .filter((node) => node.text);

    const overlays = Array.from(thirdDiagram.querySelectorAll('g.edgeEndpointOverlays path'))
      .map((path) => ({
        sourceId: path.getAttribute('data-source-edge-id'),
        endPoint: parseEndpoint(path.getAttribute('d')),
        markerForwardExtent: getMarkerForwardExtent(path as SVGPathElement),
      }))
      .filter((overlay) => overlay.endPoint != null);

    return overlays.map((overlay, index) => ({
      sourceId: overlay.sourceId,
      targetText: nodes[index + 1]?.text ?? '',
      targetTop: nodes[index + 1]?.top ?? NaN,
      endY: overlay.endPoint!.y,
      tipY: overlay.endPoint!.y + overlay.markerForwardExtent,
    }));
  });

  expect(overlayAlignment).not.toBeNull();
  for (const item of overlayAlignment!) {
    expect(item.targetText).not.toBe('');
    expect(item.endY).toBeLessThan(item.targetTop);
    expect(Math.abs(item.tipY - item.targetTop)).toBeLessThanOrEqual(2);
  }
});
