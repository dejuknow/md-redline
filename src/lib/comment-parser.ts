import { getEffectiveStatus, type MdComment, type ParseResult, type CommentReply } from '../types';

// Match <!-- @comment{...JSON...} --> — use dotall flag so JSON with
// newlines in string values is matched correctly.
const COMMENT_PATTERN = /<!-- @comment(\{.*?\}) -->/gs;

export function parseComments(rawMarkdown: string): ParseResult {
  const comments: MdComment[] = [];
  const strippedRegions: { rawStart: number; rawEnd: number; parsed: boolean }[] = [];

  // Build list of fenced code block ranges to skip markers inside them
  const codeBlockRanges: { start: number; end: number }[] = [];
  const fenceRegex = /^(`{3,}|~{3,}).*$/gm;
  let fenceMatch: RegExpExecArray | null;
  let openFence: { marker: string; start: number } | null = null;
  while ((fenceMatch = fenceRegex.exec(rawMarkdown)) !== null) {
    const marker = fenceMatch[1];
    if (!openFence) {
      openFence = { marker: marker[0].repeat(marker.length), start: fenceMatch.index };
    } else if (marker[0] === openFence.marker[0] && marker.length >= openFence.marker.length) {
      codeBlockRanges.push({ start: openFence.start, end: fenceMatch.index + fenceMatch[0].length });
      openFence = null;
    }
  }

  function isInsideCodeBlock(offset: number): boolean {
    for (const range of codeBlockRanges) {
      if (offset >= range.start && offset <= range.end) return true;
    }
    return false;
  }

  let match: RegExpExecArray | null;
  const regex = new RegExp(COMMENT_PATTERN);

  while ((match = regex.exec(rawMarkdown)) !== null) {
    // Skip markers inside fenced code blocks (e.g. documentation examples)
    if (isInsideCodeBlock(match.index)) continue;

    let parsed = false;
    try {
      const data = JSON.parse(match[1]) as MdComment;
      if (data.id && data.anchor) {
        comments.push(data);
        parsed = true;
      }
    } catch {
      // Malformed JSON — still strip the marker
    }
    strippedRegions.push({
      rawStart: match.index,
      rawEnd: match.index + match[0].length,
      parsed,
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

  // Compute each comment's cleanOffset — the position in clean markdown
  // where the marker was. Since markers are placed BEFORE the anchor text,
  // this is the start of the anchor text in the clean content.
  let cumShift = 0;
  let commentIdx = 0;
  for (let i = 0; i < strippedRegions.length; i++) {
    const region = strippedRegions[i];
    const cleanPos = region.rawStart - cumShift;
    if (region.parsed && comments[commentIdx]) {
      comments[commentIdx].cleanOffset = cleanPos;
      commentIdx++;
    }
    cumShift += region.rawEnd - region.rawStart;
  }

  // Fuzzy re-matching: for comments whose anchor is no longer found at their
  // cleanOffset, use contextBefore/contextAfter to locate the new position.
  for (const comment of comments) {
    if (comment.cleanOffset === undefined) continue;
    // Check if anchor is found at its expected position
    const atOffset = cleanMarkdown.slice(
      comment.cleanOffset,
      comment.cleanOffset + comment.anchor.length,
    );
    if (atOffset === comment.anchor) continue; // exact match — no need to re-match
    // Also check if anchor exists anywhere
    if (cleanMarkdown.includes(comment.anchor)) continue;
    // Anchor is missing — try fuzzy re-match using context
    if (!comment.contextBefore && !comment.contextAfter) continue;
    const newOffset = fuzzyReMatch(cleanMarkdown, comment);
    if (newOffset !== null) {
      comment.cleanOffset = newOffset;
    }
  }

  // Offset mapping: clean position → raw position
  function cleanToRawOffset(cleanOffset: number): number {
    let shift = 0;
    for (const region of strippedRegions) {
      const regionCleanStart = region.rawStart - shift;
      if (cleanOffset < regionCleanStart) {
        return cleanOffset + shift;
      }
      shift += region.rawEnd - region.rawStart;
    }
    return cleanOffset + shift;
  }

  return { cleanMarkdown, comments, cleanToRawOffset };
}

/**
 * Fuzzy re-match: use contextBefore and contextAfter to find where a comment's
 * anchor region now sits in the clean markdown, even if the anchor text has been rewritten.
 * Returns the new cleanOffset or null if not found.
 */
function fuzzyReMatch(cleanMarkdown: string, comment: MdComment): number | null {
  const { contextBefore, contextAfter } = comment;

  // Try matching with both context strings
  if (contextBefore && contextAfter) {
    const beforeIdx = cleanMarkdown.indexOf(contextBefore);
    if (beforeIdx !== -1) {
      const anchorStart = beforeIdx + contextBefore.length;
      const afterIdx = cleanMarkdown.indexOf(contextAfter, anchorStart);
      if (afterIdx !== -1) {
        // The region between contextBefore and contextAfter is the new anchor area
        const gap = afterIdx - anchorStart;
        if (gap > 0 && gap < 500) return anchorStart;
      }
    }
  }

  // Fallback: try contextBefore only
  if (contextBefore && contextBefore.length >= 10) {
    const beforeIdx = cleanMarkdown.indexOf(contextBefore);
    if (beforeIdx !== -1) {
      return beforeIdx + contextBefore.length;
    }
  }

  // Fallback: try contextAfter only
  if (contextAfter && contextAfter.length >= 10) {
    const afterIdx = cleanMarkdown.indexOf(contextAfter);
    if (afterIdx !== -1 && afterIdx > 0) {
      // Estimate: anchor was just before contextAfter, use original anchor length as hint
      const estimatedStart = Math.max(0, afterIdx - comment.anchor.length);
      return estimatedStart;
    }
  }

  return null;
}

export function serializeComment(comment: MdComment): string {
  // Strip cleanOffset — it's computed at parse time, not persisted
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { cleanOffset, ...data } = comment;
  // Escape --> in the JSON to prevent it from closing the HTML comment
  // prematurely. \u003e is the Unicode escape for >, which JSON.parse
  // decodes back to > automatically — no manual unescaping needed.
  const json = JSON.stringify(data).replace(/-->/g, '--\\u003e');
  return `<!-- @comment${json} -->`;
}

export function insertComment(
  rawMarkdown: string,
  anchor: string,
  commentText: string,
  author: string = 'User',
  contextBefore?: string,
  contextAfter?: string,
  hintOffset?: number,
): string {
  const comment: MdComment = {
    id: crypto.randomUUID(),
    anchor,
    text: commentText,
    author,
    timestamp: new Date().toISOString(),
    ...(contextBefore ? { contextBefore } : {}),
    ...(contextAfter ? { contextAfter } : {}),
  };

  // Find the anchor text in the CLEAN markdown (no comment markers),
  // then map the position back to the raw markdown.
  const { cleanMarkdown, cleanToRawOffset } = parseComments(rawMarkdown);

  let insertionCleanOffset: number | null = null;

  // When hintOffset is provided (from DOM selection), search in plain-text space
  // first. This is the same coordinate space as hintOffset and sees through
  // markdown formatting, so it correctly handles duplicates where one occurrence
  // is formatted (e.g. **foo**) and another is not (foo).
  if (hintOffset !== undefined) {
    const { plain, toCleanOffset } = stripInlineFormatting(cleanMarkdown);

    // Direct search for anchor in plain text
    const plainOccs: number[] = [];
    let pSearch = 0;
    while (true) {
      const pIdx = plain.indexOf(anchor, pSearch);
      if (pIdx === -1) break;
      plainOccs.push(pIdx);
      pSearch = pIdx + 1;
    }

    // Also try segment-based search for cross-element selections (newlines/tabs)
    if (plainOccs.length === 0) {
      const segments = anchor
        .split(/[\n\t]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      if (segments.length > 0) {
        for (const r of findAllSegments(plain, segments)) {
          plainOccs.push(r.start);
        }
      }
    }

    if (plainOccs.length > 0) {
      const best = plainOccs.reduce((b, idx) =>
        Math.abs(idx - hintOffset) < Math.abs(b - hintOffset) ? idx : b,
      );
      insertionCleanOffset = toCleanOffset(best);
    }
  }

  // Fallback when no hintOffset: use exact match in clean markdown (first occurrence)
  if (insertionCleanOffset === null) {
    const cleanIdx = cleanMarkdown.indexOf(anchor);
    if (cleanIdx !== -1) {
      insertionCleanOffset = cleanIdx;
    }
  }

  // Fallback: cross-element selections with newlines/tabs — segment-based search
  if (insertionCleanOffset === null) {
    const segments = anchor
      .split(/[\n\t]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (segments.length > 0) {
      const segResult = findSegments(cleanMarkdown, segments);
      if (segResult !== null) {
        insertionCleanOffset = segResult.start;
      }

      // If that fails, try in formatting-stripped text and map back
      if (insertionCleanOffset === null) {
        const { plain, toCleanOffset } = stripInlineFormatting(cleanMarkdown);
        const plainIdx = plain.indexOf(segments[0]);
        if (plainIdx !== -1) {
          insertionCleanOffset = toCleanOffset(plainIdx);
        }
      }
    }
  }

  if (insertionCleanOffset === null) return rawMarkdown;

  // Insert marker BEFORE the anchor text in the raw markdown
  const rawInsertionPoint = cleanToRawOffset(insertionCleanOffset);

  const marker = serializeComment(comment);
  return rawMarkdown.slice(0, rawInsertionPoint) + marker + rawMarkdown.slice(rawInsertionPoint);
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

export function resolveComment(rawMarkdown: string, commentId: string): string {
  const regex = new RegExp(COMMENT_PATTERN);
  return rawMarkdown.replace(regex, (match, json) => {
    try {
      const data = JSON.parse(json) as MdComment;
      if (data.id === commentId) {
        data.resolved = true;
        data.status = 'resolved';
        return serializeComment(data);
      }
    } catch {
      // Keep malformed comments
    }
    return match;
  });
}

export function unresolveComment(rawMarkdown: string, commentId: string): string {
  const regex = new RegExp(COMMENT_PATTERN);
  return rawMarkdown.replace(regex, (match, json) => {
    try {
      const data = JSON.parse(json) as MdComment;
      if (data.id === commentId) {
        data.resolved = false;
        data.status = 'open';
        return serializeComment(data);
      }
    } catch {
      // Keep malformed comments
    }
    return match;
  });
}

export function editComment(rawMarkdown: string, commentId: string, newText: string): string {
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
  newAnchor: string,
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


export function addReply(
  rawMarkdown: string,
  commentId: string,
  text: string,
  author: string = 'User',
): string {
  const reply: CommentReply = {
    id: crypto.randomUUID(),
    text,
    author,
    timestamp: new Date().toISOString(),
  };
  const regex = new RegExp(COMMENT_PATTERN);
  return rawMarkdown.replace(regex, (match, json) => {
    try {
      const data = JSON.parse(json) as MdComment;
      if (data.id === commentId) {
        if (!data.replies) data.replies = [];
        data.replies.push(reply);
        return serializeComment(data);
      }
    } catch {
      // Keep malformed comments
    }
    return match;
  });
}

export function removeAllComments(rawMarkdown: string): string {
  const regex = new RegExp(COMMENT_PATTERN);
  return rawMarkdown.replace(regex, () => '');
}

export function resolveAllComments(rawMarkdown: string): string {
  const regex = new RegExp(COMMENT_PATTERN);
  return rawMarkdown.replace(regex, (match, json) => {
    try {
      const data = JSON.parse(json) as MdComment;
      if (!data.resolved) {
        data.resolved = true;
        data.status = 'resolved';
        return serializeComment(data);
      }
    } catch {
      // Keep malformed comments
    }
    return match;
  });
}

export function removeResolvedComments(rawMarkdown: string): string {
  const regex = new RegExp(COMMENT_PATTERN);
  return rawMarkdown.replace(regex, (match, json) => {
    try {
      const data = JSON.parse(json) as MdComment;
      if (data.resolved) return '';
    } catch {
      // Keep malformed comments
    }
    return match;
  });
}

/** Search for ordered segments in text starting from a given offset, return the start and end offsets or null. */
function findSegments(text: string, segments: string[], startFrom = 0): { start: number; end: number } | null {
  let searchFrom = startFrom;
  let firstStart = -1;
  let lastEnd = -1;
  for (let i = 0; i < segments.length; i++) {
    const idx = text.indexOf(segments[i], searchFrom);
    if (idx === -1) return null;
    if (i === 0) firstStart = idx;
    lastEnd = idx + segments[i].length;
    searchFrom = lastEnd;
  }
  return firstStart === -1 ? null : { start: firstStart, end: lastEnd };
}

/** Find ALL occurrences of ordered segments in text. */
function findAllSegments(text: string, segments: string[]): { start: number; end: number }[] {
  const results: { start: number; end: number }[] = [];
  let startFrom = 0;
  while (true) {
    const result = findSegments(text, segments, startFrom);
    if (result === null) break;
    results.push(result);
    startFrom = result.start + 1;
  }
  return results;
}

/**
 * Strip inline markdown formatting (**, *, __, `, ~~) and block-level markers
 * (# headings, - lists, 1. lists) to produce plain text that matches rendered output.
 * Returns a position map to convert plain-text offsets back to clean-markdown offsets.
 */
export function stripInlineFormatting(md: string): {
  plain: string;
  toCleanOffset: (off: number) => number;
  toPlainOffset: (cleanOff: number) => number;
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
    toPlainOffset: (cleanOff: number) => {
      // Binary search: find the plain index whose map entry is closest to cleanOff
      let lo = 0;
      let hi = map.length - 1;
      if (hi < 0) return 0;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (map[mid] < cleanOff) lo = mid + 1;
        else hi = mid;
      }
      // lo is now the first plain index where map[lo] >= cleanOff
      return lo;
    },
  };
}

/**
 * Check if ordered parts appear contiguously in text, with only whitespace between them.
 * Used for flexible anchor detection when exact string match fails.
 */
function partsAppearContiguously(text: string, parts: string[]): boolean {
  let searchFrom = 0;
  while (searchFrom < text.length) {
    const firstIdx = text.indexOf(parts[0], searchFrom);
    if (firstIdx === -1) return false;
    let pos = firstIdx + parts[0].length;
    let matched = true;
    for (let i = 1; i < parts.length; i++) {
      while (pos < text.length && /\s/.test(text[pos])) pos++;
      if (text.startsWith(parts[i], pos)) {
        pos += parts[i].length;
      } else {
        matched = false;
        break;
      }
    }
    if (matched) return true;
    searchFrom = firstIdx + 1;
  }
  return false;
}

/**
 * Detect comments whose anchor text can no longer be found in the clean markdown.
 * Returns a set of comment IDs with missing anchors.
 * Parts must appear contiguously (with only whitespace between them) to count as found.
 */
export function detectMissingAnchors(
  cleanMarkdown: string,
  comments: MdComment[],
): Set<string> {
  const missing = new Set<string>();
  if (!cleanMarkdown) return missing;
  for (const c of comments) {
    if (getEffectiveStatus(c) === 'resolved') continue;
    if (!cleanMarkdown.includes(c.anchor)) {
      const parts = c.anchor.split(/\s+/).filter(Boolean);
      if (parts.length === 0) continue;
      if (!partsAppearContiguously(cleanMarkdown, parts)) {
        missing.add(c.id);
      }
    }
  }
  return missing;
}
