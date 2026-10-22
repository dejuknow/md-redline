import { describe, expect, it } from 'vitest';
import {
  computeAnsweredCommentIds,
  computeUserRepliedLast,
  effectiveSentCommentIds,
  isCommentSent,
  replyKey,
} from './answered-comments';
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

const stamped = (agent: boolean, id: string, text = 'text'): CommentReply => ({
  ...reply(agent ? 'Claude' : 'Dennis', id),
  text,
  agent,
});

describe('replyKey', () => {
  it('starts with the reply id and is stable for the same reply', () => {
    const r = stamped(false, 'r1', 'Please keep the old name.');
    expect(replyKey(r)).toMatch(/^r1~[0-9a-z]+$/);
    expect(replyKey(r)).toBe(replyKey({ ...r }));
  });

  it('changes when the text is edited, though the id stays', () => {
    const before = stamped(false, 'r1', 'Please keep the old name.');
    const after = { ...before, text: 'Please keep the old name, but add an alias.' };
    expect(replyKey(after)).not.toBe(replyKey(before));
  });

  it('ignores everything but the id and the text', () => {
    const r = stamped(false, 'r1', 'same');
    expect(replyKey({ ...r, timestamp: '2030-01-01T00:00:00.000Z', author: 'Someone' })).toBe(
      replyKey(r),
    );
  });

  it('tells apart texts that differ by one character, and an empty text from a missing one', () => {
    expect(replyKey(stamped(false, 'r1', 'a'))).not.toBe(replyKey(stamped(false, 'r1', 'b')));
    const missing = { id: 'r1', author: 'Dennis', timestamp: 't' } as unknown as CommentReply;
    expect(replyKey(missing)).toBe(replyKey(stamped(false, 'r1', '')));
  });
});

describe('computeUserRepliedLast', () => {
  it('maps a thread whose last reply is the reviewer’s to that reply’s key', () => {
    const last = stamped(false, 'r2');
    const c = comment({ replies: [stamped(true, 'r1'), last] });
    expect(computeUserRepliedLast([c])).toEqual(new Map([['c1', replyKey(last)]]));
  });

  it('maps to the newest reply when the reviewer replied more than once', () => {
    const newest = stamped(false, 'r3');
    const c = comment({ replies: [stamped(true, 'r1'), stamped(false, 'r2'), newest] });
    expect(computeUserRepliedLast([c])).toEqual(new Map([['c1', replyKey(newest)]]));
  });

  it('gives an edited reply a new key', () => {
    const sent = comment({ replies: [stamped(true, 'r1'), stamped(false, 'r2', 'first draft')] });
    const edited = comment({
      replies: [stamped(true, 'r1'), stamped(false, 'r2', 'corrected draft')],
    });
    expect(computeUserRepliedLast([edited]).get('c1')).not.toBe(
      computeUserRepliedLast([sent]).get('c1'),
    );
  });

  it('excludes a thread the agent answered last', () => {
    const c = comment({ replies: [stamped(false, 'r1'), stamped(true, 'r2')] });
    expect(computeUserRepliedLast([c])).toEqual(new Map());
  });

  it('excludes a resolved thread the reviewer replied to last', () => {
    const c = comment({
      replies: [stamped(true, 'r1'), stamped(false, 'r2')],
      status: 'resolved',
      resolved: true,
    });
    expect(computeUserRepliedLast([c])).toEqual(new Map());
  });

  it('keeps a resolved thread the reviewer replied to last when resolve is off', () => {
    const last = stamped(false, 'r2');
    const c = comment({
      replies: [stamped(true, 'r1'), last],
      status: 'resolved',
      resolved: true,
    });
    expect(computeUserRepliedLast([c], false)).toEqual(new Map([['c1', replyKey(last)]]));
  });

  it('excludes a thread with no replies', () => {
    expect(computeUserRepliedLast([comment()])).toEqual(new Map());
  });

  it('falls back to author comparison for unstamped replies', () => {
    const last = reply('Dennis', 'r2');
    const own = comment({ replies: [reply('Claude', 'r1'), last] });
    expect(computeUserRepliedLast([own])).toEqual(new Map([['c1', replyKey(last)]]));
  });
});

describe('isCommentSent', () => {
  const none = new Map<string, string>();

  it('is false for an id that was never sent', () => {
    expect(isCommentSent('c1', new Set(), new Set(), none)).toBe(false);
  });

  it('is true for a sent id with no reviewer reply waiting', () => {
    expect(isCommentSent('c1', new Set(['c1']), new Set(), none)).toBe(true);
  });

  it('is true when the reviewer’s last reply is among the sent keys', () => {
    const replied = new Map([['c1', 'r1~a']]);
    expect(isCommentSent('c1', new Set(['c1']), new Set(['r1~a']), replied)).toBe(true);
  });

  it('is false when the reviewer’s last reply is not among the sent keys', () => {
    const replied = new Map([['c1', 'r1~b']]);
    expect(isCommentSent('c1', new Set(['c1']), new Set(['r1~a']), replied)).toBe(false);
  });
});

describe('effectiveSentCommentIds', () => {
  it('lists the ids the sessions and this tab have sent, once each', () => {
    expect(effectiveSentCommentIds(['c1', 'c2', 'c1'], ['c2', 'c3'], new Map(), [])).toEqual([
      'c1',
      'c2',
      'c3',
    ]);
  });

  it('leaves out a sent comment whose last reply has not gone out', () => {
    const replied = new Map([['c2', 'r1~b']]);
    expect(effectiveSentCommentIds(['c1', 'c2'], [], replied, ['r1~a'])).toEqual(['c1']);
  });

  it('keeps a sent comment whose last reply went out, per a session or this tab', () => {
    const replied = new Map([
      ['c1', 'r1~a'],
      ['c2', 'r2~a'],
    ]);
    expect(effectiveSentCommentIds(['c1', 'c2'], [], replied, ['r1~a', 'r2~a'])).toEqual([
      'c1',
      'c2',
    ]);
    // Reported by the sessions, or only recorded optimistically: same result.
    expect(effectiveSentCommentIds(['c1'], ['c2'], replied, ['r1~a', 'r2~a'])).toEqual([
      'c1',
      'c2',
    ]);
  });

  it('does not add a comment with a pending reply that was never sent', () => {
    const replied = new Map([['c9', 'r1~a']]);
    expect(effectiveSentCommentIds(['c1'], [], replied, [])).toEqual(['c1']);
  });

  it('returns a comment to the sent list once its reply is sent', () => {
    const replied = new Map([['c1', 'r1~b']]);
    expect(effectiveSentCommentIds(['c1'], [], replied, ['r1~a'])).toEqual([]);
    expect(effectiveSentCommentIds(['c1'], [], replied, ['r1~a', 'r1~b'])).toEqual(['c1']);
  });
});
