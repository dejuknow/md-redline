import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkFrontmatter from 'remark-frontmatter';
import remarkGfm from 'remark-gfm';
import remarkRehype from 'remark-rehype';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import rehypeStringify from 'rehype-stringify';
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

function buildProcessor(filePath?: string) {
  return unified()
    .use(remarkParse)
    .use(remarkFrontmatter, ['yaml', 'toml'])
    .use(remarkGfm)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeRaw)
    .use(rewriteLocalUrls, { filePath })
    .use(rehypeSanitize, sanitizeSchema)
    .use(rehypeStringify);
}

export function renderMarkdown(markdown: string, filePath?: string): string {
  const file = buildProcessor(filePath).processSync(markdown);
  return String(file);
}
