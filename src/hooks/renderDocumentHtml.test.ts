import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../markdown/pipeline', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../markdown/pipeline')>();
  return { ...actual, renderMarkdown: vi.fn(actual.renderMarkdown) };
});

import { renderMarkdown } from '../markdown/pipeline';
import { RENDERED_HTML_CACHE_SIZE, renderDocumentHtml } from './useComments';

const render = vi.mocked(renderMarkdown);
let doc = 0;
const uniqueDoc = () => `# Doc ${++doc}\n\nSome text for document ${doc}.\n`;

describe('renderDocumentHtml', () => {
  beforeEach(() => render.mockClear());

  it('renders a document once and serves it again from the cache', () => {
    const md = uniqueDoc();
    const first = renderDocumentHtml(md, '/a/doc.md', {});
    const second = renderDocumentHtml(md, '/a/doc.md', {});
    expect(second).toBe(first);
    expect(first).toBe(renderMarkdown(md, '/a/doc.md', {}));
    expect(render).toHaveBeenCalledTimes(2); // once cached, once by the assertion
  });

  it('renders again for another path or other options', () => {
    const md = uniqueDoc();
    renderDocumentHtml(md, '/a/doc.md', {});
    renderDocumentHtml(md, '/b/doc.md', {});
    renderDocumentHtml(md, '/b/doc.md', { keepLineBreaks: true });
    renderDocumentHtml(md, '/b/doc.md', { keepLineBreaks: true, hiddenCommentPrefixes: ['x'] });
    expect(render).toHaveBeenCalledTimes(4);
    renderDocumentHtml(md, '/b/doc.md', { keepLineBreaks: true, hiddenCommentPrefixes: ['x'] });
    expect(render).toHaveBeenCalledTimes(4);
  });

  it(`keeps the ${RENDERED_HTML_CACHE_SIZE} most recently used documents`, () => {
    const docs = Array.from({ length: RENDERED_HTML_CACHE_SIZE + 1 }, uniqueDoc);
    for (const md of docs) renderDocumentHtml(md, undefined, {});
    expect(render).toHaveBeenCalledTimes(docs.length);
    // The oldest fell out; the rest are still there.
    for (const md of docs.slice(1)) renderDocumentHtml(md, undefined, {});
    expect(render).toHaveBeenCalledTimes(docs.length);
    renderDocumentHtml(docs[0], undefined, {});
    expect(render).toHaveBeenCalledTimes(docs.length + 1);
  });
});
