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
    '*': [...(defaultSchema.attributes?.['*'] || []), 'className'],
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
