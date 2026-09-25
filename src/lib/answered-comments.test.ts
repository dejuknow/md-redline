import { describe, expect, it } from 'vitest';
import { computeAnsweredCommentIds } from './answered-comments';
import type { MdComment, CommentReply } from '../types';

function comment(over: Partial<MdComment> = {}): MdComment {
  return {
    id: 'c1',
    anchor: 'the rate limit',
    text: 'Is this per tenant?',
    author: 'Dennis',
    timestamp: '2026-08-26T09:00:00.000Z',
    ...over,
  };
}

const reply = (author: string, id = 'r1'): CommentReply => ({
  id,
  text: 'text',
  author,
  timestamp: '2026-08-26T09:05:00.000Z',
});

// `author` is a required string on CommentReply, so the parser will not
// produce this. Markers are hand-editable and agent-written, though, and this
// is a render path, so the guard defends against a file the types say cannot
// exist. The cast is the only way to say that in a test.
const unattributedReply = {
  id: 'r1',
  text: 'text',
  timestamp: '2026-08-26T09:05:00.000Z',
} as unknown as CommentReply;

describe('computeAnsweredCommentIds', () => {
  it('marks a comment an agent replied to', () => {
    const ids = computeAnsweredCommentIds([comment({ replies: [reply('Claude')] })]);
    expect([...ids]).toEqual(['c1']);
  });

  it('does not mark a comment whose only reply is from its own author', () => {
    const ids = computeAnsweredCommentIds([comment({ replies: [reply('Dennis')] })]);
    expect(ids.size).toBe(0);
  });

  it('does not mark a comment with no replies', () => {
    expect(computeAnsweredCommentIds([comment()]).size).toBe(0);
  });

  it('ignores an unattributed reply rather than counting it as an answer', () => {
    // A false positive hides a question that never got answered, which is the
    // failure this whole indicator exists to prevent.
    const ids = computeAnsweredCommentIds([comment({ replies: [unattributedReply] })]);
    expect(ids.size).toBe(0);
    const empty = computeAnsweredCommentIds([comment({ replies: [reply('')] })]);
    expect(empty.size).toBe(0);
  });

  it('marks an agent-raised question once the reader answers it', () => {
    // mdr_ask posts a question authored by the agent. The reader's inline
    // reply answers it, and the thread is settled in that direction too.
    const ids = computeAnsweredCommentIds([
      comment({ author: 'Claude', replies: [reply('Dennis')] }),
    ]);
    expect([...ids]).toEqual(['c1']);
  });

  it('does not depend on who is reading, so a rename cannot rewrite history', () => {
    // The earlier version compared against the reader's live display name.
    // Renaming yourself made every comment you had self-replied to flip to
    // answered at once. Both names now come from the file, so the result is a
    // function of the document alone.
    const doc = [comment({ replies: [reply('Dennis')] })];
    expect(computeAnsweredCommentIds(doc).size).toBe(0);
    expect(computeAnsweredCommentIds(doc).size).toBe(0);
    expect(computeAnsweredCommentIds.length).toBe(1);
  });
});

describe('the agent stamp on a reply (#102)', () => {
  it("does not count a colleague's reply, which mdr's own UI stamps as a person's", () => {
    const withColleague = comment({ replies: [{ ...reply('Priya'), agent: false }] });
    expect(computeAnsweredCommentIds([withColleague]).has('c1')).toBe(false);
  });

  it('does not count your own follow-up after a rename', () => {
    const afterRename = comment({ replies: [{ ...reply('Dennis J'), agent: false }] });
    expect(computeAnsweredCommentIds([afterRename]).has('c1')).toBe(false);
  });

  it("counts an agent's reply, even one that happens to share the comment's author name", () => {
    const sameName = comment({ replies: [{ ...reply('Dennis'), agent: true }] });
    expect(computeAnsweredCommentIds([sameName]).has('c1')).toBe(true);
  });

  it('falls back to comparing names for a reply written before the stamp existed', () => {
    expect(computeAnsweredCommentIds([comment({ replies: [reply('Claude')] })]).has('c1')).toBe(
      true,
    );
    expect(computeAnsweredCommentIds([comment({ replies: [reply('Dennis')] })]).has('c1')).toBe(
      false,
    );
  });

  it('falls back to names when a hand-edited stamp is not a boolean', () => {
    const odd = { ...reply('Claude'), agent: 'true' } as unknown as CommentReply;
    expect(computeAnsweredCommentIds([comment({ replies: [odd] })]).has('c1')).toBe(true);
  });
});
