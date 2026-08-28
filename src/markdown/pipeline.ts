import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkFrontmatter from 'remark-frontmatter';
import remarkGfm from 'remark-gfm';
import remarkRehype from 'remark-rehype';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import rehypeStringify from 'rehype-stringify';
import { visit, SKIP } from 'unist-util-visit';
import { visitParents } from 'unist-util-visit-parents';
import type { Root, Element } from 'hast';
import { rewriteLocalUrls } from './rewriteLocalUrls';

// Allow mark elements (used for comment highlights) and the data-mdr-* attrs
// that the local-link rewriter emits on <a> tags. Note what is NOT here: a
// blanket data-* allowance. rehypeAnnotateSource writes data-src-start /
// data-src-end AFTER this schema runs, and its whole safety argument is that a
// document cannot smuggle its own copy of those through raw HTML.
// Allow className only on elements that remark-gfm / remark-rehype / our
// highlight pipeline actually emit classes on. A wildcard `*` would let
// markdown authors apply arbitrary CSS classes for UI spoofing.
const CLASS_NAME_ELEMENTS = [
  'code',
  'pre',
  'span',
  'li',
  'input',
  'div',
  'table',
  'thead',
  'tbody',
  'tr',
  'td',
  'th',
] as const;

const sanitizeSchema = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames || []), 'mark'],
  // defaultSchema.protocols.src is ['http', 'https'], which strips the src off
  // any <img> that uses a data: URI, so base64-embedded images render as a
  // broken icon with only their alt text. Allow data: for src so inline images
  // survive. Scripts inside an SVG loaded via <img src> cannot execute, and the
  // DOMPurify pass in sanitize-html.ts independently permits data: only on the
  // media tags (img, source, etc.), so this stays safe.
  protocols: {
    ...defaultSchema.protocols,
    src: [...(defaultSchema.protocols?.src || []), 'data'],
  },
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
 * Block-level tags that carry their source span. Copying slices the source only
 * when a selection's boundaries line up with one of these; anything finer is
 * rebuilt from the rendered fragment instead, which needs no positions.
 *
 * Deliberately not every element. Annotating inline nodes too grew the rendered
 * HTML of a 118KB document from 134KB to 209KB, and that string is assigned
 * through innerHTML on every render of the layout effect. Blocks alone cost
 * 158KB, a third of the increase, and cover what exact slicing is for: a
 * paragraph, a heading, a list item, a fenced block, a whole table.
 */
const SOURCE_SPAN_TAGS = new Set([
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'li',
  'blockquote',
  'pre',
  'ul',
  'ol',
  'table',
]);

/**
 * Containers whose markers travel with every line they hold, so a block nested
 * inside one does not slice back to anything clean: a paragraph in a blockquote
 * spans `quoted line\n> more`, with the marker stranded mid-text, and a
 * paragraph in a list item carries the continuation indent. The container's own
 * span is clean, so that is the one worth recording.
 *
 * Table cells are excluded a level up, by being absent from SOURCE_SPAN_TAGS:
 * remark-gfm starts a cell at the preceding pipe, so adjacent cells share a
 * delimiter and neither one slices back to its own content.
 */
const MARKER_CARRYING_ANCESTORS = new Set(['blockquote', 'li']);

/**
 * Record where each block came from in the source, as `data-src-start` and
 * `data-src-end`.
 *
 * Runs AFTER `rehypeSanitize`, and that order is the security property: a
 * document can write `<span data-src-start="0" data-src-end="99999">` in raw
 * HTML, sanitize strips attributes it does not know, and only then does this
 * write the real span. A document cannot forge a range that a copy would slice.
 *
 * Offsets index the string this pipeline was handed, which for the viewer is
 * `cleanMarkdown`: the document with comment markers removed, and the string
 * that belongs on a clipboard.
 */
function rehypeAnnotateSource() {
  return (tree: Root, file: { value: unknown }) => {
    // micromark skips a leading byte-order mark before it starts counting, so
    // every position in a BOM-prefixed document is one short of the string's
    // own index. The spans index the string, since that is what a copy slices.
    const bom = String(file.value).charCodeAt(0) === 0xfeff ? 1 : 0;
    visitParents(tree, 'element', (node: Element, ancestors) => {
      if (!SOURCE_SPAN_TAGS.has(node.tagName)) return;
      if (
        ancestors.some(
          (a) => a.type === 'element' && MARKER_CARRYING_ANCESTORS.has((a as Element).tagName),
        )
      ) {
        return;
      }
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      // Elements the pipeline invents (the table scroll wrappers, the
      // frontmatter box) have no source of their own and get nothing.
      if (start == null || end == null) return;
      node.properties = {
        ...node.properties,
        dataSrcStart: String(start + bom),
        dataSrcEnd: String(end + bom),
      };
    });
  };
}

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

/**
 * Render a frontmatter block as visible document content.
 *
 * Frontmatter is content in a review tool: a skill file's `description` is the
 * text an agent reads to decide whether to load the skill, an ADR's `status`
 * is a claim someone will want to argue with. remark-rehype has no handler for
 * `yaml` / `toml` nodes, so without this they never reach the HTML.
 *
 * The emitted text is byte-identical to the source, fences excluded. That is a
 * hard requirement, not a stylistic one: comments anchor by searching the raw
 * markdown for the text the DOM handed us, so any transformation here (a
 * prettified key, a stripped quote, a re-wrapped fold) means `insertComment`
 * can't find the anchor and returns the document unchanged, so the comment
 * vanishes with no marker and no error. Style it with CSS, never by rewriting
 * the string.
 *
 * Keys are wrapped in a span for styling only; the delimiter and value stay in
 * their own text nodes so the concatenated text still matches the source. Key
 * detection is a line-shape heuristic, not a YAML parse, so it is deliberately
 * confined to styling: nothing downstream may depend on which runs get the
 * span.
 */
function frontmatterHandler(_state: unknown, node: { value: string }): Element | undefined {
  // An empty block (`---\n---`) would otherwise render as a bare tinted box
  // above the first heading. Returning undefined drops the node entirely.
  if (node.value.trim() === '') return undefined;

  const children: (Element | { type: 'text'; value: string })[] = [];
  const lines = node.value.split('\n');

  // A folded value continues on deeper-indented lines, and those lines
  // routinely contain a colon of their own: a URL, a ratio, a time, a wrapped
  // "Note: ...". Matching key shape alone paints `http` and `3` as keys. A
  // continuation is a deeper-indented line following a key that already had a
  // value on it; a deeper-indented line under a key with NO inline value is a
  // nested key or a list item, which is a different thing. Presentation only:
  // either way the emitted text is unchanged.
  let lastKeyIndent = -1;
  let lastKeyHadValue = false;

  lines.forEach((line, index) => {
    // `key:` for YAML, `key =` for TOML. Anything else (list items, nested
    // maps, folded continuation lines) passes through untouched.
    const keyed = /^([ \t]*)([A-Za-z0-9_.-]+)([ \t]*[:=])(.*)$/.exec(line);
    const indent = /^[ \t]*/.exec(line)?.[0].length ?? 0;
    const isContinuation = lastKeyHadValue && indent > lastKeyIndent;
    if (keyed && !isContinuation) {
      const [, leading, key, delimiter, rest] = keyed;
      lastKeyIndent = indent;
      lastKeyHadValue = rest.trim().length > 0;
      if (leading) children.push({ type: 'text', value: leading });
      children.push({
        type: 'element',
        tagName: 'span',
        properties: { className: ['doc-frontmatter__key'] },
        children: [{ type: 'text', value: key }],
      });
      children.push({ type: 'text', value: delimiter + rest });
    } else if (line) {
      children.push({ type: 'text', value: line });
    }
    if (index < lines.length - 1) children.push({ type: 'text', value: '\n' });
  });

  return {
    type: 'element',
    tagName: 'div',
    properties: { className: ['doc-frontmatter'] },
    children: children as Element['children'],
  };
}

function buildProcessor(filePath?: string, allowFrontmatter = true) {
  const processor = unified().use(remarkParse);
  // Frontmatter is defined as being at offset 0 of the DOCUMENT. A caller
  // rendering a fragment (the diff overlay renders one segment at a time) has
  // a string whose offset 0 is somewhere in the middle of the file, so leaving
  // this on invents a frontmatter block out of any `---` that happens to start
  // a segment.
  if (allowFrontmatter) processor.use(remarkFrontmatter, ['yaml', 'toml']);
  return processor
    .use(remarkGfm)
    .use(remarkRehype, {
      allowDangerousHtml: true,
      handlers: { yaml: frontmatterHandler, toml: frontmatterHandler },
    })
    .use(rehypeRaw)
    .use(rewriteLocalUrls, { filePath })
    .use(rehypeSanitize, sanitizeSchema)
    .use(rehypeAnnotateSource)
    .use(rehypeWrapTables)
    .use(rehypeStringify);
}

export interface RenderOptions {
  /**
   * Whether the string being rendered is a whole document. Fragments (a diff
   * segment, say) must pass false: frontmatter is an offset-0 construct and a
   * fragment's offset 0 is not the document's.
   */
  allowFrontmatter?: boolean;
}

export function renderMarkdown(
  markdown: string,
  filePath?: string,
  options: RenderOptions = {},
): string {
  const { allowFrontmatter = true } = options;
  const file = buildProcessor(filePath, allowFrontmatter).processSync(markdown);
  return String(file);
}
