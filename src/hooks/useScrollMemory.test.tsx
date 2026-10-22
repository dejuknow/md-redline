// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { useCallback, useLayoutEffect, useRef, type RefObject } from 'react';
import { cleanup, render } from '@testing-library/react';
import { ReadingPositionCapture, useScrollMemory, type ReadingView } from './useScrollMemory';

const RENDERED_KEY = 'md-redline-scroll-positions';
const RAW_KEY = 'md-redline-raw-scroll-positions';
const VIEWPORT = 500;
// Blocks are this tall, except under a page that reserves the comment rail's
// gutter: the column is narrower there, so the same text wraps taller.
const layout = { blockHeight: 100, gutterBlockHeight: 150 };
/** The `behavior` of every scrollTo, in order, for assertions. */
let scrolls: (ScrollBehavior | undefined)[] = [];

/** Every block in a scroller, in document order: viewer, raw view or diff. */
function blocksIn(scroller: Element): Element[] {
  return Array.from(scroller.querySelectorAll('[data-block]'));
}

function blockHeightIn(scroller: Element): number {
  return scroller.querySelector('[data-gutter]') ? layout.gutterBlockHeight : layout.blockHeight;
}

const modelled = new WeakSet<Element>();

/**
 * jsdom has no layout, so every scroller React creates gets a stand-in that
 * behaves as a browser's does where these tests need it:
 *
 * - Reading scrollTop lays the scroller out, which clamps the offset to what
 *   its content allows, and the clamp sticks once read. A read made while the
 *   viewer is empty (React has just swapped it) loses the offset for good.
 * - A detached scroller has no box and reads 0.
 * - `scroll-behavior: smooth` (index.css, `.overflow-y-auto`): a scrollTo that
 *   does not opt out starts an animation, so nothing has moved on the tick
 *   that asked for it.
 */
function modelScroller(el: HTMLElement) {
  if (modelled.has(el)) return;
  modelled.add(el);
  let top = 0;
  const max = () => Math.max(0, blocksIn(el).length * blockHeightIn(el) - VIEWPORT);
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => (el.isConnected ? (top = Math.min(top, max())) : 0),
    set: (v: number) => {
      top = Math.max(0, Math.min(v, max()));
    },
  });
  el.scrollTo = ((options: ScrollToOptions) => {
    scrolls.push(options.behavior);
    if (options.behavior !== 'instant' && options.behavior !== 'auto') return;
    el.scrollTop = options.top ?? 0;
  }) as typeof el.scrollTo;
}

function rect(top: number, bottom: number): DOMRect {
  return { top, bottom, left: 0, right: 100, width: 100, height: bottom - top } as DOMRect;
}

const originalRect = Element.prototype.getBoundingClientRect;
/** A scroller's viewport sits at the top of the page; its blocks stack. */
function fakeRect(this: Element): DOMRect {
  if (!this.isConnected) return rect(0, 0);
  if (modelled.has(this)) return rect(0, VIEWPORT);
  const scroller = this.closest('[data-scroller]') as HTMLElement | null;
  if (scroller && this.hasAttribute('data-block')) {
    const height = blockHeightIn(scroller);
    const top = blocksIn(scroller).indexOf(this) * height - scroller.scrollTop;
    return rect(top, top + height);
  }
  return originalRect.call(this);
}

/**
 * Stands in for MarkdownViewer: it owns its container's children and swaps the
 * document in with innerHTML from a layout effect, so React never sees them.
 */
function Viewer({
  blocks,
  blocksRef,
}: {
  blocks: string[];
  blocksRef: RefObject<HTMLDivElement | null>;
}) {
  useLayoutEffect(() => {
    blocksRef.current!.innerHTML = blocks.map((b) => `<p data-block>${b}</p>`).join('');
  }, [blocks, blocksRef]);
  return <div ref={blocksRef} />;
}

/** A different element type in the same place, so React replaces the viewer
 *  on a switch between a document shown through it and one that is not. App
 *  did exactly this for documents with a Mermaid fence until it rendered one
 *  viewer for every document; the diff overlay, keyed by path, still makes
 *  React replace what the scroller holds on a switch. */
function OtherViewer(props: Parameters<typeof Viewer>[0]) {
  return <Viewer {...props} />;
}

interface Doc {
  blocks: string[];
  /** Shown through OtherViewer, so a switch to or from it replaces the viewer. */
  otherViewer?: boolean;
  /** Has comments, so its page reserves the rail's gutter. */
  gutter?: boolean;
}

function doc(name: string, count: number, extra: Omit<Doc, 'blocks'> = {}): Doc {
  return { blocks: Array.from({ length: count }, (_, i) => `${name} block ${i}`), ...extra };
}

const NO_BLOCKS: string[] = [];

interface HarnessProps {
  docs: Record<string, Doc>;
  path: string | null;
  /** 'rendered' by default; null is the diff overlay. */
  view?: ReadingView | null;
  rendered?: boolean;
  yields?: () => boolean;
  /** No scroller mounted at all, so containerRef is null. */
  scrollerMissing?: boolean;
}

/**
 * The parts of App the hook depends on, in App's shape: the capture component,
 * a scroller the raw view and the rendered view each mount their own of, the
 * page whose width follows the document, and the viewer (or the diff overlay,
 * keyed by path) inside it.
 */
function Harness({
  docs,
  path,
  view = 'rendered',
  rendered = true,
  yields,
  scrollerMissing = false,
}: HarnessProps) {
  const containerRef = useRef<HTMLElement | null>(null);
  const blocksRef = useRef<HTMLDivElement | null>(null);
  const setScroller = useCallback((el: HTMLDivElement | null) => {
    containerRef.current = el;
    if (el) modelScroller(el);
  }, []);
  const getBlocks = useCallback(() => blocksRef.current, []);
  const capture = useScrollMemory({
    containerRef,
    getBlocks,
    activeFilePath: path,
    view,
    rendered,
    restoreYields: yields,
  });
  const current = path === null ? undefined : docs[path];
  const blocks = rendered && current ? current.blocks : NO_BLOCKS;
  return (
    <>
      <ReadingPositionCapture path={path} view={view} onLeave={capture} />
      {scrollerMissing ? null : view === 'raw' ? (
        // Keyed apart: RawView and the rendered view are different elements in
        // App, so each mounts a scroller of its own.
        <div key="raw" ref={setScroller} data-scroller="raw">
          {blocks.map((line, i) => (
            <div key={i} data-block>
              {line}
            </div>
          ))}
        </div>
      ) : (
        <div key="rendered" ref={setScroller} data-scroller="rendered">
          <div data-gutter={current?.gutter ? '' : undefined}>
            {view === null ? (
              <div key={path ?? ''}>
                {blocks.map((block, i) => (
                  <p key={i} data-block>
                    {block}
                  </p>
                ))}
              </div>
            ) : current?.otherViewer ? (
              <OtherViewer blocks={blocks} blocksRef={blocksRef} />
            ) : (
              <Viewer blocks={blocks} blocksRef={blocksRef} />
            )}
          </div>
        </div>
      )}
    </>
  );
}

function mount(props: HarnessProps) {
  const result = render(<Harness {...props} />);
  let last = props;
  return {
    /** The scroller on screen now (raw and rendered each have their own). */
    scroller: () => result.container.querySelector<HTMLElement>('[data-scroller]')!,
    update(next: Partial<HarnessProps>) {
      last = { ...last, ...next };
      result.rerender(<Harness {...last} />);
      // The browser lays out and paints the commit, which clamps the offset
      // to whatever the scroller now holds.
      void result.container.querySelector<HTMLElement>('[data-scroller]')?.scrollTop;
    },
    unmount: result.unmount,
  };
}

function saved(key = RENDERED_KEY) {
  return JSON.parse(sessionStorage.getItem(key) ?? 'null');
}

/** The anchor captureViewportAnchor records for block `index` of `name`. */
function anchorOn(name: string, index: number, offset: number) {
  const text = `${name} block ${index}`;
  return { key: `P:${text.length}:${text}`, ordinal: 0, offset };
}

describe('useScrollMemory', () => {
  beforeEach(() => {
    sessionStorage.clear();
    scrolls = [];
    layout.blockHeight = 100;
    Element.prototype.getBoundingClientRect = fakeRect;
  });

  // Each mounted hook listens for pagehide; unmount them so one test's
  // listeners do not write into the next test's store.
  afterEach(() => {
    cleanup();
    Element.prototype.getBoundingClientRect = originalRect;
  });

  it('returns to where the reader left a document', () => {
    const docs = { '/a.md': doc('a', 100), '/b.md': doc('b', 100) };
    const app = mount({ docs, path: '/a.md' });

    app.scroller().scrollTop = 1200;
    app.update({ path: '/b.md' });
    app.scroller().scrollTop = 300;
    app.update({ path: '/a.md' });

    expect(app.scroller().scrollTop).toBe(1200);
  });

  it('starts a document never visited at the top rather than inheriting an offset', () => {
    const docs = { '/long.md': doc('long', 100), '/other.md': doc('other', 100) };
    const app = mount({ docs, path: '/long.md' });

    app.scroller().scrollTop = 4000;
    app.update({ path: '/other.md' });

    expect(app.scroller().scrollTop).toBe(0);
  });

  it('saves the offset a reader had, not the one a shorter document clamps it to', () => {
    const docs = { '/long.md': doc('long', 100), '/short.md': doc('short', 2) };
    const app = mount({ docs, path: '/long.md' });

    app.scroller().scrollTop = 4000;
    app.update({ path: '/short.md' });
    expect(app.scroller().scrollTop).toBe(0);

    app.update({ path: '/long.md' });
    expect(app.scroller().scrollTop).toBe(4000);
  });

  it('saves the place the reader had when the switch replaces the viewer', () => {
    // React makes the swap, and every other DOM change of the commit, before
    // it runs the layout-effect cleanups of the component above (App), so a
    // save made there measured the arriving, empty viewer and kept { top: 0 }.
    // (Reproduced in the app with a Mermaid document, back when App gave
    // those a viewer of their own.)
    const docs = {
      '/a.md': doc('a', 100),
      '/diagram.md': doc('diagram', 100, { otherViewer: true }),
    };
    const app = mount({ docs, path: '/a.md' });

    app.scroller().scrollTop = 3050;
    app.update({ path: '/diagram.md' });
    expect(saved()['/a.md']).toEqual({ top: 3050, anchor: anchorOn('a', 30, -50) });

    app.scroller().scrollTop = 2020;
    app.update({ path: '/a.md' });
    expect(saved()['/diagram.md']).toEqual({ top: 2020, anchor: anchorOn('diagram', 20, -20) });
    expect(app.scroller().scrollTop).toBe(3050);

    app.update({ path: '/diagram.md' });
    expect(app.scroller().scrollTop).toBe(2020);
  });

  it('saves the block the reader was on before the switch reflows the column', () => {
    // Only the arriving document has comments, so its page reserves the rail's
    // gutter and the column narrows in the same commit. Read after that, the
    // outgoing document's blocks have rewrapped under the same offset and a
    // different block is at the top.
    const docs = { '/a.md': doc('a', 100), '/b.md': doc('b', 100, { gutter: true }) };
    const app = mount({ docs, path: '/a.md' });

    app.scroller().scrollTop = 3050;
    app.update({ path: '/b.md' });

    expect(saved()['/a.md']).toEqual({ top: 3050, anchor: anchorOn('a', 30, -50) });
  });

  it('saves the live scroller after a Raw/Rendered toggle', () => {
    // Each view mounts its own scroller, so the one the document was
    // activated in is detached after a round trip through raw view.
    const docs = { '/a.md': doc('a', 100), '/b.md': doc('b', 100) };
    const app = mount({ docs, path: '/a.md' });

    app.update({ view: 'raw' });
    app.update({ view: 'rendered' });
    app.scroller().scrollTop = 3050;
    app.update({ path: '/b.md' });

    expect(saved()['/a.md']).toEqual({ top: 3050, anchor: anchorOn('a', 30, -50) });
    app.update({ path: '/a.md' });
    expect(app.scroller().scrollTop).toBe(3050);
  });

  it('keeps raw and rendered positions apart', () => {
    const docs = { '/a.md': doc('a', 100), '/b.md': doc('b', 100) };
    const app = mount({ docs, path: '/a.md' });

    app.scroller().scrollTop = 3050;
    app.update({ path: '/b.md' });
    app.update({ view: 'raw' });
    // /a.md has no raw position yet: it opens at the top of the raw view.
    app.update({ path: '/a.md' });
    expect(app.scroller().scrollTop).toBe(0);
    app.scroller().scrollTop = 700;
    app.update({ path: '/b.md' });

    expect(saved(RAW_KEY)['/a.md']).toEqual({ top: 700 });
    expect(saved()['/a.md']).toEqual({ top: 3050, anchor: anchorOn('a', 30, -50) });

    // Back in the rendered view, /a.md returns to its rendered place, not the
    // raw view's offset.
    app.update({ view: 'rendered' });
    app.update({ path: '/a.md' });
    expect(app.scroller().scrollTop).toBe(3050);
    app.update({ path: '/b.md', view: 'raw' });
    app.update({ path: '/a.md' });
    expect(app.scroller().scrollTop).toBe(700);
  });

  it('saves the view being left on a Raw/Rendered toggle, and opens the other at the top', () => {
    const docs = { '/a.md': doc('a', 100) };
    const app = mount({ docs, path: '/a.md' });

    app.scroller().scrollTop = 3050;
    app.update({ view: 'raw' });

    expect(saved()['/a.md']).toEqual({ top: 3050, anchor: anchorOn('a', 30, -50) });
    expect(app.scroller().scrollTop).toBe(0);
  });

  it('does not save the diff overlay over the document position', () => {
    const docs = { '/a.md': doc('a', 100), '/b.md': doc('b', 100) };
    const app = mount({ docs, path: '/a.md' });

    app.scroller().scrollTop = 3050;
    app.update({ view: null });
    // Wherever the overlay takes the reader, it is not their place in /a.md.
    app.scroller().scrollTop = 6000;
    app.update({ path: '/b.md', view: 'rendered' });

    expect(saved()['/a.md']).toEqual({ top: 3050, anchor: anchorOn('a', 30, -50) });
  });

  it('returns to the place the diff covered when the diff closes', () => {
    // The diff scrolls to its first change on open, and the reader may scroll
    // it anywhere. Closing it is an arrival back in the view underneath.
    const docs = { '/a.md': doc('a', 100), '/b.md': doc('b', 100) };
    const app = mount({ docs, path: '/a.md' });

    app.scroller().scrollTop = 3050;
    app.update({ view: null });
    app.scroller().scrollTop = 6000;
    app.update({ view: 'rendered' });

    expect(app.scroller().scrollTop).toBe(3050);
    // And leaving now saves that place, not the diff's.
    app.update({ path: '/b.md' });
    expect(saved()['/a.md']).toEqual({ top: 3050, anchor: anchorOn('a', 30, -50) });
  });

  it('holds a restore that arrives under the diff overlay for the view beneath it', () => {
    // App turns the overlay off a render after a tab switch, so the arriving
    // document can spend its first commit under it.
    const docs = { '/a.md': doc('a', 100), '/b.md': doc('b', 100) };
    const app = mount({ docs, path: '/a.md' });

    app.scroller().scrollTop = 3050;
    app.update({ path: '/b.md' });
    app.update({ path: '/a.md', view: null });
    expect(app.scroller().scrollTop).toBe(0);

    app.update({ view: 'rendered' });
    expect(app.scroller().scrollTop).toBe(3050);
  });

  it('waits to restore a document that is still on its first load', () => {
    const docs = { '/a.md': doc('a', 100), '/b.md': doc('b', 100) };
    const app = mount({ docs, path: '/a.md' });

    app.scroller().scrollTop = 2500;
    app.update({ path: '/b.md' });

    // Back to /a.md before its body has arrived.
    app.update({ path: '/a.md', rendered: false });
    expect(app.scroller().scrollTop).toBe(0);

    // The body renders.
    app.update({ rendered: true });
    expect(app.scroller().scrollTop).toBe(2500);

    // Every restore flips straight to the offset: the mount, the switch to
    // /b.md, and the return to /a.md once it rendered.
    expect(scrolls).toEqual(['instant', 'instant', 'instant']);
  });

  it('saves the target of a restore still waiting for its document', () => {
    const docs = { '/a.md': doc('a', 100), '/b.md': doc('b', 100) };
    const app = mount({ docs, path: '/a.md' });

    app.scroller().scrollTop = 2500;
    app.update({ path: '/b.md' });
    app.update({ path: '/a.md', rendered: false });
    // Leave /a.md before it has rendered: its place is still 2500, not the
    // top of the empty sheet the reader saw.
    app.update({ path: '/b.md', rendered: true });

    expect(saved()['/a.md']).toEqual({ top: 2500, anchor: anchorOn('a', 25, 0) });
    window.dispatchEvent(new Event('pagehide'));
    app.update({ path: '/a.md' });
    expect(app.scroller().scrollTop).toBe(2500);
  });

  /**
   * Leave /a.md at 2500 and come back to a version cut to 15 blocks (1000px of
   * scroll) while it was in the background: the restore clamps to the bottom.
   */
  function returnToShortenedDocument() {
    const docs: Record<string, Doc> = { '/a.md': doc('a', 100), '/b.md': doc('b', 100) };
    const app = mount({ docs, path: '/a.md' });
    app.scroller().scrollTop = 2500;
    app.update({ path: '/b.md' });
    docs['/a.md'] = doc('cut', 15);
    app.update({ docs: { ...docs }, path: '/a.md' });
    expect(app.scroller().scrollTop).toBe(1000);
    return { app, docs };
  }

  it('does not retry a restore that could not land when the document changes again', () => {
    const { app, docs } = returnToShortenedDocument();

    app.scroller().scrollTop = 300;
    app.update({ docs: { ...docs, '/a.md': doc('cut', 16) } });

    expect(app.scroller().scrollTop).toBe(300);
  });

  it('saves where the reader scrolled after a restore that could not land', () => {
    const { app } = returnToShortenedDocument();

    app.scroller().scrollTop = 300;
    app.update({ path: '/b.md' });

    expect(saved()['/a.md']).toMatchObject({ top: 300 });
  });

  it('leaves the reader alone when the same document re-renders', () => {
    const docs = { '/a.md': doc('a', 100) };
    const app = mount({ docs, path: '/a.md' });

    app.scroller().scrollTop = 900;
    app.update({ docs: { '/a.md': doc('a', 101) } });

    expect(app.scroller().scrollTop).toBe(900);
    // Only the mount restore; the re-render asks for no scroll at all.
    expect(scrolls).toEqual(['instant']);
  });

  it('does not restore again when the find bar opens on the same document', () => {
    // App hands over a new restoreYields whenever the find bar opens or its
    // query changes, which re-runs the restore effect. The restore already
    // ran for this document; running it again would pull the reader back to
    // where the document opened.
    const docs = { '/a.md': doc('a', 100), '/b.md': doc('b', 100) };
    const app = mount({ docs, path: '/a.md', yields: () => false });
    app.scroller().scrollTop = 3050;
    app.update({ path: '/b.md' });
    app.update({ path: '/a.md' });
    expect(app.scroller().scrollTop).toBe(3050);

    app.scroller().scrollTop = 900;
    app.update({ yields: () => false });

    expect(app.scroller().scrollTop).toBe(900);
  });

  it('keeps saving a document whose restore found no scroller', () => {
    // The restore is spent either way. Left owed, it would make every later
    // save of this document keep the stored position instead of the reader's.
    const docs = { '/a.md': doc('a', 100), '/b.md': doc('b', 100) };
    const app = mount({ docs, path: '/a.md' });
    app.scroller().scrollTop = 3050;
    app.update({ path: '/b.md' });
    app.update({ path: '/a.md', scrollerMissing: true });

    app.update({ scrollerMissing: false });
    app.scroller().scrollTop = 700;
    app.update({ path: '/b.md' });

    expect(saved()['/a.md']).toEqual({ top: 700, anchor: anchorOn('a', 7, 0) });
  });

  it('hands the arriving document to a scroll already under way', () => {
    // The find bar's jump to its match, started by the viewer before this
    // restore runs. A later render does not restore it after all.
    const docs = { '/a.md': doc('a', 100), '/b.md': doc('b', 100) };
    let searching = false;
    const yields = () => searching;
    const app = mount({ docs, path: '/a.md', yields });

    app.scroller().scrollTop = 3050;
    app.update({ path: '/b.md' });
    app.scroller().scrollTop = 1000;
    searching = true;
    scrolls = [];
    app.update({ path: '/a.md' });

    expect(scrolls).toEqual([]);
    expect(app.scroller().scrollTop).toBe(1000);
    searching = false;
    app.update({ docs: { ...docs } });
    expect(app.scroller().scrollTop).toBe(1000);
  });

  it('restores a document reopened after its tab was the last one closed', () => {
    const docs = { '/a.md': doc('a', 100) };
    const app = mount({ docs, path: '/a.md' });

    app.scroller().scrollTop = 3050;
    app.update({ path: null });
    app.update({ path: '/a.md' });

    expect(app.scroller().scrollTop).toBe(3050);
  });

  it('writes the position it leaves to sessionStorage, under the file path', () => {
    const docs = { '/a.md': doc('a', 100), '/b.md': doc('b', 100) };
    const app = mount({ docs, path: '/a.md' });

    app.scroller().scrollTop = 1800;
    app.update({ path: '/b.md' });

    expect(saved()).toEqual({ '/a.md': { top: 1800, anchor: anchorOn('a', 18, 0) } });
  });

  it('saves the active document on pagehide, which a refresh fires without a switch', () => {
    const docs = { '/a.md': doc('a', 100) };
    const app = mount({ docs, path: '/a.md' });

    app.update({ view: 'raw' });
    app.scroller().scrollTop = 700;
    window.dispatchEvent(new Event('pagehide'));

    expect(saved(RAW_KEY)).toEqual({ '/a.md': { top: 700 } });
  });

  it('saves the active document when the page is hidden, from the scroller on screen', () => {
    // A background tab can be discarded without a pagehide. The toggles leave
    // the scroller the document was activated in detached.
    const docs = { '/a.md': doc('a', 100) };
    const app = mount({ docs, path: '/a.md' });
    app.update({ view: 'raw' });
    app.update({ view: 'rendered' });
    app.scroller().scrollTop = 3050;

    const visibility = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState')!;
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    try {
      document.dispatchEvent(new Event('visibilitychange'));
    } finally {
      Object.defineProperty(document, 'visibilityState', visibility);
    }

    expect(saved()['/a.md']).toEqual({ top: 3050, anchor: anchorOn('a', 30, -50) });
  });

  it('restores a position that only sessionStorage has', () => {
    // What a refresh mid-review leaves behind: the store, and nothing in
    // memory. A hook that never saw the reader scroll still has to find it.
    sessionStorage.setItem(RENDERED_KEY, JSON.stringify({ '/a.md': { top: 1800 } }));
    const app = mount({ docs: { '/a.md': doc('a', 100) }, path: '/a.md' });

    expect(app.scroller().scrollTop).toBe(1800);
  });

  it('starts at the top when the stored positions are unreadable', () => {
    sessionStorage.setItem(RENDERED_KEY, 'not json');
    const docs = { '/a.md': doc('a', 100), '/b.md': doc('b', 100) };
    const app = mount({ docs, path: '/a.md' });

    app.scroller().scrollTop = 600;
    app.update({ path: '/b.md' });

    expect(app.scroller().scrollTop).toBe(0);
  });

  it('returns to the same block after the document reflows', () => {
    const docs = { '/a.md': doc('a', 60), '/b.md': doc('b', 60) };
    const app = mount({ docs, path: '/a.md' });

    // Block 12 is 50px above the viewport top.
    app.scroller().scrollTop = 1250;
    app.update({ path: '/b.md' });

    // Everything reflows while /a.md is away (a resize, a font change).
    layout.blockHeight = 150;
    app.update({ path: '/a.md' });

    // Block 12 back at -50px, not the old pixel offset 1250.
    expect(app.scroller().scrollTop).toBe(12 * 150 + 50);
  });

  it('returns to the same block on a reload after a reflow', () => {
    const docs = { '/a.md': doc('a', 60) };
    const app = mount({ docs, path: '/a.md' });

    app.scroller().scrollTop = 1250;
    window.dispatchEvent(new Event('pagehide'));
    app.unmount();

    // The reloaded page lays the document out differently.
    layout.blockHeight = 80;
    const reloaded = mount({ docs, path: '/a.md' });

    expect(reloaded.scroller().scrollTop).toBe(12 * 80 + 50);
  });

  it('falls back to the pixel offset when the saved block is gone', () => {
    const docs = { '/a.md': doc('a', 60), '/b.md': doc('b', 60) };
    const app = mount({ docs, path: '/a.md' });

    app.scroller().scrollTop = 1250;
    app.update({ path: '/b.md' });

    // /a.md comes back rewritten: none of its blocks match.
    app.update({ docs: { ...docs, '/a.md': doc('rewritten', 60) }, path: '/a.md' });

    expect(app.scroller().scrollTop).toBe(1250);
  });
});
