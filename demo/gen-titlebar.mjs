#!/usr/bin/env node
// Generates title bar PNG files for the demo video.
// Uses Playwright to render an HTML title bar and screenshot it.
// Usage: node demo/gen-titlebar.mjs

import { chromium } from '@playwright/test';
import { mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(__dirname, 'assets');
mkdirSync(outDir, { recursive: true });

const WIDTH = 1440; // matches terminal window width in record.sh
const HEIGHT = 40;
// Only need the Claude Code title bar now (browser clips render chrome in-page)

const titles = [
  { file: 'titlebar-claude.png', title: 'Claude Code' },
  { file: 'titlebar-mdr.png', title: 'md-redline' },
];

const html = (title) => `<!DOCTYPE html>
<html><head><style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { width: ${WIDTH}px; height: ${HEIGHT}px; overflow: hidden; }
  .bar {
    width: ${WIDTH}px; height: ${HEIGHT}px;
    background: #232730;
    display: flex; align-items: center;
    padding: 0 14px;
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif;
  }
  .dots { display: flex; gap: 8px; }
  .dots span { width: 12px; height: 12px; border-radius: 50%; display: inline-block; }
  .close { background: #FF5F56; }
  .minimize { background: #FFBD2E; }
  .maximize { background: #27C93F; }
  .title {
    flex: 1; text-align: center;
    color: #8a919e; font-size: 13px;
    margin-right: 52px;
  }
</style></head><body>
<div class="bar">
  <div class="dots">
    <span class="close"></span>
    <span class="minimize"></span>
    <span class="maximize"></span>
  </div>
  <span class="title">${title}</span>
</div>
</body></html>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });

for (const { file, title } of titles) {
  await page.setContent(html(title));
  await page.screenshot({ path: resolve(outDir, file), type: 'png' });
  console.log(`  ${file}`);
}

await browser.close();
