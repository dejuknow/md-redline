// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act, waitFor } from '@testing-library/react';
import { FileExplorer } from './FileExplorer';

interface BrowseResult {
  dir: string;
  parent: string | null;
  directories: { name: string; path: string }[];
  files: { name: string; path: string }[];
}

function browseResult(overrides: Partial<BrowseResult> = {}): BrowseResult {
  return {
    dir: '/docs',
    parent: '/',
    directories: [],
    files: [
      { name: 'a.md', path: '/docs/a.md' },
      { name: 'b.md', path: '/docs/b.md' },
      { name: 'c.md', path: '/docs/c.md' },
    ],
    ...overrides,
  };
}

function mockFetchResolving(result: BrowseResult) {
  return vi.fn().mockResolvedValue({
    ok: true,
    text: () => Promise.resolve(JSON.stringify(result)),
  });
}

// RTL's findBy*/waitFor poll via setTimeout, which fake timers freeze. Under
// fake timers, flush the microtask queue by hand instead so the component's
// fetch -> readJsonResponse -> setData chain settles before we assert.
async function flushMicrotasks() {
  await act(async () => {
    for (let i = 0; i < 5; i++) {
      await Promise.resolve();
    }
  });
}

// The inactive rows carry `hover:bg-tint`, so a plain substring check for
// "bg-tint" would false-positive on every non-flashed row. Check for the
// bare class token the flash applies instead.
function hasClass(el: Element, cls: string): boolean {
  return el.className.split(/\s+/).includes(cls);
}

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetchResolving(browseResult()));
  // jsdom does not implement scrollIntoView; the component calls it
  // unconditionally on every reveal/active-file effect run.
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  // @ts-expect-error - test-only cleanup of the jsdom stub
  delete Element.prototype.scrollIntoView;
});

describe('FileExplorer: revealNonce forces a re-browse', () => {
  it('re-browses the same initialDir when revealNonce changes', async () => {
    const { rerender } = render(
      <FileExplorer
        initialDir="/docs"
        revealNonce={0}
        activeFilePath={null}
        onOpenFile={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    await screen.findByText('a.md');
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);

    rerender(
      <FileExplorer
        initialDir="/docs"
        revealNonce={1}
        activeFilePath={null}
        onOpenFile={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(2));
    const lastCall = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.at(-1);
    expect(String(lastCall?.[0])).toContain(encodeURIComponent('/docs'));
  });
});

describe('FileExplorer: reveal flash', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('flashes a revealed file that is not the active file, then clears the flash', async () => {
    render(
      <FileExplorer
        initialDir="/docs"
        revealNonce={1}
        revealPath="/docs/b.md"
        activeFilePath="/docs/a.md"
        onOpenFile={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    await flushMicrotasks();

    const bButton = screen.getByTitle('/docs/b.md');
    expect(hasClass(bButton, 'bg-tint')).toBe(true);
    expect(hasClass(bButton, 'font-medium')).toBe(true);

    await act(async () => {
      vi.advanceTimersByTime(1600);
    });

    expect(hasClass(bButton, 'bg-tint')).toBe(false);
  });
});

describe('FileExplorer: reveal edge cases', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('scrolls without flashing when the revealed file is already the active one', async () => {
    render(
      <FileExplorer
        initialDir="/docs"
        revealNonce={1}
        revealPath="/docs/b.md"
        activeFilePath="/docs/b.md"
        onOpenFile={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    await flushMicrotasks();

    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
    expect(hasClass(screen.getByTitle('/docs/b.md'), 'bg-tint')).toBe(false);
  });

  it('keeps scrolling to the active file after revealing that same file', async () => {
    // The revealed row is also the active row here. If it claimed only the
    // reveal ref, the active ref would stay null and later listings would
    // scroll to nothing at all.
    const scrollIntoView = Element.prototype.scrollIntoView as ReturnType<typeof vi.fn>;
    const { rerender } = render(
      <FileExplorer
        initialDir="/docs"
        revealNonce={1}
        revealPath="/docs/b.md"
        activeFilePath="/docs/b.md"
        onOpenFile={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    await flushMicrotasks();
    scrollIntoView.mockClear();

    // Navigate away and back: a fresh listing with the reveal already spent.
    rerender(
      <FileExplorer
        initialDir="/other"
        revealNonce={1}
        revealPath="/docs/b.md"
        activeFilePath="/docs/b.md"
        onOpenFile={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    await flushMicrotasks();

    expect(scrollIntoView).toHaveBeenCalled();
    expect(scrollIntoView.mock.instances.at(-1)).toBe(screen.getByTitle('/docs/b.md'));
  });

  it('does not re-fire a spent reveal when the panel remounts', async () => {
    // The panel unmounts on a sidebar toggle, an Outline switch, or entering
    // focus mode. Consumption is owned by the caller so it survives that.
    let consumed: number | null = null;
    const props = {
      initialDir: '/docs',
      revealNonce: 1,
      revealPath: '/docs/b.md',
      activeFilePath: '/docs/a.md',
      onOpenFile: vi.fn(),
      onClose: vi.fn(),
      onRevealConsumed: (nonce: number) => {
        consumed = nonce;
      },
    };

    const first = render(<FileExplorer {...props} revealConsumedNonce={consumed} />);
    await flushMicrotasks();
    expect(hasClass(screen.getByTitle('/docs/b.md'), 'bg-tint')).toBe(true);
    expect(consumed).toBe(1);
    await act(async () => {
      vi.advanceTimersByTime(1600);
    });
    first.unmount();

    render(<FileExplorer {...props} revealConsumedNonce={consumed} />);
    await flushMicrotasks();
    expect(hasClass(screen.getByTitle('/docs/b.md'), 'bg-tint')).toBe(false);
  });

  it('reveals a file that only exists in the refreshed listing', async () => {
    // Revealing into the directory already on screen runs the effect against
    // the stale listing first. Retiring there would drop the reveal of a file
    // the forced refresh is about to add.
    let call = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => {
        call += 1;
        const body =
          call === 1
            ? browseResult({ files: [{ name: 'a.md', path: '/docs/a.md' }] })
            : browseResult({
                files: [
                  { name: 'a.md', path: '/docs/a.md' },
                  { name: 'new.md', path: '/docs/new.md' },
                ],
              });
        return Promise.resolve({ ok: true, text: () => Promise.resolve(JSON.stringify(body)) });
      }),
    );

    const props = {
      initialDir: '/docs',
      activeFilePath: '/docs/a.md',
      onOpenFile: vi.fn(),
      onClose: vi.fn(),
    };
    const { rerender } = render(<FileExplorer {...props} revealNonce={0} />);
    await flushMicrotasks();
    expect(screen.queryByTitle('/docs/new.md')).toBeNull();

    rerender(<FileExplorer {...props} revealNonce={1} revealPath="/docs/new.md" />);
    await flushMicrotasks();

    const row = screen.getByTitle('/docs/new.md');
    expect(hasClass(row, 'bg-tint')).toBe(true);
  });

  it('retires a reveal whose target is missing from its own directory listing', async () => {
    const { rerender } = render(
      <FileExplorer
        initialDir="/docs"
        revealNonce={1}
        revealPath="/docs/gone.md"
        activeFilePath="/docs/a.md"
        onOpenFile={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    await flushMicrotasks();
    expect(screen.queryByTitle('/docs/gone.md')).toBeNull();

    // The file reappears in a later listing under the SAME nonce. The reveal
    // was already spent, so it must not scroll to or flash the row now.
    vi.stubGlobal(
      'fetch',
      mockFetchResolving(
        browseResult({
          files: [
            { name: 'a.md', path: '/docs/a.md' },
            { name: 'gone.md', path: '/docs/gone.md' },
          ],
        }),
      ),
    );
    rerender(
      <FileExplorer
        initialDir="/docs2"
        revealNonce={1}
        revealPath="/docs/gone.md"
        activeFilePath="/docs/a.md"
        onOpenFile={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    await flushMicrotasks();

    const revived = screen.queryByTitle('/docs/gone.md');
    expect(revived).not.toBeNull();
    expect(hasClass(revived!, 'bg-tint')).toBe(false);
  });
});

describe('FileExplorer: stale reveal does not hijack later activity (regression)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('clears the flash when another file opens before the timer expires', async () => {
    // The flash timer used to live in the reveal effect, whose cleanup ran on
    // any dep change while the effect body then short-circuited on the already
    // consumed nonce — leaving the row highlighted for good.
    const { rerender } = render(
      <FileExplorer
        initialDir="/docs"
        revealNonce={1}
        revealPath="/docs/a.md"
        activeFilePath="/docs/b.md"
        onOpenFile={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    await flushMicrotasks();
    expect(hasClass(screen.getByTitle('/docs/a.md'), 'bg-tint')).toBe(true);

    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    rerender(
      <FileExplorer
        initialDir="/docs"
        revealNonce={1}
        revealPath="/docs/a.md"
        activeFilePath="/docs/c.md"
        onOpenFile={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    await flushMicrotasks();

    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    expect(hasClass(screen.getByTitle('/docs/a.md'), 'bg-tint')).toBe(false);
  });

  it('does not re-flash the previously revealed file when only activeFilePath changes', async () => {
    const scrollIntoView = Element.prototype.scrollIntoView as ReturnType<typeof vi.fn>;

    const { rerender } = render(
      <FileExplorer
        initialDir="/docs"
        revealNonce={1}
        revealPath="/docs/a.md"
        activeFilePath="/docs/b.md"
        onOpenFile={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    await flushMicrotasks();

    const aButton = screen.getByTitle('/docs/a.md');
    expect(hasClass(aButton, 'bg-tint')).toBe(true);
    expect(scrollIntoView).toHaveBeenCalled();
    scrollIntoView.mockClear();

    // Let the reveal's own flash timer expire, as it would in real usage
    // before the user goes on to open another file.
    await act(async () => {
      vi.advanceTimersByTime(1600);
    });
    expect(hasClass(aButton, 'bg-tint')).toBe(false);

    rerender(
      <FileExplorer
        initialDir="/docs"
        revealNonce={1}
        revealPath="/docs/a.md"
        activeFilePath="/docs/c.md"
        onOpenFile={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    await flushMicrotasks();

    const cButton = screen.getByTitle('/docs/c.md');
    expect(hasClass(cButton, 'bg-primary-bg')).toBe(true);

    const aButtonAgain = screen.getByTitle('/docs/a.md');
    expect(hasClass(aButtonAgain, 'bg-tint')).toBe(false);

    // Give any (incorrectly) re-armed flash timer a chance to fire, then
    // re-check: the stale reveal must not have re-triggered a flash at all.
    await act(async () => {
      vi.advanceTimersByTime(1600);
    });
    expect(hasClass(screen.getByTitle('/docs/a.md'), 'bg-tint')).toBe(false);

    expect(scrollIntoView).toHaveBeenCalled();
    // scrollIntoView is a method call on the element itself (`this`), not an arg.
    expect(scrollIntoView.mock.instances.at(-1)).toBe(cButton);
  });
});
