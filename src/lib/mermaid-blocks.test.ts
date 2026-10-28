import { describe, expect, it } from 'vitest';
import {
  collectMermaidBlocks,
  findCurrentMermaidBlock,
  getMermaidBlockIdentity,
  mermaidPlainHint,
} from './mermaid-blocks';
import { stripInlineFormatting } from './comment-parser';

const fence = (source: string) => `\`\`\`mermaid\n${source}\n\`\`\``;

describe('mermaid block helpers', () => {
  it('finds the same unique diagram after an earlier diagram is removed', () => {
    const original = [fence('graph TD\nA-->B'), 'middle', fence('graph TD\nC-->D')].join('\n\n');
    const originalBlocks = collectMermaidBlocks(original);
    const identity = getMermaidBlockIdentity(originalBlocks[1]);

    const updated = ['middle', fence('graph TD\nC-->D')].join('\n\n');
    const current = findCurrentMermaidBlock(
      collectMermaidBlocks(updated),
      originalBlocks[1].source,
      originalBlocks[1].index,
      identity,
    );

    expect(current?.index).toBe(0);
    expect(current?.source).toBe('graph TD\nC-->D');
  });

  it('does not retarget to a surviving duplicate when the active duplicate is removed', () => {
    const source = 'graph TD\nA-->B';
    const original = [
      'before first',
      fence(source),
      'between copies',
      fence(source),
      'after second',
    ].join('\n\n');
    const originalBlocks = collectMermaidBlocks(original);
    const identity = getMermaidBlockIdentity(originalBlocks[0]);

    const updated = ['between copies', fence(source), 'after second'].join('\n\n');
    const current = findCurrentMermaidBlock(
      collectMermaidBlocks(updated),
      source,
      originalBlocks[0].index,
      identity,
    );

    expect(current).toBeNull();
  });

  it('points the hint inside the diagram block, not at a matching prose occurrence', () => {
    const markdown = ['Profile page overview', fence('graph TD\nProfile[Profile]-->B')].join(
      '\n\n',
    );
    const [block] = collectMermaidBlocks(markdown);
    const { toPlainOffset } = stripInlineFormatting(markdown);
    const prosePlainOffset = toPlainOffset(markdown.indexOf('Profile'));

    const hint = mermaidPlainHint(markdown, block, 'Profile');

    expect(hint).toBeGreaterThan(prosePlainOffset);
    expect(hint).toBe(toPlainOffset(block.sourceStart + block.source.indexOf('Profile')));
  });

  it('falls back to the start of the block when the anchor is not in its source', () => {
    const markdown = ['intro', fence('graph TD\nA-->B')].join('\n\n');
    const [block] = collectMermaidBlocks(markdown);
    const { toPlainOffset } = stripInlineFormatting(markdown);

    expect(mermaidPlainHint(markdown, block, 'nowhere')).toBe(toPlainOffset(block.sourceStart));
  });
});
