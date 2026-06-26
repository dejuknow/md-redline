import DOMPurify from 'dompurify';

/**
 * Second sanitization layer for rendered markdown HTML. rehype-sanitize in
 * the markdown pipeline is the primary sanitizer; this catches anything that
 * slips through a remark/rehype bypass. The two allowlists must stay in sync:
 * an attribute the pipeline emits but DOMPurify strips silently disappears
 * from the viewer (that is how external links lost their target="_blank").
 */
export function sanitizeRenderedMarkdown(html: string): string {
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    ADD_TAGS: ['mark'],
    // DOMPurify's default allowlist has rel but not target, so without this
    // the target="_blank" the pipeline puts on external links gets stripped.
    ADD_ATTR: ['target', 'data-comment-ids', 'data-mdr-local-md', 'data-mdr-fragment'],
  });
}
