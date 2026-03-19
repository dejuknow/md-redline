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
  } else {
    // Flexible match for cross-element selections: the anchor (from rendered text)
    // may contain newlines between block elements, while the markdown source has
    // syntax chars (e.g. "# ") and different whitespace. Split anchor by newlines
    // and find each segment in order within the clean markdown.
    const segments = anchor.split(/\n+/).map(s => s.trim()).filter(Boolean);
    if (segments.length > 0) {
      let searchFrom = 0;
      let lastEnd = -1;
      let allFound = true;
      for (const segment of segments) {
        const idx = cleanMarkdown.indexOf(segment, searchFrom);
        if (idx === -1) { allFound = false; break; }
        lastEnd = idx + segment.length;
        searchFrom = lastEnd;
      }
      if (allFound && lastEnd !== -1) {
        insertionCleanOffset = lastEnd;
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
