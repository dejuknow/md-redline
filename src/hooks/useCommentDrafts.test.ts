// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';

import { useCommentDrafts } from './useCommentDrafts';
import type { SelectionInfo } from '../types';

function makeSelection(text: string): SelectionInfo {
  return {
    text,
    rect: new DOMRect(0, 0, 10, 10),
    contextBefore: '',
    contextAfter: '',
    offset: 0,
  };
}

interface Props {
  surfaceFile: string | null;
  selection: SelectionInfo | null;
  /** The file's markdown; defaults to one that never changes. */
  docText?: string;
  /** The diff overlay is showing the file; defaults to false. */
  underDiff?: boolean;
  pendingSelection?: SelectionInfo | null;
}

/**
 * The hook with stand-ins for useSelection's two writers. They record their
 * calls in order; the test moves `selection` itself, the way a render after
 * the real ones would.
 */
function setup(initial: Props) {
  const calls: Array<['clear'] | ['adopt', SelectionInfo]> = [];
  const clearSelection = vi.fn(() => {
    calls.push(['clear']);
  });
  const adoptSelection = vi.fn((info: SelectionInfo) => {
    calls.push(['adopt', info]);
  });
  const view = renderHook(
    (props: Props) =>
      useCommentDrafts({
        docText: 'unchanged document',
        underDiff: false,
        ...props,
        clearSelection,
        adoptSelection,
      }),
    { initialProps: initial },
  );
  return { ...view, calls, clearSelection, adoptSelection };
}

afterEach(() => {
  cleanup();
});

describe('useCommentDrafts', () => {
  it('brings a draft back when the reader returns to its file', () => {
    const sel = makeSelection('valid credentials');
    const h = setup({ surfaceFile: '/a.md', selection: sel });
    act(() =>
      h.result.current.reportDraft({
        selection: sel,
        text: 'half a thought',
        prefillPristine: false,
      }),
    );

    h.rerender({ surfaceFile: '/b.md', selection: sel });
    expect(h.result.current.restoredDraft).toBeNull();
    h.rerender({ surfaceFile: '/b.md', selection: null });

    h.rerender({ surfaceFile: '/a.md', selection: null });
    expect(h.adoptSelection).toHaveBeenCalledWith(sel);
    h.rerender({ surfaceFile: '/a.md', selection: sel });
    expect(h.result.current.restoredDraft).toEqual({
      selection: sel,
      text: 'half a thought',
      prefillPristine: false,
    });
  });

  it('brings a draft back when the same file returns to the rendered view', () => {
    const sel = makeSelection('valid credentials');
    const h = setup({ surfaceFile: '/a.md', selection: sel });
    act(() =>
      h.result.current.reportDraft({
        selection: sel,
        text: 'half a thought',
        prefillPristine: false,
      }),
    );

    // Raw view: no file can show the form.
    h.rerender({ surfaceFile: null, selection: sel });
    h.rerender({ surfaceFile: null, selection: null });

    h.rerender({ surfaceFile: '/a.md', selection: null });
    expect(h.adoptSelection).toHaveBeenCalledWith(sel);
  });

  it('clears the selection when the form loses its file, draft or not', () => {
    const sel = makeSelection('valid credentials');
    const h = setup({ surfaceFile: '/a.md', selection: sel });

    h.rerender({ surfaceFile: null, selection: sel });

    expect(h.clearSelection).toHaveBeenCalledTimes(1);
  });

  it('restores after it clears when one file gives way to another', () => {
    const selA = makeSelection('in a');
    const selB = makeSelection('in b');
    const h = setup({ surfaceFile: '/b.md', selection: selB });
    act(() =>
      h.result.current.reportDraft({ selection: selB, text: 'b draft', prefillPristine: false }),
    );
    h.rerender({ surfaceFile: '/a.md', selection: selB });
    h.rerender({ surfaceFile: '/a.md', selection: selA });
    act(() =>
      h.result.current.reportDraft({ selection: selA, text: 'a draft', prefillPristine: false }),
    );
    h.calls.length = 0;

    // Straight from one loaded file to the other: A is parked, B comes back.
    h.rerender({ surfaceFile: '/b.md', selection: selA });

    expect(h.calls).toEqual([['clear'], ['adopt', selB]]);
  });

  it('keeps one draft per file', () => {
    const selA = makeSelection('in a');
    const selB = makeSelection('in b');
    const h = setup({ surfaceFile: '/a.md', selection: selA });
    act(() =>
      h.result.current.reportDraft({ selection: selA, text: 'a draft', prefillPristine: false }),
    );
    h.rerender({ surfaceFile: '/b.md', selection: selA });
    h.rerender({ surfaceFile: '/b.md', selection: selB });
    act(() =>
      h.result.current.reportDraft({ selection: selB, text: 'b draft', prefillPristine: false }),
    );

    h.rerender({ surfaceFile: '/a.md', selection: selB });
    h.rerender({ surfaceFile: '/a.md', selection: selA });
    expect(h.result.current.restoredDraft?.text).toBe('a draft');

    h.rerender({ surfaceFile: '/b.md', selection: selA });
    h.rerender({ surfaceFile: '/b.md', selection: selB });
    expect(h.result.current.restoredDraft?.text).toBe('b draft');
  });

  it('does not keep a form with nothing typed in it', () => {
    const sel = makeSelection('valid credentials');
    const h = setup({ surfaceFile: '/a.md', selection: sel });
    act(() =>
      h.result.current.reportDraft({ selection: sel, text: '  \n', prefillPristine: false }),
    );

    h.rerender({ surfaceFile: null, selection: sel });
    h.rerender({ surfaceFile: null, selection: null });
    h.rerender({ surfaceFile: '/a.md', selection: null });

    expect(h.adoptSelection).not.toHaveBeenCalled();
    expect(h.result.current.restoredDraft).toBeNull();
  });

  it('does not bring back a draft the reader cancelled', () => {
    const sel = makeSelection('valid credentials');
    const h = setup({ surfaceFile: '/a.md', selection: sel });
    act(() =>
      h.result.current.reportDraft({ selection: sel, text: 'never mind', prefillPristine: false }),
    );
    // Cancel, Escape and a posted comment all end the same way: the selection
    // goes, and the form with it. Nothing tells the store.
    h.rerender({ surfaceFile: '/a.md', selection: null });

    h.rerender({ surfaceFile: null, selection: null });
    h.rerender({ surfaceFile: '/a.md', selection: null });

    expect(h.adoptSelection).not.toHaveBeenCalled();
  });

  it('does not hand an old draft to a new selection', () => {
    const sel = makeSelection('valid credentials');
    const h = setup({ surfaceFile: '/a.md', selection: sel });
    act(() =>
      h.result.current.reportDraft({
        selection: sel,
        text: 'half a thought',
        prefillPristine: false,
      }),
    );
    h.rerender({ surfaceFile: null, selection: sel });
    h.rerender({ surfaceFile: null, selection: null });
    h.rerender({ surfaceFile: '/a.md', selection: null });
    h.rerender({ surfaceFile: '/a.md', selection: sel });
    expect(h.result.current.restoredDraft).not.toBeNull();

    // The restored comment is posted, and the reader selects something else.
    h.rerender({ surfaceFile: '/a.md', selection: null });
    h.rerender({ surfaceFile: '/a.md', selection: makeSelection('brute force attacks') });

    expect(h.result.current.restoredDraft).toBeNull();
  });

  it('keeps a restored draft through a second trip away before the form reports it', () => {
    const sel = makeSelection('valid credentials');
    const h = setup({ surfaceFile: '/a.md', selection: sel });
    act(() =>
      h.result.current.reportDraft({
        selection: sel,
        text: 'half a thought',
        prefillPristine: false,
      }),
    );
    h.rerender({ surfaceFile: null, selection: sel });
    h.rerender({ surfaceFile: null, selection: null });
    h.rerender({ surfaceFile: '/a.md', selection: null });
    h.rerender({ surfaceFile: '/a.md', selection: sel });
    h.adoptSelection.mockClear();

    h.rerender({ surfaceFile: null, selection: sel });
    h.rerender({ surfaceFile: null, selection: null });
    h.rerender({ surfaceFile: '/a.md', selection: null });

    expect(h.adoptSelection).toHaveBeenCalledWith(sel);
  });

  it('mounts the form afresh for every restored draft', () => {
    const sel = makeSelection('valid credentials');
    const h = setup({ surfaceFile: '/a.md', selection: sel });
    const before = h.result.current.formKey;
    act(() =>
      h.result.current.reportDraft({
        selection: sel,
        text: 'half a thought',
        prefillPristine: false,
      }),
    );

    h.rerender({ surfaceFile: null, selection: sel });
    h.rerender({ surfaceFile: null, selection: null });
    expect(h.result.current.formKey).toBe(before);

    h.rerender({ surfaceFile: '/a.md', selection: null });
    expect(h.result.current.formKey).not.toBe(before);
  });

  describe('when the file changed while the reader was away', () => {
    const ORIGINAL = 'original document';
    const EDITED = 'edited document';

    /** Draft on ORIGINAL, away, then back on `after`. */
    function parkAndReturn(after = EDITED) {
      const sel = makeSelection('target phrase');
      const h = setup({ surfaceFile: '/a.md', selection: sel, docText: ORIGINAL });
      act(() =>
        h.result.current.reportDraft({
          selection: sel,
          text: 'half a thought',
          prefillPristine: false,
        }),
      );
      h.rerender({ surfaceFile: null, selection: sel, docText: ORIGINAL });
      h.rerender({ surfaceFile: null, selection: null, docText: after });
      h.rerender({ surfaceFile: '/a.md', selection: null, docText: after });
      h.rerender({ surfaceFile: '/a.md', selection: sel, docText: after });
      return { h, sel };
    }

    it('hands back a draft on an unchanged file as postable', () => {
      const { h } = parkAndReturn(ORIGINAL);

      expect(h.result.current.restoredDraft?.text).toBe('half a thought');
      expect(h.result.current.selectionUnplaceable).toBe(false);
      expect(h.result.current.selectionDoc).toBe(ORIGINAL);
    });

    it('hands back a draft on a changed file, with its text, as not postable', () => {
      const { h, sel } = parkAndReturn();

      // Committed all the same, so the form opens on it with the text.
      expect(h.adoptSelection).toHaveBeenLastCalledWith(sel);
      expect(h.result.current.restoredDraft?.text).toBe('half a thought');
      expect(h.result.current.selectionUnplaceable).toBe(true);
      expect(h.result.current.selectionDoc).toBe(ORIGINAL);
    });

    it('stops being postable when the file changes after it came back', () => {
      const { h, sel } = parkAndReturn(ORIGINAL);
      h.rerender({ surfaceFile: '/a.md', selection: sel, docText: EDITED });

      expect(h.result.current.selectionUnplaceable).toBe(true);
    });

    it('is postable again if the file goes back to what it was', () => {
      const { h, sel } = parkAndReturn();
      h.rerender({ surfaceFile: '/a.md', selection: sel, docText: ORIGINAL });

      expect(h.result.current.selectionUnplaceable).toBe(false);
    });

    it('stays not postable through another trip away', () => {
      const { h, sel } = parkAndReturn();

      h.rerender({ surfaceFile: null, selection: sel, docText: EDITED });
      h.rerender({ surfaceFile: null, selection: null, docText: EDITED });
      h.rerender({ surfaceFile: '/a.md', selection: null, docText: EDITED });
      h.rerender({ surfaceFile: '/a.md', selection: sel, docText: EDITED });

      expect(h.result.current.selectionUnplaceable).toBe(true);
    });

    it('lets the next selection be placed as usual', () => {
      const { h } = parkAndReturn();
      const next = makeSelection('another phrase');
      h.rerender({ surfaceFile: '/a.md', selection: next, docText: EDITED });

      expect(h.result.current.restoredDraft).toBeNull();
      expect(h.result.current.selectionUnplaceable).toBe(false);
      // Made on the edited file, so that is what a submit checks against.
      expect(h.result.current.selectionDoc).toBe(EDITED);
    });

    it('counts a change that lands while the form is still open', () => {
      const sel = makeSelection('target phrase');
      const h = setup({ surfaceFile: '/a.md', selection: sel, docText: ORIGINAL });
      act(() =>
        h.result.current.reportDraft({ selection: sel, text: 'half', prefillPristine: false }),
      );
      // An edit lands with the form open, then the reader leaves and returns.
      h.rerender({ surfaceFile: '/a.md', selection: sel, docText: EDITED });
      h.rerender({ surfaceFile: null, selection: sel, docText: EDITED });
      h.rerender({ surfaceFile: null, selection: null, docText: EDITED });
      h.rerender({ surfaceFile: '/a.md', selection: null, docText: EDITED });
      h.rerender({ surfaceFile: '/a.md', selection: sel, docText: EDITED });

      // The selection was made on the original.
      expect(h.result.current.selectionUnplaceable).toBe(true);
      expect(h.result.current.selectionDoc).toBe(ORIGINAL);
    });

    it('does not count a change for a draft started on a pending selection', () => {
      // Touch and pen: the form mounts and reports on a selection not yet
      // committed, then the reader opens it, committing that same selection.
      const sel = makeSelection('target phrase');
      const h = setup({ surfaceFile: '/a.md', selection: null, docText: ORIGINAL });
      act(() => h.result.current.reportDraft({ selection: sel, text: '', prefillPristine: false }));
      h.rerender({ surfaceFile: '/a.md', selection: sel, docText: ORIGINAL });
      act(() =>
        h.result.current.reportDraft({ selection: sel, text: 'half', prefillPristine: false }),
      );
      h.rerender({ surfaceFile: null, selection: sel, docText: ORIGINAL });
      h.rerender({ surfaceFile: null, selection: null, docText: ORIGINAL });
      h.rerender({ surfaceFile: '/a.md', selection: null, docText: ORIGINAL });
      h.rerender({ surfaceFile: '/a.md', selection: sel, docText: ORIGINAL });

      expect(h.result.current.restoredDraft?.text).toBe('half');
      expect(h.result.current.selectionUnplaceable).toBe(false);
    });

    it("judges each file's draft by that file, across a quick switch", () => {
      const selA = makeSelection('alpha words');
      const selB = makeSelection('beta words');
      const h = setup({ surfaceFile: '/a.md', selection: selA, docText: 'A first' });
      act(() =>
        h.result.current.reportDraft({ selection: selA, text: 'on A', prefillPristine: false }),
      );
      h.rerender({ surfaceFile: '/b.md', selection: selA, docText: 'B' });
      h.rerender({ surfaceFile: '/b.md', selection: null, docText: 'B' });
      h.rerender({ surfaceFile: '/b.md', selection: selB, docText: 'B' });
      act(() =>
        h.result.current.reportDraft({ selection: selB, text: 'on B', prefillPristine: false }),
      );
      // Back to A, which changed, then straight back to B, which did not.
      h.rerender({ surfaceFile: '/a.md', selection: selB, docText: 'A second' });
      h.rerender({ surfaceFile: '/a.md', selection: selA, docText: 'A second' });
      expect(h.result.current.selectionUnplaceable).toBe(true);
      // The commit that switches still has A's selection: nothing is handed
      // back for B until its own selection is committed.
      h.rerender({ surfaceFile: '/b.md', selection: selA, docText: 'B' });
      expect(h.result.current.restoredDraft).toBeNull();
      h.rerender({ surfaceFile: '/b.md', selection: selB, docText: 'B' });

      expect(h.adoptSelection).toHaveBeenLastCalledWith(selB);
      expect(h.result.current.restoredDraft?.text).toBe('on B');
      expect(h.result.current.selectionUnplaceable).toBe(false);
    });

    it('only matches a selection made in the diff view while the diff still shows', () => {
      const sel = makeSelection('target phrase');
      const h = setup({ surfaceFile: '/a.md', selection: sel, underDiff: true });
      act(() =>
        h.result.current.reportDraft({
          selection: sel,
          text: 'from the diff',
          prefillPristine: false,
        }),
      );
      h.rerender({ surfaceFile: null, selection: sel, underDiff: true });
      h.rerender({ surfaceFile: null, selection: null, underDiff: false });
      h.rerender({ surfaceFile: '/a.md', selection: null, underDiff: false });
      h.rerender({ surfaceFile: '/a.md', selection: sel, underDiff: false });

      // Its offset was read over the diff's text, deleted blocks included.
      expect(h.result.current.selectionUnplaceable).toBe(true);
      expect(h.result.current.unplaceableReason).toBe('diff');

      h.rerender({ surfaceFile: '/a.md', selection: sel, underDiff: true });
      expect(h.result.current.selectionUnplaceable).toBe(false);
      expect(h.result.current.unplaceableReason).toBeNull();
    });

    it('lets a selection made in the plain view come back over the diff', () => {
      const sel = makeSelection('target phrase');
      const h = setup({ surfaceFile: '/a.md', selection: sel });
      act(() =>
        h.result.current.reportDraft({ selection: sel, text: 'plain', prefillPristine: false }),
      );
      h.rerender({ surfaceFile: null, selection: sel });
      h.rerender({ surfaceFile: null, selection: null });
      h.rerender({ surfaceFile: '/a.md', selection: null, underDiff: true });
      h.rerender({ surfaceFile: '/a.md', selection: sel, underDiff: true });

      expect(h.result.current.selectionUnplaceable).toBe(false);
    });

    it("marks a selection still on screen from the file just left as another file's", () => {
      const sel = makeSelection('target phrase');
      const h = setup({ surfaceFile: '/a.md', selection: sel });
      expect(h.result.current.selectionStale).toBe(false);

      // The commit that switches files, before the selection is cleared.
      h.rerender({ surfaceFile: '/b.md', selection: sel });
      expect(h.result.current.selectionStale).toBe(true);

      h.rerender({ surfaceFile: '/b.md', selection: null });
      expect(h.result.current.selectionStale).toBe(false);
      const next = makeSelection('on b');
      h.rerender({ surfaceFile: '/b.md', selection: next });
      expect(h.result.current.selectionStale).toBe(false);
    });
  });

  // #212: a form that never left gets the same check as a draft handed back.
  describe('when the file changes under a form that stays open', () => {
    const ORIGINAL = 'original document';
    const EDITED = 'edited document';

    function openForm() {
      const sel = makeSelection('TODO');
      const h = setup({ surfaceFile: '/a.md', selection: sel, docText: ORIGINAL });
      act(() =>
        h.result.current.reportDraft({ selection: sel, text: 'half', prefillPristine: false }),
      );
      return { h, sel };
    }

    it('is postable while the file is unchanged', () => {
      const { h } = openForm();

      expect(h.result.current.selectionUnplaceable).toBe(false);
      expect(h.result.current.unplaceableReason).toBeNull();
      expect(h.result.current.selectionDoc).toBe(ORIGINAL);
    });

    it('stops being postable when an edit lands, and says the file changed', () => {
      const { h, sel } = openForm();
      h.rerender({ surfaceFile: '/a.md', selection: sel, docText: EDITED });

      expect(h.result.current.selectionUnplaceable).toBe(true);
      expect(h.result.current.unplaceableReason).toBe('changed');
      // Submit checks the source it writes against the original.
      expect(h.result.current.selectionDoc).toBe(ORIGINAL);
    });

    it('is postable again if the file goes back to what it was', () => {
      const { h, sel } = openForm();
      h.rerender({ surfaceFile: '/a.md', selection: sel, docText: EDITED });
      h.rerender({ surfaceFile: '/a.md', selection: sel, docText: ORIGINAL });

      expect(h.result.current.selectionUnplaceable).toBe(false);
    });

    it('judges a plain selection with no form the same way', () => {
      const sel = makeSelection('TODO');
      const h = setup({ surfaceFile: '/a.md', selection: sel, docText: ORIGINAL });
      h.rerender({ surfaceFile: '/a.md', selection: sel, docText: EDITED });

      expect(h.result.current.unplaceableReason).toBe('changed');
    });

    it('lets a selection made after the edit be placed', () => {
      const { h, sel } = openForm();
      h.rerender({ surfaceFile: '/a.md', selection: sel, docText: EDITED });
      const next = makeSelection('TODO');
      h.rerender({ surfaceFile: '/a.md', selection: next, docText: EDITED });

      expect(h.result.current.selectionUnplaceable).toBe(false);
      expect(h.result.current.selectionDoc).toBe(EDITED);
    });

    // Touch and pen: committed only when the reader taps, by which time an
    // edit may have landed. The selection was made on the markdown before it.
    it('judges a pending selection by the markdown it was made on', () => {
      const sel = makeSelection('TODO');
      const h = setup({ surfaceFile: '/a.md', selection: null, docText: ORIGINAL });
      h.rerender({
        surfaceFile: '/a.md',
        selection: null,
        pendingSelection: sel,
        docText: ORIGINAL,
      });
      h.rerender({ surfaceFile: '/a.md', selection: null, pendingSelection: sel, docText: EDITED });
      // The tap commits the same object.
      h.rerender({ surfaceFile: '/a.md', selection: sel, pendingSelection: null, docText: EDITED });

      expect(h.result.current.unplaceableReason).toBe('changed');
      expect(h.result.current.selectionDoc).toBe(ORIGINAL);
    });

    it('stops a selection made in the diff view when the diff is hidden', () => {
      const sel = makeSelection('TODO');
      const h = setup({ surfaceFile: '/a.md', selection: sel, docText: ORIGINAL, underDiff: true });
      h.rerender({ surfaceFile: '/a.md', selection: sel, docText: ORIGINAL, underDiff: false });

      expect(h.result.current.unplaceableReason).toBe('diff');
    });
  });
});
