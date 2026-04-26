import type { MdComment } from '../types';
import { extractMermaidText } from './comment-parser';

/**
 * Filter comments down to those that belong to a specific Mermaid diagram.
 *
 * When `cleanMarkdown` is provided we attribute by **position** — a comment
 * belongs to a diagram if its marker (`cleanOffset`) lies inside that
 * diagram's fenced block range. This is the source of truth: it works for
 * every Mermaid syntax (flowchart, sequence, state, gantt, …) regardless of
 * whether `extractMermaidText` knows how to parse the labels.
 *
 * `blockIndex` (0-based, in source order) disambiguates two diagrams whose
 * source text is byte-identical. Without it, the second copy would inherit
 * comments filed against the first copy.
 *
 * Without `cleanMarkdown` (legacy callers, tests) we fall back to plain
 * anchor-vs-haystack matching using `extractMermaidText`, which only
 * understands flowcharts and sequence diagrams.
 */
export function commentsForDiagram(
  diagramSource: string,
  comments: MdComment[],
  cleanMarkdown?: string,
  blockIndex?: number,
): MdComment[] {
  if (!cleanMarkdown) {
    const haystack = extractMermaidText(`\`\`\`mermaid\n${diagramSource}\n\`\`\``);
    return comments.filter((c) => haystack.includes(c.anchor));
  }

  // Walk every fenced mermaid block in the doc, in source order, to find
  // both the position of THIS specific block (its index, when supplied)
  // and the surrounding range we attribute comments to.
  const blockRanges: { start: number; end: number }[] = [];
  const blockRegex = /^```mermaid\s*\n([\s\S]*?)^```\s*$/gm;
  let m: RegExpExecArray | null;
  while ((m = blockRegex.exec(cleanMarkdown)) !== null) {
    blockRanges.push({ start: m.index, end: m.index + m[0].length });
  }

  let idx = -1;
  if (blockIndex != null && blockIndex >= 0 && blockIndex < blockRanges.length) {
    // Trust the caller's index: identifies the right copy among duplicates.
    // Verify the source actually matches at that block (defensive; handles
    // mid-edit live updates by falling through to the source-search path).
    const candidate = blockRanges[blockIndex];
    const sourceStart = cleanMarkdown.indexOf(diagramSource, candidate.start);
    if (sourceStart >= candidate.start && sourceStart + diagramSource.length <= candidate.end) {
      idx = blockIndex;
    }
  }
  if (idx < 0) {
    // Fallback: locate by source text (first occurrence).
    const blockStart = cleanMarkdown.indexOf(diagramSource);
    if (blockStart < 0) {
      // Live-edit race or unsupported parse — fall back to anchor matching.
      const haystack = extractMermaidText(`\`\`\`mermaid\n${diagramSource}\n\`\`\``);
      return comments.filter((c) => haystack.includes(c.anchor));
    }
    const blockEnd = blockStart + diagramSource.length;
    idx = blockRanges.findIndex((b) => blockStart >= b.start && blockEnd <= b.end);
    if (idx < 0) {
      const haystack = extractMermaidText(`\`\`\`mermaid\n${diagramSource}\n\`\`\``);
      return comments.filter((c) => haystack.includes(c.anchor));
    }
  }

  // Claim range = the block itself, fences included. insertComment relocates
  // a marker that resolves inside a fenced block to the opening-fence line,
  // so that's the lowest position a real diagram-anchored marker can land.
  // Anything earlier — previous block, prose between, anything before the doc
  // — belongs to that earlier context, not to this diagram, even when the
  // anchor text happens to match a label name.
  const claimStart = blockRanges[idx].start;
  const claimEnd = blockRanges[idx].end;

  return comments.filter((c) => {
    // Comments without a known offset (parser couldn't compute one) fall
    // back to anchor matching against whatever the source extractor knows.
    if (c.cleanOffset == null) {
      const haystack = extractMermaidText(`\`\`\`mermaid\n${diagramSource}\n\`\`\``);
      return haystack.includes(c.anchor);
    }
    // Exclusive upper bound: a marker AT claimEnd lives in the trailing
    // newline / whitespace AFTER the closing fence, which belongs to the
    // following prose, not to the diagram.
    return c.cleanOffset >= claimStart && c.cleanOffset < claimEnd;
  });
}

export interface ThreadWithPosition {
  comment: MdComment;
  /** Top coordinate of the matching SVG element in SVG-local pixels, or null if not found. */
  top: number | null;
}

export function orderThreadsBySvgPosition(
  comments: MdComment[],
  svg: SVGSVGElement | null,
): ThreadWithPosition[] {
  if (!svg) {
    return comments.map((comment) => ({ comment, top: null }));
  }
  const textNodes = Array.from(svg.querySelectorAll<SVGTextElement>('text'));
  const positioned: ThreadWithPosition[] = comments.map((comment) => {
    const match = textNodes.find((t) => (t.textContent || '').includes(comment.anchor));
    if (!match) return { comment, top: null };
    const bbox = match.getBBox();
    return { comment, top: bbox.y };
  });
  return positioned.sort((a, b) => {
    if (a.top === null && b.top === null) return 0;
    if (a.top === null) return 1;
    if (b.top === null) return -1;
    return a.top - b.top;
  });
}
