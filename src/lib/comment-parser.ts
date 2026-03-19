import type { MdComment, ParseResult } from '../types';

// Match <!-- @comment{...JSON...} --> — use a greedy match up to " -->"
// since JSON values won't contain the literal " -->" sequence.
const COMMENT_PATTERN = /<!-- @comment(\{.*?\}) -->/g;

export function parseComments(rawMarkdown: string): ParseResult {
  const comments: MdComment[] = [];
  const strippedRegions: { rawStart: number; rawEnd: number }[] = [];

  let match: RegExpExecArray | null;
  const regex = new RegExp(COMMENT_PATTERN);

  while ((match = regex.exec(rawMarkdown)) !== null) {
    try {
      const data = JSON.parse(match[1]) as MdComment;
      comments.push(data);
    } catch {
      // Skip malformed comments
    }
    strippedRegions.push({
      rawStart: match.index,
      rawEnd: match.index + match[0].length,
    });
  }

  // Build clean markdown by stripping comment markers
  let cleanMarkdown = '';
  let lastEnd = 0;
  for (const region of strippedRegions) {
    cleanMarkdown += rawMarkdown.slice(lastEnd, region.rawStart);
    lastEnd = region.rawEnd;
  }
  cleanMarkdown += rawMarkdown.slice(lastEnd);

  // Offset mapping: clean position → raw position
  function cleanToRawOffset(cleanOffset: number): number {
    let cumShift = 0;
    for (const region of strippedRegions) {
      const regionCleanStart = region.rawStart - cumShift;
      if (cleanOffset < regionCleanStart) {
        return cleanOffset + cumShift;
      }
      cumShift += region.rawEnd - region.rawStart;
    }
    return cleanOffset + cumShift;
  }

  return { cleanMarkdown, comments, cleanToRawOffset };
}

export function serializeComment(comment: MdComment): string {
  return `<!-- @comment${JSON.stringify(comment)} -->`;
}

export function insertComment(
  rawMarkdown: string,
  anchor: string,
  commentText: string,
  author: string = 'User'
): string {
  const comment: MdComment = {
    id: crypto.randomUUID(),
    anchor,
    text: commentText,
    author,
    timestamp: new Date().toISOString(),
    resolved: false,
  };

  // Find the anchor text in the CLEAN markdown (no comment markers),
  // then map the position back to the raw markdown.
  const { cleanMarkdown, cleanToRawOffset } = parseComments(rawMarkdown);

  let insertionCleanOffset: number | null = null;

  // Try exact match first
  const cleanIdx = cleanMarkdown.indexOf(anchor);
  if (cleanIdx !== -1) {
    insertionCleanOffset = cleanIdx + anchor.length;
  }

  // Flexible match for cross-element selections: split anchor by newlines
  // and find each segment in order. First try against clean markdown directly,
  // then against a formatting-stripped version (handles **bold**, *italic*, etc.)
  if (insertionCleanOffset === null) {
    const segments = anchor.split(/\n+/).map(s => s.trim()).filter(Boolean);
    if (segments.length > 0) {
      // Try direct segment search in clean markdown
      insertionCleanOffset = findSegments(cleanMarkdown, segments);

      // If that fails, try in formatting-stripped text and map back
      if (insertionCleanOffset === null) {
        const { plain, toCleanOffset } = stripInlineFormatting(cleanMarkdown);
        const plainOffset = findSegments(plain, segments);
        if (plainOffset !== null) {
          insertionCleanOffset = toCleanOffset(plainOffset);
        }
      }
    }
  }

  if (insertionCleanOffset === null) return rawMarkdown;

  // Insert right after the anchor text in the raw markdown
  const rawInsertionPoint = cleanToRawOffset(insertionCleanOffset);

  const marker = serializeComment(comment);
  return (
    rawMarkdown.slice(0, rawInsertionPoint) +
    marker +
    rawMarkdown.slice(rawInsertionPoint)
  );
}

export function removeComment(rawMarkdown: string, commentId: string): string {
  const regex = new RegExp(COMMENT_PATTERN);
  return rawMarkdown.replace(regex, (match, json) => {
    try {
      const data = JSON.parse(json) as MdComment;
      if (data.id === commentId) return '';
    } catch {
      // Keep malformed comments
    }
    return match;
  });
}

export function resolveComment(
  rawMarkdown: string,
  commentId: string
): string {
  const regex = new RegExp(COMMENT_PATTERN);
  return rawMarkdown.replace(regex, (match, json) => {
    try {
      const data = JSON.parse(json) as MdComment;
      if (data.id === commentId) {
        data.resolved = true;
        return serializeComment(data);
      }
    } catch {
      // Keep malformed comments
    }
    return match;
  });
}

export function unresolveComment(
  rawMarkdown: string,
  commentId: string
): string {
  const regex = new RegExp(COMMENT_PATTERN);
  return rawMarkdown.replace(regex, (match, json) => {
    try {
      const data = JSON.parse(json) as MdComment;
      if (data.id === commentId) {
        data.resolved = false;
        return serializeComment(data);
      }
    } catch {
      // Keep malformed comments
    }
    return match;
  });
}

export function editComment(
  rawMarkdown: string,
  commentId: string,
  newText: string
): string {
  const regex = new RegExp(COMMENT_PATTERN);
  return rawMarkdown.replace(regex, (match, json) => {
    try {
      const data = JSON.parse(json) as MdComment;
      if (data.id === commentId) {
        data.text = newText;
        return serializeComment(data);
      }
    } catch {
      // Keep malformed comments
    }
    return match;
  });
}

export function updateCommentAnchor(
  rawMarkdown: string,
  commentId: string,
  newAnchor: string
): string {
  const regex = new RegExp(COMMENT_PATTERN);
  return rawMarkdown.replace(regex, (match, json) => {
    try {
      const data = JSON.parse(json) as MdComment;
      if (data.id === commentId) {
        data.anchor = newAnchor;
        return serializeComment(data);
      }
    } catch {
      // Keep malformed comments
    }
    return match;
  });
}

/** Search for ordered segments in text, return the end offset of the last segment or null. */
function findSegments(text: string, segments: string[]): number | null {
  let searchFrom = 0;
  let lastEnd = -1;
  for (const segment of segments) {
    const idx = text.indexOf(segment, searchFrom);
    if (idx === -1) return null;
    lastEnd = idx + segment.length;
    searchFrom = lastEnd;
  }
  return lastEnd === -1 ? null : lastEnd;
}

/**
 * Strip inline markdown formatting (**, *, __, `, ~~) and block-level markers
 * (# headings, - lists, 1. lists) to produce plain text that matches rendered output.
 * Returns a position map to convert plain-text offsets back to clean-markdown offsets.
 */
function stripInlineFormatting(md: string): {
  plain: string;
  toCleanOffset: (off: number) => number;
} {
  const map: number[] = [];
  let plain = '';
  let i = 0;
  const len = md.length;
  const atLineStart = (pos: number) => pos === 0 || md[pos - 1] === '\n';

  while (i < len) {
    // Heading markers at line start
    if (atLineStart(i) && md[i] === '#') {
      while (i < len && md[i] === '#') i++;
      if (i < len && md[i] === ' ') i++;
      continue;
    }

    // List markers at line start: - item, * item, N. item
    if (atLineStart(i)) {
      if ((md[i] === '-' || md[i] === '*') && md[i + 1] === ' ') {
        i += 2;
        continue;
      }
      if (/\d/.test(md[i])) {
        let j = i;
        while (j < len && /\d/.test(md[j])) j++;
        if (md[j] === '.' && md[j + 1] === ' ') {
          i = j + 2;
          continue;
        }
      }
    }

    // Inline formatting: * _ — skip unless flanked by spaces on both sides
    // (space-flanked * and _ are literal, not formatting)
    if (md[i] === '*' || md[i] === '_') {
      const prev = i > 0 ? md[i - 1] : ' ';
      const next = i < len - 1 ? md[i + 1] : ' ';
      if (!(/\s/.test(prev) && /\s/.test(next))) {
        i++;
        continue;
      }
    }

    // Backticks and tildes — always formatting
    if (md[i] === '`' || md[i] === '~') {
      i++;
      continue;
    }

    map.push(i);
    plain += md[i];
    i++;
  }

  return {
    plain,
    toCleanOffset: (off: number) => (off >= map.length ? md.length : map[off]),
  };
}
