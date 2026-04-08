import { describe, expect, it } from 'vitest';
import { buildAddressCommentsPrompt } from './agent-prompts';

describe('buildAddressCommentsPrompt', () => {
  it('builds a single-file handoff prompt', () => {
    const prompt = buildAddressCommentsPrompt({
      filePaths: ['/tmp/spec.md'],
      commentCounts: new Map([['/tmp/spec.md', 2]]),
      enableResolve: false,
    });

    expect(prompt).toContain("I've left review comments in /tmp/spec.md");
    expect(prompt).toContain('Read /tmp/spec.md');
    expect(prompt).toContain('remove the entire `<!-- @comment{...} -->` marker');
    expect(prompt).not.toContain('## Files to review');
  });

  it('includes multi-file counts and resolve instructions', () => {
    const prompt = buildAddressCommentsPrompt({
      filePaths: ['/tmp/a.md', '/tmp/b.md'],
      commentCounts: new Map([
        ['/tmp/a.md', 1],
        ['/tmp/b.md', 3],
      ]),
      enableResolve: true,
    });

    expect(prompt).toContain('## Files to review');
    expect(prompt).toContain('/tmp/a.md (1 comment)');
    expect(prompt).toContain('/tmp/b.md (3 comments)');
    expect(prompt).toContain('"status":"resolved"');
    expect(prompt).toContain('add a reply to the `replies` array');
  });

  it('does not ask the agent to fill in a timestamp (md-redline assigns it)', () => {
    const prompt = buildAddressCommentsPrompt({
      filePaths: ['/tmp/spec.md'],
      commentCounts: new Map([['/tmp/spec.md', 1]]),
      enableResolve: true,
    });
    // The example reply schema must NOT include a timestamp field, since
    // agents can't reliably know "now" and tend to hallucinate stale values.
    expect(prompt).not.toContain('"timestamp"');
    expect(prompt).toContain('Do NOT include a `timestamp` field');
  });
});
