export type LinkifySegment =
  | { kind: 'text'; text: string }
  | { kind: 'link'; text: string; href: string };

// A URL candidate: an http(s) scheme or a bare `www.`, running to whitespace,
// `<`, `>` or a backtick (the delimiters of `<url>` and `` `url` ``). A comma
// directly followed by another scheme ends it too, so `a.com,https://b.com`
// is two links. Trailing punctuation is trimmed afterwards.
const CANDIDATE = /(?:https?:\/\/|www\.)(?:(?!,https?:\/\/)[^\s<>`])+/gi;

// Sentence punctuation and closing quotes that prose puts after a URL,
// including typographic quotes and CJK full-width punctuation.
const TRAILING = /[?!.,:;*_~'"’”、。！，：；？]$/;

// Closing brackets kept only when the URL itself opened them.
const PAIRS: Array<[open: string, close: string]> = [
  ['(', ')'],
  ['[', ']'],
  ['（', '）'],
];

/**
 * Trim what prose puts after a URL: sentence punctuation, closing quotes, and
 * a closing bracket that closes something opened before the link rather than
 * inside it. Mirrors GFM's bare-autolink trimming.
 */
function trimTrailing(url: string): string {
  let end = url.length;
  outer: for (;;) {
    const run = url.slice(0, end);
    if (TRAILING.test(run)) {
      end--;
      continue;
    }
    for (const [open, close] of PAIRS) {
      if (run.endsWith(close) && count(run, close) > count(run, open)) {
        end--;
        continue outer;
      }
    }
    return run;
  }
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
    const prev = start > 0 ? text[start - 1] : ' ';
    const url = trimTrailing(m[0]);
    const scheme = /^https?:\/\//i.exec(url);
    const isWww = !scheme && /^www\./i.test(url);
    // GFM's boundaries: a scheme may follow anything but a letter; a `www.`
    // may not sit inside a word, a path, a domain or an email address.
    if (scheme ? /[A-Za-z]/.test(prev) : /[A-Za-z0-9/.@_-]/.test(prev)) continue;
    // A scheme or `www.` with no host left after trimming is not a link.
    const host = scheme ? url.slice(scheme[0].length) : isWww ? url.slice(4) : '';
    if (!/^[\p{L}\p{N}]/u.test(host)) continue;
    if (start > last) segments.push({ kind: 'text', text: text.slice(last, start) });
    segments.push({ kind: 'link', text: url, href: isWww ? `https://${url}` : url });
    last = start + url.length;
  }
  if (last < text.length) segments.push({ kind: 'text', text: text.slice(last) });
  return segments;
}
