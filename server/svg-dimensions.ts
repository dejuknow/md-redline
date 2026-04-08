/**
 * Inject explicit width/height attributes into an SVG that has only a
 * viewBox.
 *
 * Background: when a browser loads an SVG via `<img src>`, it needs an
 * intrinsic size to know how big to render the image. SVGs with explicit
 * `width`/`height` attributes work fine. SVGs with only a `viewBox` are
 * treated as having an intrinsic aspect ratio but no intrinsic size, and
 * modern browsers stretch them to the container's width — which makes a
 * favicon-style icon render as a giant block in a prose container.
 *
 * Tools like GitHub and Zed avoid this by treating the viewBox's width
 * and height as pixel dimensions. We do the same: if the root `<svg>`
 * tag has a `viewBox` but neither `width` nor `height`, we inject both
 * derived from the viewBox.
 *
 * If the SVG already has width or height set, or has no viewBox, or the
 * viewBox is malformed, we return the input unchanged.
 *
 * Uses `Buffer<ArrayBuffer>` (the narrow non-shared variant returned by
 * `fs.promises.readFile`) so the result is directly assignable to `Response`
 * body, which only accepts `ArrayBuffer`-backed views.
 */
export function injectSvgDimensions(content: Buffer<ArrayBuffer>): Buffer<ArrayBuffer> {
  const text = content.toString('utf-8');

  // Find the root <svg ...> opening tag. The lookahead `(?=[\s/>])` ensures
  // we only match `<svg` followed by whitespace, `>`, or `/` — so we don't
  // accidentally match a namespaced root like `<svg:svg ...>` (which would
  // produce broken output if we tried to inject attributes mid-tag). The
  // simple `[^>]*` for attributes is acceptable because attribute values
  // containing a literal `>` are exceedingly rare in real SVG root tags.
  const tagMatch = text.match(/<svg(?=[\s/>])([^>]*)>/i);
  if (!tagMatch) return content;

  const attrs = tagMatch[1];

  // If either dimension is already set, leave the SVG alone. The author
  // (or upstream tool) clearly intended a specific size.
  if (/\bwidth\s*=/i.test(attrs) || /\bheight\s*=/i.test(attrs)) {
    return content;
  }

  // Find the viewBox. SVG attribute values can be quoted with " or '.
  const vbMatch = attrs.match(/\bviewBox\s*=\s*["']([^"']+)["']/i);
  if (!vbMatch) return content;

  // viewBox is "min-x min-y width height", separated by whitespace
  // and/or commas per the SVG spec. Filter out empty parts so a stray
  // leading or trailing separator doesn't trip the length check.
  const parts = vbMatch[1]
    .trim()
    .split(/[\s,]+/)
    .filter((p) => p !== '');
  if (parts.length !== 4) return content;

  const w = Number(parts[2]);
  const h = Number(parts[3]);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
    return content;
  }

  // Inject `width="W" height="H"` at a known offset: right after the four
  // characters `<svg` of the matched tag. Using tagMatch.index avoids a
  // second regex scan that could match a different `<svg` substring.
  const insertAt = tagMatch.index! + 4; // length of "<svg"
  const injected =
    text.slice(0, insertAt) + ` width="${w}" height="${h}"` + text.slice(insertAt);

  return Buffer.from(injected, 'utf-8');
}
