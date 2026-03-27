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
    let rawEnd = match.index + match[0].length;
    // If the marker sits alone on its own line (e.g. before a code fence),
    // also consume the trailing newline so stripping restores the original content.
    const isStartOfLine = match.index === 0 || rawMarkdown[match.index - 1] === '\n';
    if (isStartOfLine && rawMarkdown[rawEnd] === '\n') {
      rawEnd += 1;
    }
    strippedRegions.push({
      rawStart: match.index,
      rawEnd,
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

/**
 * Among multiple occurrences of an anchor in plain text, pick the one that
 * best matches the user's original selection using whitespace-normalized
 * context matching, with hintOffset proximity as tiebreaker.
 *
 * Context strings come from container.textContent (DOM space) while the
 * plain text comes from stripInlineFormatting (markdown space). These can
 * differ in whitespace around block boundaries (\n\n vs \n) and unhandled
 * constructs (links, images). Whitespace normalization makes the comparison
 * robust against this drift.
 */
export function pickBestOccurrence(
  plain: string,
  occurrences: number[],
  anchor: string,
  hintOffset: number,
  contextBefore?: string,
  contextAfter?: string,
): number {
  if (occurrences.length <= 1) return occurrences[0];

  // When no context is available, fall back to nearest hintOffset
  if (!contextBefore && !contextAfter) {
    return occurrences.reduce((b, idx) =>
      Math.abs(idx - hintOffset) < Math.abs(b - hintOffset) ? idx : b,
    );
  }

  // Normalize whitespace: collapse runs into single spaces to handle
  // blank-line drift (\n\n in markdown vs \n in rendered HTML)
  const normCtxBefore = contextBefore?.replace(/\s+/g, ' ') ?? '';
  const normCtxAfter = contextAfter?.replace(/\s+/g, ' ') ?? '';

  let bestOcc = occurrences[0];
  let bestScore = -1;
  let bestDist = Infinity;

  for (const occ of occurrences) {
    let score = 0;

    // Score by matching suffix of contextBefore (working backwards from anchor start)
    if (normCtxBefore) {
      const windowSize = normCtxBefore.length * 2; // extra room for pre-normalization whitespace
      const rawBefore = plain.slice(Math.max(0, occ - windowSize), occ);
      const normBefore = rawBefore.replace(/\s+/g, ' ');
      for (let j = 1; j <= Math.min(normBefore.length, normCtxBefore.length); j++) {
        if (normBefore[normBefore.length - j] === normCtxBefore[normCtxBefore.length - j]) {
          score++;
        } else {
          break;
        }
      }
    }

    // Score by matching prefix of contextAfter (working forwards from anchor end)
    if (normCtxAfter) {
      const afterStart = occ + anchor.length;
      const windowSize = normCtxAfter.length * 2;
      const rawAfter = plain.slice(afterStart, afterStart + windowSize);
      const normAfter = rawAfter.replace(/\s+/g, ' ');
      for (let j = 0; j < Math.min(normAfter.length, normCtxAfter.length); j++) {
        if (normAfter[j] === normCtxAfter[j]) {
          score++;
        } else {
          break;
        }
      }
    }

    const dist = Math.abs(occ - hintOffset);
    if (score > bestScore || (score === bestScore && dist < bestDist)) {
      bestScore = score;
      bestOcc = occ;
      bestDist = dist;
    }
  }

  return bestOcc;
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
      const best = plainOccs.length === 1
        ? plainOccs[0]
        : pickBestOccurrence(plain, plainOccs, anchor, hintOffset, contextBefore, contextAfter);
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

  // If the insertion point falls inside a fenced code block, move it before the block.
  // HTML comment markers are literal text inside code blocks, so the marker must go outside.
  let movedBeforeFence = false;
  {
    const fenceRegex = /^(`{3,}|~{3,}).*$/gm;
    let fm: RegExpExecArray | null;
    let openF: { marker: string; start: number } | null = null;
    while ((fm = fenceRegex.exec(cleanMarkdown)) !== null) {
      const marker = fm[1];
      if (!openF) {
        openF = { marker: marker[0].repeat(marker.length), start: fm.index };
      } else if (marker[0] === openF.marker[0] && marker.length >= openF.marker.length) {
        if (insertionCleanOffset >= openF.start && insertionCleanOffset <= fm.index + fm[0].length) {
          insertionCleanOffset = openF.start;
          movedBeforeFence = true;
        }
        openF = null;
      }
    }
  }

  // Insert marker BEFORE the anchor text in the raw markdown.
  // When moved before a code fence, place the marker on its own line so the
  // opening fence stays at column 0 (otherwise other renderers won't parse it).
  const rawInsertionPoint = cleanToRawOffset(insertionCleanOffset);

  const marker = serializeComment(comment);
  if (movedBeforeFence) {
    return rawMarkdown.slice(0, rawInsertionPoint) + marker + '\n' + rawMarkdown.slice(rawInsertionPoint);
  }
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

  // Track pending link URL skip: when we see [text](url), we skip [,
  // process text normally, then skip ](url) when we reach the ].
  let pendingLinkSkipAt = -1;
  let pendingLinkSkipTo = -1;

  while (i < len) {
    // Handle pending link URL skip: we reached ], jump past ](url)
    if (pendingLinkSkipAt !== -1 && i >= pendingLinkSkipAt) {
      i = pendingLinkSkipTo;
      pendingLinkSkipAt = -1;
      pendingLinkSkipTo = -1;
      continue;
    }

    // Fenced code blocks: skip fence lines, keep content as-is
    if (atLineStart(i) && (md[i] === '`' || md[i] === '~')) {
      const fenceChar = md[i];
      let fenceEnd = i;
      while (fenceEnd < len && md[fenceEnd] === fenceChar) fenceEnd++;
      const fenceLen = fenceEnd - i;
      if (fenceLen >= 3) {
        // Skip the opening fence line (markers + info string + newline)
        while (fenceEnd < len && md[fenceEnd] !== '\n') fenceEnd++;
        if (fenceEnd < len) fenceEnd++;
        i = fenceEnd;
        // Process content until closing fence — add as-is (no formatting stripping)
        while (i < len) {
          if (atLineStart(i) && md[i] === fenceChar) {
            let closeEnd = i;
            while (closeEnd < len && md[closeEnd] === fenceChar) closeEnd++;
            if (closeEnd - i >= fenceLen) {
              // Skip closing fence line
              while (closeEnd < len && md[closeEnd] !== '\n') closeEnd++;
              if (closeEnd < len) closeEnd++;
              i = closeEnd;
              break;
            }
          }
          map.push(i);
          plain += md[i];
          i++;
        }
        continue;
      }
    }

    // Markdown images: ![alt](url) → skip entirely (no text content in rendered DOM)
    if (md[i] === '!' && i + 1 < len && md[i + 1] === '[') {
      const cb = md.indexOf(']', i + 2);
      if (cb !== -1 && cb + 1 < len && md[cb + 1] === '(') {
        const cp = md.indexOf(')', cb + 2);
        if (cp !== -1) {
          i = cp + 1;
          continue;
        }
      }
    }

    // Markdown links: [text](url) → skip [ and ](url), keep text
    if (md[i] === '[' && pendingLinkSkipAt === -1) {
      const cb = md.indexOf(']', i + 1);
      if (cb !== -1 && cb + 1 < len && md[cb + 1] === '(') {
        const cp = md.indexOf(')', cb + 2);
        if (cp !== -1) {
          pendingLinkSkipAt = cb;
          pendingLinkSkipTo = cp + 1;
          i++; // skip '['
          continue;
        }
      }
    }

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
      // Skip whitespace and markdown block-level markers (list bullets, blockquote)
      // so cross-line selections spanning list items or blockquotes still match
      while (pos < text.length && /[\s\-*+>]/.test(text[pos])) pos++;
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
 * Extract visible text labels from mermaid code blocks.
 * Mermaid nodes use shapes like A[text], A(text), A{text}, A([text]), A((text)).
 * Edge labels use |text| or -->|text|. We concatenate all labels so anchor text
 * from rendered SVG can be matched against them.
 *
 * Note: labels are joined with spaces, so `partsAppearContiguously` can match
 * anchors that span adjacent node labels (e.g. "Add Admin" across two nodes).
 * This is intentional — rendered SVG text flows continuously.
 */
function extractMermaidText(cleanMarkdown: string): string {
  if (!/^```mermaid\s*$/m.test(cleanMarkdown)) return '';
  const mermaidRegex = /^```mermaid\s*\n([\s\S]*?)^```\s*$/gm;
  const labels: string[] = [];
  let match;
  while ((match = mermaidRegex.exec(cleanMarkdown)) !== null) {
    const source = match[1];
    // Node labels: text inside [...], (...), {...}
    // eslint-disable-next-line no-useless-escape
    const nodeRegex = /[\[({]([^\])}]+)[\])}]/g;
    let nodeMatch;
    while ((nodeMatch = nodeRegex.exec(source)) !== null) {
      labels.push(nodeMatch[1].trim());
    }
    // Edge labels: |text|
    const edgeRegex = /\|([^|]+)\|/g;
    let edgeMatch;
    while ((edgeMatch = edgeRegex.exec(source)) !== null) {
      labels.push(edgeMatch[1].trim());
    }
  }
  return labels.join(' ');
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
  // Compare against plain text (formatting stripped) since anchors come from
  // DOM textContent which doesn't include markdown formatting markers like
  // **, _, `, ~~, etc. Without this, anchors spanning formatted text would
  // always be flagged as "changed".
  const { plain } = stripInlineFormatting(cleanMarkdown);
  // Also extract rendered text from mermaid blocks — anchors from mermaid SVG
  // won't match the raw source syntax, but will match the extracted labels.
  const mermaidText = extractMermaidText(cleanMarkdown);
  for (const c of comments) {
    if (getEffectiveStatus(c) === 'resolved') continue;
    if (!plain.includes(c.anchor)) {
      const parts = c.anchor.split(/\s+/).filter(Boolean);
      if (parts.length === 0) continue;
      if (!partsAppearContiguously(plain, parts)) {
        // Check mermaid rendered text as fallback
        if (mermaidText && (mermaidText.includes(c.anchor) || partsAppearContiguously(mermaidText, parts))) {
          continue;
        }
        missing.add(c.id);
      }
    }
  }
  return missing;
}
