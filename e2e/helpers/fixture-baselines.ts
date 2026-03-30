import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASELINE_DIR = resolve(__dirname, '../fixtures/baselines');

function readBaseline(name: string): string {
  return readFileSync(resolve(BASELINE_DIR, name), 'utf-8');
}

export const TEST_DOC_BASELINE = readBaseline('test-doc.md');
export const TEST_DOC_2_BASELINE = readBaseline('test-doc-2.md');
export const FORMATTED_DOC_BASELINE = readBaseline('formatted-doc.md');
export const TOC_DOC_BASELINE = readBaseline('toc-doc.md');
export const HIGHLIGHT_SEAM_DOC_BASELINE = readBaseline('highlight-seam-doc.md');
