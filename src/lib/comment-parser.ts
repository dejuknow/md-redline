import { getEffectiveStatus, type MdComment, type ParseResult, type CommentReply } from '../types';

// Match <!-- @comment{...JSON...} --> — use dotall flag so JSON with
// newlines in string values is matched correctly.
const COMMENT_PATTERN = /<!-- @comment(\{.*?\}) -->/gs;

/**
 * Factory for a fresh comment-marker regex. Returns a NEW RegExp every call
 * so concurrent users (multiple components, recursive parses, code paths
 * that interleave) cannot clobber each other's `lastIndex`. Always prefer
 * this over keeping a module-scoped instance — sharing a stateful /g regex
 * is a footgun, even when each caller dutifully resets `lastIndex`.
 */
export function createCommentMarkerRegex(): RegExp {
  return /<!-- @comment\{.*?\} -->/gs;
}

interface CodeBlockRange {
  start: number;
  end: number;
}

interface CommentMarkerRegion {
  rawStart: number;
  markerEnd: number;
  stripEnd: number;
  parsedComment: MdComment | null;
}

type CommentTransform =
  | { type: 'keep' }
  | { type: 'remove' }
  | { type: 'replace'; comment: MdComment };

function getCodeBlockRanges(rawMarkdown: string): CodeBlockRange[] {
  const codeBlockRanges: CodeBlockRange[] = [];
  const fenceRegex = /^ {0,3}(`{3,}|~{3,}).*$/gm;
  let fenceMatch: RegExpExecArray | null;
  let openFence: { marker: string; start: number } | null = null;

  while ((fenceMatch = fenceRegex.exec(rawMarkdown)) !== null) {
    const marker = fenceMatch[1];
    if (!openFence) {
      openFence = { marker: marker[0].repeat(marker.length), start: fenceMatch.index };
    } else if (marker[0] === openFence.marker[0] && marker.length >= openFence.marker.length) {
      codeBlockRanges.push({
        start: openFence.start,
        end: fenceMatch.index + fenceMatch[0].length,
      });
      openFence = null;
    }
  }

  return codeBlockRanges;
}

function isInsideCodeBlock(offset: number, codeBlockRanges: CodeBlockRange[]): boolean {
  for (const range of codeBlockRanges) {
    if (offset >= range.start && offset < range.end) return true;
  }
  return false;
}

// Inline code spans (`...`, ``...``, etc.) — opener and closer must be runs of
// equal length, per CommonMark. A marker-shaped pattern inside a span whose
// JSON fails to parse (e.g. `<!-- @comment{...} -->`) is treated as a
// documentation placeholder and left as literal text. Real markers with
// valid JSON still parse — insertComment places them inside the span when
// the user anchors on code text.
function getInlineCodeRanges(
  rawMarkdown: string,
  fencedRanges: CodeBlockRange[],
): CodeBlockRange[] {
  const tickRegex = /`+/g;
  const runs: { start: number; len: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = tickRegex.exec(rawMarkdown)) !== null) {
    if (isInsideCodeBlock(m.index, fencedRanges)) continue;
    runs.push({ start: m.index, len: m[0].length });
  }

  const ranges: CodeBlockRange[] = [];
  const consumed = new Set<number>();
  for (let i = 0; i < runs.length; i++) {
    if (consumed.has(i)) continue;
    for (let j = i + 1; j < runs.length; j++) {
      if (consumed.has(j)) continue;
      if (runs[j].len === runs[i].len) {
        ranges.push({ start: runs[i].start, end: runs[j].start + runs[j].len });
        consumed.add(i);
        consumed.add(j);
        break;
      }
    }
  }
  return ranges;
}

function getStandaloneStripEnd(
  rawMarkdown: string,
  markerStart: number,
  markerEnd: number,
): number {
  const isStartOfLine = markerStart === 0 || rawMarkdown[markerStart - 1] === '\n';
  return isStartOfLine && rawMarkdown[markerEnd] === '\n' ? markerEnd + 1 : markerEnd;
}

function collectCommentRegions(rawMarkdown: string): CommentMarkerRegion[] {
  const fencedRanges = getCodeBlockRanges(rawMarkdown);
  const inlineRanges = getInlineCodeRanges(rawMarkdown, fencedRanges);
  const regions: CommentMarkerRegion[] = [];
  const regex = new RegExp(COMMENT_PATTERN);
  let match: RegExpExecArray | null;

  while ((match = regex.exec(rawMarkdown)) !== null) {
    if (isInsideCodeBlock(match.index, fencedRanges)) continue;
    const insideInlineCode = isInsideCodeBlock(match.index, inlineRanges);

    let parsedComment: MdComment | null = null;
    try {
      const data = JSON.parse(match[1]) as MdComment;
      if (
        typeof data.id === 'string' &&
        typeof data.anchor === 'string' &&
        typeof data.text === 'string' &&
        typeof data.author === 'string' &&
        (!data.replies || Array.isArray(data.replies))
      ) {
        parsedComment = data;
      }
    } catch (err) {
      // Inside inline code, a literal `{...}` placeholder is documentation
      // about the format (e.g. README snippets), not a real marker someone
      // hand-edited. Leave it as literal text and don't warn. Corrupted real
      // markers inside inline code (any other malformed JSON) still fall
      // through so parser-based cleanup can strip them.
      if (insideInlineCode && /^\{\s*\.+\s*\}$/.test(match[1].trim())) continue;
      // Malformed markers outside code blocks are still considered removable,
      // but surface the parse failure so users notice when comment data is
      // being silently dropped (e.g. after a hand-edit corrupted the JSON).
      console.warn(
        '[comment-parser] failed to parse comment marker JSON; marker will be treated as anonymous',
        err,
      );
    }

    const markerEnd = match.index + match[0].length;
    regions.push({
      rawStart: match.index,
      markerEnd,
      stripEnd: getStandaloneStripEnd(rawMarkdown, match.index, markerEnd),
      parsedComment,
    });
  }

  return regions;
}

export function transformCommentMarkers(
  rawMarkdown: string,
  transform: (comment: MdComment | null) => CommentTransform,
): string {
  const regions = collectCommentRegions(rawMarkdown);
  if (regions.length === 0) return rawMarkdown;

  let nextRaw = '';
  let lastEnd = 0;

  for (const region of regions) {
    nextRaw += rawMarkdown.slice(lastEnd, region.rawStart);
    const action = transform(region.parsedComment);

    if (action.type === 'keep') {
      nextRaw += rawMarkdown.slice(region.rawStart, region.markerEnd);
      lastEnd = region.markerEnd;
      continue;
    }

    if (action.type === 'replace') {
      nextRaw += serializeComment(action.comment);
      lastEnd = region.markerEnd;
      continue;
    }

    lastEnd = region.stripEnd;
  }

  nextRaw += rawMarkdown.slice(lastEnd);
  return nextRaw;
}

export function parseComments(rawMarkdown: string): ParseResult {
  const comments: MdComment[] = [];
  const strippedRegions: { rawStart: number; rawEnd: number; parsed: boolean }[] = [];

  for (const region of collectCommentRegions(rawMarkdown)) {
    if (region.parsedComment) {
      comments.push(region.parsedComment);
    }
    strippedRegions.push({
      rawStart: region.rawStart,
      rawEnd: region.stripEnd,
      parsed: region.parsedComment !== null,
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

  // Fallback: try contextBefore only (only if it appears exactly once)
  if (contextBefore && contextBefore.length >= 10) {
    const firstIdx = cleanMarkdown.indexOf(contextBefore);
    if (firstIdx !== -1 && cleanMarkdown.indexOf(contextBefore, firstIdx + 1) === -1) {
      return firstIdx + contextBefore.length;
    }
  }

  // Fallback: try contextAfter only (only if it appears exactly once)
  // The anchor text should end right where contextAfter begins, so
  // subtract the anchor length to find where the anchor starts.
  if (contextAfter && contextAfter.length >= 10) {
    const firstIdx = cleanMarkdown.indexOf(contextAfter);
    if (
      firstIdx !== -1 &&
      firstIdx > 0 &&
      cleanMarkdown.indexOf(contextAfter, firstIdx + 1) === -1
    ) {
      return Math.max(0, firstIdx - comment.anchor.length);
    }
  }

  return null;
}

export function serializeComment(comment: MdComment): string {
  // Strip cleanOffset — it's computed at parse time, not persisted
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { cleanOffset, ...data } = comment;
  // Escape --> and --!> in the JSON to prevent them from closing the HTML
  // comment prematurely. The HTML spec treats both as comment-close sequences.
  // \u003e is the Unicode escape for >, which JSON.parse decodes back to >
  // automatically — no manual unescaping needed.
  const json = JSON.stringify(data).replace(/-->/g, '--\\u003e').replace(/--!>/g, '--!\\u003e');
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
  commentId: string = crypto.randomUUID(),
): string {
  const comment: MdComment = {
    id: commentId,
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

    // Direct search for anchor in plain text (flexible whitespace matching
    // so browser-collapsed newlines in sel.toString() match source newlines)
    const plainOccs: number[] = [];
    let pSearch = 0;
    while (true) {
      const fm = flexibleIndexOf(plain, anchor, pSearch);
      if (!fm) break;
      plainOccs.push(fm.start);
      pSearch = fm.start + 1;
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
      const best =
        plainOccs.length === 1
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
        const fm = flexibleIndexOf(plain, segments[0]);
        if (fm) {
          insertionCleanOffset = toCleanOffset(fm.start);
        }
      }
    }
  }

  if (insertionCleanOffset === null) return rawMarkdown;

  // If the insertion point falls inside a fenced code block, move it before the block.
  // HTML comment markers are literal text inside code blocks, so the marker must go outside.
  let movedBeforeFence = false;
  {
    const fenceRegex = /^ {0,3}(`{3,}|~{3,}).*$/gm;
    let fm: RegExpExecArray | null;
    let openF: { marker: string; start: number } | null = null;
    while ((fm = fenceRegex.exec(cleanMarkdown)) !== null) {
      const marker = fm[1];
      if (!openF) {
        openF = { marker: marker[0].repeat(marker.length), start: fm.index };
      } else if (marker[0] === openF.marker[0] && marker.length >= openF.marker.length) {
        if (
          insertionCleanOffset >= openF.start &&
          insertionCleanOffset <= fm.index + fm[0].length
        ) {
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
    return (
      rawMarkdown.slice(0, rawInsertionPoint) + marker + '\n' + rawMarkdown.slice(rawInsertionPoint)
    );
  }
  return rawMarkdown.slice(0, rawInsertionPoint) + marker + rawMarkdown.slice(rawInsertionPoint);
}

export function removeComment(rawMarkdown: string, commentId: string): string {
  return transformCommentMarkers(rawMarkdown, (comment) => {
    if (comment?.id === commentId) return { type: 'remove' };
    return { type: 'keep' };
  });
}

export function resolveComment(rawMarkdown: string, commentId: string): string {
  return transformCommentMarkers(rawMarkdown, (comment) => {
    if (comment?.id === commentId) {
      return {
        type: 'replace',
        comment: {
          ...comment,
          resolved: true,
          status: 'resolved',
        },
      };
    }
    return { type: 'keep' };
  });
}

export function unresolveComment(rawMarkdown: string, commentId: string): string {
  return transformCommentMarkers(rawMarkdown, (comment) => {
    if (comment?.id === commentId) {
      return {
        type: 'replace',
        comment: {
          ...comment,
          resolved: false,
          status: 'open',
        },
      };
    }
    return { type: 'keep' };
  });
}

export function editComment(rawMarkdown: string, commentId: string, newText: string): string {
  return transformCommentMarkers(rawMarkdown, (comment) => {
    if (comment?.id === commentId) {
      return {
        type: 'replace',
        comment: {
          ...comment,
          text: newText,
        },
      };
    }
    return { type: 'keep' };
  });
}

function updateReplies(
  rawMarkdown: string,
  commentId: string,
  updater: (replies: CommentReply[]) => CommentReply[] | null,
): string {
  return transformCommentMarkers(rawMarkdown, (comment) => {
    if (comment?.id !== commentId) return { type: 'keep' };

    const nextReplies = updater(comment.replies ?? []);
    if (nextReplies === null) return { type: 'keep' };

    if (nextReplies.length === 0) {
      const nextComment = { ...comment };
      delete nextComment.replies;
      return {
        type: 'replace',
        comment: nextComment,
      };
    }

    return {
      type: 'replace',
      comment: { ...comment, replies: nextReplies },
    };
  });
}

export function updateCommentAnchor(
  rawMarkdown: string,
  commentId: string,
  newAnchor: string,
): string {
  // Recompute contextBefore/contextAfter from the clean markdown so they stay
  // consistent with the new anchor. Without this, later fuzzy re-matching can
  // attach the comment to the wrong text after document edits.
  // Use the comment's cleanOffset to find the right occurrence when the anchor
  // text appears multiple times.
  const { cleanMarkdown, comments } = parseComments(rawMarkdown);
  const target = comments.find((c) => c.id === commentId);
  let newContextBefore: string | undefined;
  let newContextAfter: string | undefined;
  if (target?.cleanOffset !== undefined) {
    // The new anchor starts at the comment's existing position in clean markdown
    const anchorIdx = target.cleanOffset;
    const CONTEXT_LEN = 30;
    const beforeStart = Math.max(0, anchorIdx - CONTEXT_LEN);
    newContextBefore = cleanMarkdown.slice(beforeStart, anchorIdx);
    const afterEnd = Math.min(cleanMarkdown.length, anchorIdx + newAnchor.length + CONTEXT_LEN);
    newContextAfter = cleanMarkdown.slice(anchorIdx + newAnchor.length, afterEnd);
  }

  return transformCommentMarkers(rawMarkdown, (comment) => {
    if (comment?.id === commentId) {
      return {
        type: 'replace',
        comment: {
          ...comment,
          anchor: newAnchor,
          ...(newContextBefore !== undefined ? { contextBefore: newContextBefore } : {}),
          ...(newContextAfter !== undefined ? { contextAfter: newContextAfter } : {}),
        },
      };
    }
    return { type: 'keep' };
  });
}

/**
 * Move a comment marker to a new anchor location in the raw markdown.
 *
 * Preserves id, author, timestamp, text, replies, and status (including the
 * legacy `resolved` boolean). Recomputes contextBefore / contextAfter from
 * the new surroundings.
 *
 * Returns the raw markdown unchanged when:
 *   - the comment id is not found
 *   - `hintOffset` is undefined and `newAnchor` is not present in the clean
 *     markdown (callers should validate first)
 *   - `insertComment` cannot place the marker
 *
 * @param hintOffset optional plain-text offset to disambiguate duplicate
 *   occurrences of the anchor. When provided, the anchor-presence guard is
 *   skipped and `insertComment` resolves placement using the offset.
 */
export function moveComment(
  rawMarkdown: string,
  commentId: string,
  newAnchor: string,
  hintOffset?: number,
): string {
  const { cleanMarkdown, comments } = parseComments(rawMarkdown);
  const existing = comments.find((c) => c.id === commentId);
  if (!existing) return rawMarkdown;

  if (hintOffset === undefined && !cleanMarkdown.includes(newAnchor)) {
    return rawMarkdown;
  }

  const withoutOld = removeComment(rawMarkdown, commentId);

  const reinserted = insertComment(
    withoutOld,
    newAnchor,
    existing.text,
    existing.author,
    undefined,
    undefined,
    hintOffset,
    commentId,
  );

  if (reinserted === withoutOld) return rawMarkdown;

  const patched = transformCommentMarkers(reinserted, (c) => {
    if (c?.id !== commentId) return { type: 'keep' };
    return {
      type: 'replace',
      comment: {
        ...c,
        timestamp: existing.timestamp,
        ...(existing.replies ? { replies: existing.replies } : {}),
        ...(existing.status !== undefined ? { status: existing.status } : {}),
        ...(existing.resolved !== undefined ? { resolved: existing.resolved } : {}),
      },
    };
  });

  return updateCommentAnchor(patched, commentId, newAnchor);
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

  return updateReplies(rawMarkdown, commentId, (replies) => [...replies, reply]);
}

export function editReply(
  rawMarkdown: string,
  commentId: string,
  replyId: string,
  newText: string,
): string {
  return updateReplies(rawMarkdown, commentId, (replies) => {
    const replyIndex = replies.findIndex((reply) => reply.id === replyId);
    if (replyIndex === -1) return null;

    return replies.map((reply) =>
      reply.id === replyId
        ? {
            ...reply,
            text: newText,
          }
        : reply,
    );
  });
}

export function removeReply(rawMarkdown: string, commentId: string, replyId: string): string {
  return updateReplies(rawMarkdown, commentId, (replies) => {
    const nextReplies = replies.filter((reply) => reply.id !== replyId);
    return nextReplies.length === replies.length ? null : nextReplies;
  });
}

/**
 * Diff two parsed comment lists and return the IDs of replies that exist in
 * `newComments` but not in `oldComments`. Handles replies on existing comments
 * AND replies on brand-new comments. Used to identify which reply timestamps
 * an external editor (typically an LLM agent) just added so we can override
 * them.
 */
export function findNewReplyIds(
  oldComments: MdComment[],
  newComments: MdComment[],
): Set<string> {
  const newReplyIds = new Set<string>();
  const oldById = new Map(oldComments.map((c) => [c.id, c]));
  for (const newC of newComments) {
    const oldC = oldById.get(newC.id);
    const oldReplyIds = new Set((oldC?.replies ?? []).map((r) => r.id));
    for (const reply of newC.replies ?? []) {
      if (!oldReplyIds.has(reply.id)) {
        newReplyIds.add(reply.id);
      }
    }
  }
  return newReplyIds;
}

/**
 * Rewrite the `timestamp` field on every reply whose ID appears in `forceIds`,
 * setting it to `fallbackIso`. Used to override agent-supplied timestamps with
 * the file's mtime, since LLM agents can't reliably know "now" and tend to
 * hallucinate plausible-but-wrong values. Returns the original string if no
 * matching replies were found, so callers can detect a no-op.
 */
export function backfillReplyTimestamps(
  rawMarkdown: string,
  forceIds: ReadonlySet<string>,
  fallbackIso: string,
): string {
  if (forceIds.size === 0) return rawMarkdown;
  let mutated = false;
  const next = transformCommentMarkers(rawMarkdown, (comment) => {
    if (!comment?.replies?.length) return { type: 'keep' };

    let changed = false;
    const nextReplies = comment.replies.map((reply) => {
      if (forceIds.has(reply.id)) {
        changed = true;
        return { ...reply, timestamp: fallbackIso };
      }
      return reply;
    });

    if (!changed) return { type: 'keep' };
    mutated = true;
    return { type: 'replace', comment: { ...comment, replies: nextReplies } };
  });
  return mutated ? next : rawMarkdown;
}

export function removeAllComments(rawMarkdown: string): string {
  return transformCommentMarkers(rawMarkdown, () => ({ type: 'remove' }));
}

export function resolveAllComments(rawMarkdown: string): string {
  return transformCommentMarkers(rawMarkdown, (comment) => {
    if (!comment || getEffectiveStatus(comment) === 'resolved') {
      return { type: 'keep' };
    }
    return {
      type: 'replace',
      comment: {
        ...comment,
        resolved: true,
        status: 'resolved',
      },
    };
  });
}

export function removeResolvedComments(rawMarkdown: string): string {
  return transformCommentMarkers(rawMarkdown, (comment) => {
    if (comment && getEffectiveStatus(comment) === 'resolved') {
      return { type: 'remove' };
    }
    return { type: 'keep' };
  });
}

/** Search for ordered segments in text starting from a given offset, return the start and end offsets or null. */
/**
 * Whitespace-flexible indexOf: find `needle` in `haystack` starting from `startFrom`,
 * allowing any single whitespace char in the needle to match any single whitespace char
 * in the haystack (e.g. space matches newline). Returns {start, end} in haystack coords
 * or null if not found.
 *
 * Bail out after MAX_FLEXIBLE_SEARCH_ITERATIONS to prevent O(N*M) DoS when a
 * malicious file has a highly repetitive pattern and the anchor's first word
 * matches everywhere.
 */
const MAX_FLEXIBLE_SEARCH_ITERATIONS = 10_000;
function flexibleIndexOf(
  haystack: string,
  needle: string,
  startFrom = 0,
): { start: number; end: number } | null {
  // Fast path: exact match
  const exact = haystack.indexOf(needle, startFrom);
  if (exact !== -1) return { start: exact, end: exact + needle.length };

  // Split needle on whitespace runs, then search for the parts in order
  // with flexible whitespace between them
  const parts = needle.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;
  if (parts.length === 1) {
    const idx = haystack.indexOf(parts[0], startFrom);
    return idx === -1 ? null : { start: idx, end: idx + parts[0].length };
  }

  let search = startFrom;
  let iterations = 0;
  while (search < haystack.length) {
    if (++iterations > MAX_FLEXIBLE_SEARCH_ITERATIONS) return null;
    const firstIdx = haystack.indexOf(parts[0], search);
    if (firstIdx === -1) return null;

    let pos = firstIdx + parts[0].length;
    let matched = true;
    for (let i = 1; i < parts.length; i++) {
      // Must have at least one whitespace char between parts
      if (pos >= haystack.length || !/\s/.test(haystack[pos])) {
        matched = false;
        break;
      }
      while (pos < haystack.length && /\s/.test(haystack[pos])) pos++;
      if (haystack.startsWith(parts[i], pos)) {
        pos += parts[i].length;
      } else {
        matched = false;
        break;
      }
    }
    if (matched) return { start: firstIdx, end: pos };
    search = firstIdx + 1;
  }
  return null;
}

function findSegments(
  text: string,
  segments: string[],
  startFrom = 0,
): { start: number; end: number } | null {
  let searchFrom = startFrom;
  let firstStart = -1;
  let lastEnd = -1;
  for (let i = 0; i < segments.length; i++) {
    const match = flexibleIndexOf(text, segments[i], searchFrom);
    if (!match) return null;
    if (i === 0) firstStart = match.start;
    lastEnd = match.end;
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
      if ((md[i] === '-' || md[i] === '*') && i + 1 < len && md[i + 1] === ' ') {
        i += 2;
        continue;
      }
      if (/\d/.test(md[i])) {
        let j = i;
        while (j < len && /\d/.test(md[j])) j++;
        if (j < len && md[j] === '.' && j + 1 < len && md[j + 1] === ' ') {
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

    // Backticks are always formatting.
    if (md[i] === '`') {
      i++;
      continue;
    }

    // Single tildes are literal text (for example ~/docs paths); only paired
    // tildes represent strikethrough formatting.
    if (md[i] === '~' && md[i + 1] === '~') {
      i += 2;
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
      // Skip whitespace so cross-line selections still match
      while (pos < text.length && /\s/.test(text[pos])) pos++;
      // After whitespace, skip optional block-level markers at line start (list bullets, blockquote)
      if (pos < text.length && /[-*+>]/.test(text[pos]) && (pos === 0 || text[pos - 1] === '\n')) {
        pos++;
        while (pos < text.length && text[pos] === ' ') pos++;
      }
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
export function detectMissingAnchors(cleanMarkdown: string, comments: MdComment[]): Set<string> {
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
        if (
          mermaidText &&
          (mermaidText.includes(c.anchor) || partsAppearContiguously(mermaidText, parts))
        ) {
          continue;
        }
        missing.add(c.id);
      }
    }
  }
  return missing;
}
