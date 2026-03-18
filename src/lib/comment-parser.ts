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
  const cleanIdx = cleanMarkdown.indexOf(anchor);
  if (cleanIdx === -1) return rawMarkdown;

  // Insert right after the anchor text in the raw markdown
  const rawInsertionPoint = cleanToRawOffset(cleanIdx + anchor.length);

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
