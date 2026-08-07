// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, cleanup } from '@testing-library/react';
import type { RefObject } from 'react';
import { useCommentTicks } from './useCommentTicks';
import type { MdComment } from '../types';

// jsdom has no ResizeObserver; the hook's late-reflow effect constructs one.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function comment(overrides: Partial<MdComment> & { id: string }): MdComment {
  return {
    anchor: 'an anchor',
    text: 'A comment',
    author: 'Dennis',
    timestamp: '2026-08-07T12:00:00.000Z',
    ...overrides,
  };
}

/**
 * A scroll container holding one painted mark per id. Every rect is zero in
 * jsdom, which is fine: these tests are about which kind each tick gets, not
 * where it lands.
 */
function mountContainer(ids: string[]): RefObject<HTMLElement | null> {
  const container = document.createElement('div');
  const prose = document.createElement('div');
  container.appendChild(prose);
  for (const id of ids) {
    const mark = document.createElement('mark');
    mark.dataset.commentIds = id;
    prose.appendChild(mark);
  }
  document.body.appendChild(container);
  return { current: container };
}

function kindsFor(comments: MdComment[]): Record<string, string> {
  const ref = mountContainer(comments.map((c) => c.id));
  const { result } = renderHook(() => useCommentTicks(ref, comments, true, 1));
  return Object.fromEntries(result.current.map((t) => [t.id, t.kind]));
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('useCommentTicks tick kind', () => {
  // Only addReply/appendReply clear expectsReply, so an ask the reviewer
  // settles without answering keeps the flag forever. Testing it before
  // status paints the accent tick reserved for questions still waiting on
  // someone, which contradicts the banner (selectAgentAsks filters asks to
  // open comments) and the trace's own premise that a settled anchor is
  // quiet. Unreachable until resolved anchors started painting a mark for
  // measureAnchorTops to find, which is why it shipped.
  it('paints a settled agent ask as resolved, not as a pending ask', () => {
    const kinds = kindsFor([
      comment({ id: 'settled-ask', expectsReply: true, status: 'resolved' }),
    ]);
    expect(kinds['settled-ask']).toBe('resolved');
  });

  it('still paints an unanswered ask on an open comment as an ask', () => {
    const kinds = kindsFor([comment({ id: 'live-ask', expectsReply: true })]);
    expect(kinds['live-ask']).toBe('ask');
  });

  it('distinguishes the three kinds in one pass', () => {
    const kinds = kindsFor([
      comment({ id: 'plain' }),
      comment({ id: 'asking', expectsReply: true }),
      comment({ id: 'done', status: 'resolved' }),
      // The legacy boolean spelling of resolved, via getEffectiveStatus.
      comment({ id: 'done-legacy', resolved: true, expectsReply: true }),
    ]);
    expect(kinds).toEqual({
      plain: 'open',
      asking: 'ask',
      done: 'resolved',
      'done-legacy': 'resolved',
    });
  });

  it('skips comments with no painted mark to measure', () => {
    const ref = mountContainer(['painted']);
    const comments = [comment({ id: 'painted' }), comment({ id: 'unpainted' })];
    const { result } = renderHook(() => useCommentTicks(ref, comments, true, 1));
    expect(result.current.map((t) => t.id)).toEqual(['painted']);
  });
});
