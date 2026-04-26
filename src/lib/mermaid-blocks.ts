export interface MermaidBlock {
  index: number;
  source: string;
  start: number;
  end: number;
  sourceStart: number;
  sourceEnd: number;
  sourceOccurrence: number;
  sourceCount: number;
  contextBefore: string;
  contextAfter: string;
}

export interface MermaidBlockIdentity {
  sourceOccurrence: number;
  sourceCount: number;
  start: number;
  contextBefore: string;
  contextAfter: string;
}

const MERMAID_BLOCK_REGEX = /^```mermaid\s*\n([\s\S]*?)^```\s*$/gm;
const IDENTITY_CONTEXT_CHARS = 160;
const CONTEXT_MATCH_CHARS = 80;

export function collectMermaidBlocks(markdown: string): MermaidBlock[] {
  const blocks: MermaidBlock[] = [];
  const sourceOccurrences = new Map<string, number>();
  const regex = new RegExp(MERMAID_BLOCK_REGEX);
  let match: RegExpExecArray | null;

  while ((match = regex.exec(markdown)) !== null) {
    const source = match[1].trim();
    const start = match.index;
    const end = match.index + match[0].length;
    const sourceStart = source ? markdown.indexOf(source, start) : start;
    const occurrence = sourceOccurrences.get(source) ?? 0;
    sourceOccurrences.set(source, occurrence + 1);

    blocks.push({
      index: blocks.length,
      source,
      start,
      end,
      sourceStart,
      sourceEnd: sourceStart + source.length,
      sourceOccurrence: occurrence,
      sourceCount: 1,
      contextBefore: markdown.slice(Math.max(0, start - IDENTITY_CONTEXT_CHARS), start),
      contextAfter: markdown.slice(end, end + IDENTITY_CONTEXT_CHARS),
    });
  }

  for (const block of blocks) {
    block.sourceCount = sourceOccurrences.get(block.source) ?? 1;
  }

  return blocks;
}

export function getMermaidBlockIdentity(block: MermaidBlock): MermaidBlockIdentity {
  return {
    sourceOccurrence: block.sourceOccurrence,
    sourceCount: block.sourceCount,
    start: block.start,
    contextBefore: block.contextBefore,
    contextAfter: block.contextAfter,
  };
}

function scoreContext(block: MermaidBlock, identity: MermaidBlockIdentity): number {
  const beforeNeedle = identity.contextBefore.slice(-CONTEXT_MATCH_CHARS);
  const afterNeedle = identity.contextAfter.slice(0, CONTEXT_MATCH_CHARS);
  let score = 0;
  if (beforeNeedle && block.contextBefore.endsWith(beforeNeedle)) score += 4;
  if (afterNeedle && block.contextAfter.startsWith(afterNeedle)) score += 4;
  if (score > 0) {
    score += Math.max(0, 2 - Math.abs(block.start - identity.start) / 10_000);
  }
  return score;
}

export function findCurrentMermaidBlock(
  blocks: MermaidBlock[],
  source: string,
  originalBlockIndex: number,
  identity?: MermaidBlockIdentity | null,
): MermaidBlock | null {
  const trimmedSource = source.trim();
  const candidates = blocks.filter((block) => block.source === trimmedSource);
  if (candidates.length === 0) return null;
  if (candidates.length === 1) {
    if (!identity || identity.sourceCount <= 1) return candidates[0];
    return scoreContext(candidates[0], identity) > 0 ? candidates[0] : null;
  }

  if (identity) {
    const scored = candidates
      .map((block) => {
        return { block, score: scoreContext(block, identity) };
      })
      .sort((a, b) => b.score - a.score);

    if (scored[0]?.score > 0) return scored[0].block;
    return null;
  }

  return blocks[originalBlockIndex]?.source === trimmedSource ? blocks[originalBlockIndex] : null;
}
