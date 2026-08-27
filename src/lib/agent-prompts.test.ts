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

  it('scopes to specific comment IDs when commentIds is provided', () => {
    const prompt = buildAddressCommentsPrompt({
      filePaths: ['/tmp/spec.md'],
      commentCounts: new Map([['/tmp/spec.md', 5]]),
      enableResolve: false,
      commentIds: ['c1', 'c2', 'c3'],
    });

    expect(prompt).toContain('c1');
    expect(prompt).toContain('c2');
    expect(prompt).toContain('c3');
    expect(prompt).toContain('ONLY');
    expect(prompt).toContain('Leave any other comment markers');
  });

  it('addresses all comments when commentIds is absent (backward compat)', () => {
    const prompt = buildAddressCommentsPrompt({
      filePaths: ['/tmp/spec.md'],
      commentCounts: new Map([['/tmp/spec.md', 2]]),
      enableResolve: false,
    });

    expect(prompt).toContain('find all');
    expect(prompt).not.toContain('ONLY');
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

describe('buildAddressCommentsPrompt — anchor maintenance', () => {
  // A rewrite that leaves anchors pointing at text it deleted detaches the
  // review from the document, and the reviewer only finds out afterwards. The
  // prompt has to say the anchor is a lookup key, not just a description.
  it.each([true, false])(
    'tells the agent to keep anchors in sync (resolve=%s)',
    (enableResolve) => {
      const prompt = buildAddressCommentsPrompt({
        filePaths: ['/tmp/spec.md'],
        commentCounts: new Map([['/tmp/spec.md', 3]]),
        enableResolve,
      });

      expect(prompt).toContain('## Keeping anchors valid');
      expect(prompt).toContain('lookup key');
      expect(prompt).toContain('contextBefore');
      expect(prompt).toMatch(
        /Never leave an `anchor` pointing at text that is no longer in the file/,
      );
    },
  );

  it('covers resolved comments, not just the ones left open', () => {
    const prompt = buildAddressCommentsPrompt({
      filePaths: ['/tmp/spec.md'],
      commentCounts: new Map([['/tmp/spec.md', 1]]),
      enableResolve: true,
    });
    expect(prompt).toContain('comments you resolve as well as ones you leave open');
  });

  it('tells the agent to say so rather than re-point a deleted anchor', () => {
    const prompt = buildAddressCommentsPrompt({
      filePaths: ['/tmp/spec.md'],
      commentCounts: new Map([['/tmp/spec.md', 1]]),
      enableResolve: true,
    });
    expect(prompt).toContain('re-pointing the anchor at unrelated text');
  });
});

describe('buildAddressCommentsPrompt — mdr_ask hint', () => {
  it('mentions the mdr_ask tool so agents know it exists', () => {
    const prompt = buildAddressCommentsPrompt({
      filePaths: ['/tmp/a.md'],
      commentCounts: new Map([['/tmp/a.md', 1]]),
      enableResolve: false,
    });
    expect(prompt).toContain('mdr_ask');
    expect(prompt.toLowerCase()).toMatch(/anchored.*question/);
  });
});

describe('buildAddressCommentsPrompt - answering versus editing', () => {
  // A comment can ask for an edit or ask a question. Non-resolve mode used to
  // instruct removal of the marker for every comment addressed, and gave no
  // reply step at all, so a question had two possible outcomes: deleted with
  // no answer recorded, or left untouched with no answer recorded. Real
  // reviews lost their questions this way.
  it('gives non-resolve mode a reply step, not only resolve mode', () => {
    const prompt = buildAddressCommentsPrompt({
      filePaths: ['/tmp/spec.md'],
      commentCounts: new Map([['/tmp/spec.md', 1]]),
      enableResolve: false,
    });
    expect(prompt).toContain('add a reply to the `replies` array');
  });

  it('tells non-resolve mode to keep the marker when a comment only needed an answer', () => {
    const prompt = buildAddressCommentsPrompt({
      filePaths: ['/tmp/spec.md'],
      commentCounts: new Map([['/tmp/spec.md', 1]]),
      enableResolve: false,
    });
    expect(prompt).toContain('leave the marker in place so I can read that answer');
  });

  it('no longer tells non-resolve mode to remove the marker unconditionally', () => {
    const prompt = buildAddressCommentsPrompt({
      filePaths: ['/tmp/spec.md'],
      commentCounts: new Map([['/tmp/spec.md', 1]]),
      enableResolve: false,
    });
    // The old wording. Removal is now scoped to comments that required an edit.
    expect(prompt).not.toContain('After addressing a comment, remove the entire');
    expect(prompt).toContain('changed the document, remove the entire');
  });

  it.each([true, false])(
    'tells the agent to skip a comment it already answered (resolve=%s)',
    (enableResolve) => {
      // A question's marker now survives, and remove mode has no durable
      // "answered" state, so a later review session re-sends it: a new session
      // starts with an empty sentCommentIds and the marker is still in the
      // file. Without this the agent answers the same question twice and
      // stacks a duplicate reply.
      const prompt = buildAddressCommentsPrompt({
        filePaths: ['/tmp/spec.md'],
        commentCounts: new Map([['/tmp/spec.md', 1]]),
        enableResolve,
      });
      expect(prompt).toContain('already carries a reply authored by you');
      expect(prompt).toContain('do not reply again');
    },
  );

  it.each([true, false])(
    'scopes marker disposal to edit-type comments in both modes (resolve=%s)',
    (enableResolve) => {
      const prompt = buildAddressCommentsPrompt({
        filePaths: ['/tmp/spec.md'],
        commentCounts: new Map([['/tmp/spec.md', 1]]),
        enableResolve,
      });
      // Keyed on the document, never on whether a reply was written. Every
      // comment gets a reply now, so "only needed a reply" stopped
      // distinguishing anything and every marker was kept.
      expect(prompt).toContain('changed the document');
      expect(prompt).toContain('If the document did not change');
      expect(prompt).not.toContain('only needed a reply');
      expect(prompt).toContain('add a reply to the `replies` array');
    },
  );
});
