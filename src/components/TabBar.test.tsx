// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import { TabBar } from './TabBar';

// jsdom has no ResizeObserver. TabBar watches the tab strip's scrollport and
// its content row, so every test here needs a stub. The stub models the two
// behaviours the component depends on: observe() delivers an initial
// observation, and disconnect() stops delivery. Without the initial delivery a
// test cannot tell "the observer was rebuilt" from "someone fired it by hand",
// which is exactly the distinction the cold-boot retry rests on.
let observers: ResizeObserverStub[] = [];
class ResizeObserverStub {
  callback: () => void;
  connected = true;
  constructor(callback: () => void) {
    this.callback = callback;
    observers.push(this);
  }
  observe() {
    if (this.connected) this.callback();
  }
  unobserve() {}
  disconnect() {
    this.connected = false;
  }
}

/** Let the alignment effect's requestAnimationFrame run. */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 40));
  });
}

/** A resize of an already-observed element, as opposed to a fresh observe(). */
function fireResize() {
  act(() => {
    for (const observer of observers) {
      if (observer.connected) observer.callback();
    }
  });
}

// jsdom reports every rect as zero, so the width the component reads has to be
// driven directly. It is set before the first render so a test can hold the
// width CONSTANT across an observer rebuild.
let viewportWidth = 600;

const TABS = ['/docs/one.md', '/docs/two.md', '/docs/three.md'].map((filePath) => ({
  filePath,
  error: null,
}));

function renderTabBar(activeFilePath: string, tabs = TABS) {
  const props = {
    tabs,
    activeFilePath,
    commentCounts: new Map<string, number>(),
    onSwitchTab: () => {},
    onCloseTab: () => {},
    onOpenFile: () => {},
  };
  const { rerender } = render(<TabBar {...props} />);
  return {
    setTabs: (next: typeof TABS) => act(() => rerender(<TabBar {...props} tabs={next} />)),
  };
}

beforeEach(() => {
  observers = [];
  viewportWidth = 600;
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(
    () =>
      ({
        width: viewportWidth,
        height: 0,
        top: 0,
        left: 0,
        right: viewportWidth,
        bottom: 0,
        x: 0,
        y: 0,
      }) as DOMRect,
  );
  // jsdom does not implement scrollIntoView; the component calls it to bring
  // the active tab into view.
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  // @ts-expect-error - test-only cleanup of the jsdom stub
  delete Element.prototype.scrollIntoView;
});

describe('TabBar: keeping the active tab in view', () => {
  it('re-aligns the active tab when the scrollport narrows', () => {
    renderTabBar('/docs/two.md');
    vi.mocked(Element.prototype.scrollIntoView).mockClear();

    // The overflow arrows mount, or the explorer opens, and the strip loses
    // width after the tab was already scrolled into place.
    viewportWidth = 400;
    fireResize();

    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
  });

  it('leaves the scroll position alone when only the content grows', () => {
    renderTabBar('/docs/two.md');
    vi.mocked(Element.prototype.scrollIntoView).mockClear();

    // The observer also watches the content row, so it fires when a comment
    // badge appears on a tab. Re-aligning here would yank the strip back to
    // the active tab while the user is reading another one.
    fireResize();

    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
  });

  it('re-aligns once the active tab mounts, at an unchanged width', () => {
    // Cold boot: the strip renders before the restored tabs arrive, so the
    // first observation finds nothing to align. Two things have to hold for
    // the tab to end up aligned anyway, and the width never changes across
    // them, so nothing else can account for the alignment: the width must not
    // be recorded when no alignment ran, and the observer must be rebuilt when
    // the tabs arrive so it delivers a fresh observation.
    const { setTabs } = renderTabBar('/docs/two.md', []);
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();

    setTabs(TABS);

    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
  });

  it('leaves the strip alone when a tab opens in the background', async () => {
    // The retry above deliberately lives in the resize effect rather than the
    // alignment effect. Moving it to the alignment effect reads as simpler and
    // states its trigger more directly, but that effect re-aligns
    // unconditionally, so every background open (an agent opening a file, a
    // review session restoring tabs) would pull the strip off whatever the
    // user is reading.
    const { setTabs } = renderTabBar('/docs/two.md');
    await settle();
    vi.mocked(Element.prototype.scrollIntoView).mockClear();

    setTabs([...TABS, { filePath: '/docs/four.md', error: null }]);
    await settle();

    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
  });
});
