import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkFrontmatter from 'remark-frontmatter';
import remarkGfm from 'remark-gfm';
import remarkRehype from 'remark-rehype';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import rehypeStringify from 'rehype-stringify';
import { visit, SKIP } from 'unist-util-visit';
import type { Root, Element } from 'hast';
import { rewriteLocalUrls } from './rewriteLocalUrls';

// Allow mark elements (used for comment highlights), data-* attributes, and
// the data-mdr-* attrs that the local-link rewriter emits on <a> tags.
// Allow className only on elements that remark-gfm / remark-rehype / our
// highlight pipeline actually emit classes on. A wildcard `*` would let
// markdown authors apply arbitrary CSS classes for UI spoofing.
const CLASS_NAME_ELEMENTS = [
  'code', 'pre', 'span', 'li', 'input', 'div',
  'table', 'thead', 'tbody', 'tr', 'td', 'th',
] as const;

const sanitizeSchema = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames || []), 'mark'],
  attributes: {
    ...defaultSchema.attributes,
    mark: ['className', 'dataCommentIds'],
    a: [
      ...(defaultSchema.attributes?.a || []),
      'dataMdrLocalMd',
      'dataMdrFragment',
      'target',
      'rel',
    ],
    ...Object.fromEntries(
      CLASS_NAME_ELEMENTS.map((tag) => [
        tag,
        [...(defaultSchema.attributes?.[tag] || []), 'className'],
      ]),
    ),
  },
};

/**
 * Wrap every <table> in a horizontal-scroll container so wide tables scroll
 * within their own box instead of being clipped by the sheet's `overflow: clip`
 * (which can't become `auto` without capturing the sticky rail header — see the
 * `.doc-sheet` comment in index.css). Structure:
 *   div.table-scroll > div.table-scroll__viewport > table
 * The outer div anchors the edge-fade cue; the inner div is the scrollport.
 * Only elements are wrapped, so text nodes are untouched and comment anchoring
 * is unaffected.
 */
function rehypeWrapTables() {
  return (tree: Root) => {
    visit(tree, 'element', (node: Element, index, parent) => {
      if (node.tagName !== 'table' || parent == null || typeof index !== 'number') {
        return;
      }
      const viewport: Element = {
        type: 'element',
        tagName: 'div',
        properties: { className: ['table-scroll__viewport'] },
        children: [node],
      };
      const wrapper: Element = {
        type: 'element',
        tagName: 'div',
        properties: { className: ['table-scroll'] },
        children: [viewport],
      };
      parent.children[index] = wrapper;
      // Don't descend into the wrapper we just inserted (it re-contains the
      // table); resume after it.
      return [SKIP, index + 1];
    });
  };
}

function buildProcessor(filePath?: string) {
  return unified()
    .use(remarkParse)
    .use(remarkFrontmatter, ['yaml', 'toml'])
    .use(remarkGfm)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeRaw)
    .use(rewriteLocalUrls, { filePath })
    .use(rehypeSanitize, sanitizeSchema)
    .use(rehypeWrapTables)
    .use(rehypeStringify);
}

export function renderMarkdown(markdown: string, filePath?: string): string {
  const file = buildProcessor(filePath).processSync(markdown);
  return String(file);
}
