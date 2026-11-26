// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';

import { judgeCardTarget, useCardDrafts, type CardEditorTarget } from './useCardDrafts';
import type { SidebarCommentEditorState } from '../lib/comment-editor-state';
import type { MdComment } from '../types';

afterEach(cleanup);

function comment(id: string, extra: Partial<MdComment> = {}): MdComment {
  return {
    id,
    anchor: 'anchor',
    text: `${id} text`,
    author: 'User',
    timestamp: '2026-01-01T00:00:00.000Z',
    replies: [],
    ...extra,
  };
}

const A_COMMENTS = [
  comment('a1', { replies: [{ id: 'r1', text: 'a reply', author: 'User', timestamp: '' }] }),
  comment('a2'),
];
const B_COMMENTS = [comment('b1')];

const reply = (commentId: string): CardEditorTarget => ({ mode: 'reply-compose', commentId });
const edit = (commentId: string): CardEditorTarget => ({ mode: 'comment-edit', commentId });

interface Props {
  file: string | null;
  comments: MdComment[];
  requestedEditor?: SidebarCommentEditorState;
}

function setup(initial: Props) {
  const onEditorBack = vi.fn();
  const view = renderHook(
    (props: Props) => useCardDrafts({ requestedEditor: null, ...props, onEditorBack }),
    { initialProps: initial },
  );
  return { ...view, onEditorBack };
}

describe('judgeCardTarget', () => {
  const draft = (target: CardEditorTarget, base = '') => ({
    target,
    text: 'typed',
    base,
    caret: [0, 0] as [number, number],
  });

  it('takes a reply back while its comment is there and open', () => {
    expect(judgeCardTarget(reply('a1'), draft(reply('a1')), A_COMMENTS)).toBeNull();
  });

  it('refuses a reply whose comment is gone or resolved', () => {
    expect(judgeCardTarget(reply('zz'), draft(reply('zz')), A_COMMENTS)).toBe('comment-gone');
    const resolved = [comment('a1', { status: 'resolved' })];
    expect(judgeCardTarget(reply('a1'), draft(reply('a1')), resolved)).toBe('resolved');
  });

  it('refuses an edit whose text changed under it', () => {
    expect(judgeCardTarget(edit('a1'), draft(edit('a1'), 'a1 text'), A_COMMENTS)).toBeNull();
    expect(judgeCardTarget(edit('a1'), draft(edit('a1'), 'older text'), A_COMMENTS)).toBe(
      'changed',
    );
  });

  it('refuses a reply edit whose reply is gone or changed', () => {
    const target: CardEditorTarget = { mode: 'reply-edit', commentId: 'a1', replyId: 'r1' };
    expect(judgeCardTarget(target, draft(target, 'a reply'), A_COMMENTS)).toBeNull();
    expect(judgeCardTarget(target, draft(target, 'before'), A_COMMENTS)).toBe('changed');
    const gone: CardEditorTarget = { mode: 'reply-edit', commentId: 'a1', replyId: 'r9' };
    expect(judgeCardTarget(gone, draft(gone, 'x'), A_COMMENTS)).toBe('reply-gone');
  });
});

describe('useCardDrafts', () => {
  it('keeps a file’s open editor and draft across a switch to another file', () => {
    const view = setup({ file: 'a.md', comments: A_COMMENTS });
    const editor = { mode: 'reply-compose' as const, commentId: 'a1', token: 1 };
    act(() => view.result.current.api!.setEditor(editor));
    act(() => view.result.current.api!.writeDraft(reply('a1'), 'half a reply', '', [4, 4]));

    view.rerender({ file: 'b.md', comments: B_COMMENTS });
    expect(view.result.current.api!.editor).toBeNull();
    expect(view.result.current.api!.readDraft(reply('a1'))).toBeNull();

    view.rerender({ file: 'a.md', comments: A_COMMENTS });
    expect(view.result.current.api!.editor).toBe(editor);
    expect(view.result.current.api!.readDraft(reply('a1'))).toMatchObject({
      text: 'half a reply',
      caret: [4, 4],
    });
    // Its card is selected again.
    expect(view.onEditorBack).toHaveBeenLastCalledWith('a1');
  });

  it('closes an editor with nothing typed when its file is left', () => {
    const view = setup({ file: 'a.md', comments: A_COMMENTS });
    act(() =>
      view.result.current.api!.setEditor({ mode: 'reply-compose', commentId: 'a1', token: 1 }),
    );
    view.rerender({ file: 'b.md', comments: B_COMMENTS });
    view.rerender({ file: 'a.md', comments: A_COMMENTS });
    expect(view.result.current.api!.editor).toBeNull();
    expect(view.onEditorBack).not.toHaveBeenCalled();
  });

  it('keeps every draft while no file can show (loading), and the editor with it', () => {
    const view = setup({ file: 'a.md', comments: A_COMMENTS });
    const editor = { mode: 'reply-compose' as const, commentId: 'a1', token: 1 };
    act(() => view.result.current.api!.setEditor(editor));
    act(() => view.result.current.api!.writeDraft(reply('a1'), 'kept', '', [4, 4]));
    view.rerender({ file: null, comments: [] });
    expect(view.result.current.api).toBeNull();
    expect(view.result.current.setAside).toEqual([]);
    view.rerender({ file: 'a.md', comments: A_COMMENTS });
    expect(view.result.current.api!.editor).toBe(editor);
  });

  it('drops text that is empty or only the text an edit opened on', () => {
    const view = setup({ file: 'a.md', comments: A_COMMENTS });
    const api = () => view.result.current.api!;
    act(() => api().writeDraft(reply('a1'), '   ', '', [3, 3]));
    expect(api().readDraft(reply('a1'))).toBeNull();
    act(() => api().writeDraft(edit('a1'), 'a1 text', 'a1 text', [0, 0]));
    expect(api().readDraft(edit('a1'))).toBeNull();
    act(() => api().writeDraft(edit('a1'), 'a1 text!', 'a1 text', [8, 8]));
    expect(api().readDraft(edit('a1'))?.text).toBe('a1 text!');
    act(() => api().writeDraft(edit('a1'), 'a1 text', 'a1 text', [7, 7]));
    expect(api().readDraft(edit('a1'))).toBeNull();
  });

  it('keeps two cards’ drafts apart, and the first when the second opens', () => {
    const view = setup({ file: 'a.md', comments: A_COMMENTS });
    const api = () => view.result.current.api!;
    act(() => api().setEditor({ mode: 'reply-compose', commentId: 'a1', token: 1 }));
    act(() => api().writeDraft(reply('a1'), 'first', '', [5, 5]));
    act(() => api().setEditor({ mode: 'reply-compose', commentId: 'a2', token: 2 }));
    act(() => api().writeDraft(reply('a2'), 'second', '', [6, 6]));
    expect(api().readDraft(reply('a1'))?.text).toBe('first');
    expect(api().readDraft(reply('a2'))?.text).toBe('second');
    expect(view.result.current.setAside).toEqual([]);
  });

  it('discards a draft for good on Cancel or send', () => {
    const view = setup({ file: 'a.md', comments: A_COMMENTS });
    const api = () => view.result.current.api!;
    act(() => api().writeDraft(reply('a1'), 'going', '', [5, 5]));
    act(() => api().discardDraft(reply('a1')));
    expect(api().readDraft(reply('a1'))).toBeNull();
  });

  it('sets aside a draft whose comment is gone, without its editor, and brings both back with it', () => {
    const view = setup({ file: 'a.md', comments: A_COMMENTS });
    const editor = { mode: 'reply-compose' as const, commentId: 'a1', token: 1 };
    act(() => view.result.current.api!.setEditor(editor));
    act(() => view.result.current.api!.writeDraft(reply('a1'), 'orphan', '', [6, 6]));

    view.rerender({ file: 'a.md', comments: [comment('a2')] });
    expect(view.result.current.api!.editor).toBeNull();
    expect(view.result.current.setAside).toEqual([
      expect.objectContaining({
        problem: 'comment-gone',
        draft: expect.objectContaining({ text: 'orphan' }),
      }),
    ]);

    // An undo puts the comment back: so is its editor, and nothing is aside.
    view.rerender({ file: 'a.md', comments: A_COMMENTS });
    expect(view.result.current.api!.editor).toBe(editor);
    expect(view.result.current.setAside).toEqual([]);
  });

  it('sets aside an edit whose comment text changed under it', () => {
    const view = setup({ file: 'a.md', comments: A_COMMENTS });
    act(() =>
      view.result.current.api!.setEditor({ mode: 'comment-edit', commentId: 'a1', token: 1 }),
    );
    act(() => view.result.current.api!.writeDraft(edit('a1'), 'mine', 'a1 text', [4, 4]));
    view.rerender({
      file: 'a.md',
      comments: [comment('a1', { text: 'theirs' }), comment('a2')],
    });
    expect(view.result.current.api!.editor).toBeNull();
    expect(view.result.current.setAside.map((d) => d.problem)).toEqual(['changed']);
  });

  it('opening an edit afresh over a draft that cannot go back keeps that draft offered', () => {
    const view = setup({ file: 'a.md', comments: A_COMMENTS });
    act(() =>
      view.result.current.api!.setEditor({ mode: 'comment-edit', commentId: 'a1', token: 1 }),
    );
    act(() => view.result.current.api!.writeDraft(edit('a1'), 'mine', 'a1 text', [4, 4]));
    const changed = [comment('a1', { text: 'theirs' }), comment('a2')];
    view.rerender({ file: 'a.md', comments: changed });

    const fresh = { mode: 'comment-edit' as const, commentId: 'a1', token: 2 };
    act(() => view.result.current.api!.setEditor(fresh));
    expect(view.result.current.api!.editor).toBe(fresh);
    expect(view.result.current.api!.readDraft(edit('a1'))).toBeNull();
    const [aside] = view.result.current.setAside;
    expect(aside).toMatchObject({ problem: 'changed', draft: { text: 'mine' } });

    act(() => view.result.current.discardSetAside(aside.key));
    expect(view.result.current.setAside).toEqual([]);
    expect(view.result.current.api!.editor).toBe(fresh);
  });

  it('does not select the card again when its draft cannot go back in', () => {
    const view = setup({ file: 'a.md', comments: A_COMMENTS });
    act(() =>
      view.result.current.api!.setEditor({ mode: 'reply-compose', commentId: 'a1', token: 1 }),
    );
    act(() => view.result.current.api!.writeDraft(reply('a1'), 'orphan', '', [6, 6]));
    view.rerender({ file: 'b.md', comments: B_COMMENTS });
    view.rerender({ file: 'a.md', comments: [comment('a2')] });
    expect(view.onEditorBack).not.toHaveBeenCalled();
    expect(view.result.current.setAside).toHaveLength(1);
  });

  it('discarding a set-aside draft drops it and closes its editor', () => {
    const view = setup({ file: 'a.md', comments: A_COMMENTS });
    act(() =>
      view.result.current.api!.setEditor({ mode: 'reply-compose', commentId: 'a1', token: 1 }),
    );
    act(() => view.result.current.api!.writeDraft(reply('a1'), 'orphan', '', [6, 6]));
    view.rerender({ file: 'a.md', comments: [comment('a2')] });
    const [aside] = view.result.current.setAside;
    act(() => view.result.current.discardSetAside(aside.key));
    expect(view.result.current.setAside).toEqual([]);
    view.rerender({ file: 'a.md', comments: A_COMMENTS });
    expect(view.result.current.api!.editor).toBeNull();
  });

  it('opens a requested editor once, in the file on screen', () => {
    const request = { mode: 'reply-compose' as const, commentId: 'a2', token: 5 };
    const view = setup({ file: 'a.md', comments: A_COMMENTS });
    view.rerender({ file: 'a.md', comments: A_COMMENTS, requestedEditor: request });
    expect(view.result.current.api!.editor).toBe(request);
    act(() => view.result.current.api!.setEditor(null));
    // The same request does not open it again on a later render.
    view.rerender({ file: 'a.md', comments: [...A_COMMENTS], requestedEditor: request });
    expect(view.result.current.api!.editor).toBeNull();
  });
});
