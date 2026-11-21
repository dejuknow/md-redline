export type LinkifySegment =
  | { kind: 'text'; text: string }
  | { kind: 'link'; text: string; href: string };

// A URL candidate: an http(s) scheme or a bare `www.`, running to whitespace
// or `<`. Trailing punctuation is trimmed afterwards.
const CANDIDATE = /\b(?:https?:\/\/|www\.)[^\s<]+/gi;

/**
 * Trim what prose puts after a URL: sentence punctuation, closing quotes, and
 * a `)` or `]` that closes something opened before the link rather than
 * inside it. Mirrors GFM's bare-autolink trimming.
 */
function trimTrailing(url: string): string {
  let end = url.length;
  for (;;) {
    const run = url.slice(0, end);
    if (/[?!.,:;*_~'"]$/.test(run)) end--;
    else if (run.endsWith(')') && count(run, ')') > count(run, '(')) end--;
    else if (run.endsWith(']') && count(run, ']') > count(run, '[')) end--;
    else break;
  }
  return url.slice(0, end);
}

function count(s: string, ch: string): number {
  let n = 0;
  for (const c of s) if (c === ch) n++;
  return n;
}

/**
 * Split plain comment text into text and link segments. Only `http://`,
 * `https://` and `www.` links are recognized; a `www.` link gets an
 * `https://` href. Joining every segment's `text` gives back the input.
 */
export function linkify(text: string): LinkifySegment[] {
  const segments: LinkifySegment[] = [];
  let last = 0;
  for (const m of text.matchAll(CANDIDATE)) {
    const start = m.index;
    // A `www.` inside a word (`foowww.x`) or after a scheme is not a new link.
    if (start > 0 && /[A-Za-z0-9/.]/.test(text[start - 1])) continue;
    const url = trimTrailing(m[0]);
    const isWww = /^www\./i.test(url);
    // A scheme or `www.` with no host after it is not a link.
    if (!/[A-Za-z0-9]/.test(url.slice(isWww ? 4 : url.indexOf('//') + 2))) continue;
    if (start > last) segments.push({ kind: 'text', text: text.slice(last, start) });
    segments.push({ kind: 'link', text: url, href: isWww ? `https://${url}` : url });
    last = start + url.length;
  }
  if (last < text.length) segments.push({ kind: 'text', text: text.slice(last) });
  return segments;
}
