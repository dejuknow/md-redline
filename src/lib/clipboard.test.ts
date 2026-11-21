// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeTextWhenReady } from './clipboard';

class FakeClipboardItem {
  readonly items: Record<string, Promise<Blob>>;
  constructor(items: Record<string, Promise<Blob>>) {
    this.items = items;
  }
}

function deferred() {
  let resolve: (ok: boolean) => void = () => {};
  const promise = new Promise<boolean>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('writeTextWhenReady', () => {
  let write: ReturnType<typeof vi.fn>;
  let writeText: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // Behaves like a clipboard: reads the item's content, failing if it rejects.
    write = vi.fn(async ([item]: FakeClipboardItem[]) => {
      await item.items['text/plain'];
    });
    writeText = vi.fn(async () => {});
    vi.stubGlobal('ClipboardItem', FakeClipboardItem);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { write, writeText },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Safari refuses a write that starts after an await (#226): the write must
  // begin before `ready` settles.
  it('starts the write before ready settles, with the text once it does', async () => {
    const ready = deferred();
    const result = writeTextWhenReady('the prompt', ready.promise);

    expect(write).toHaveBeenCalledTimes(1);
    ready.resolve(true);
    expect(await result).toBe('copied');
    const blob = await (write.mock.calls[0][0][0] as FakeClipboardItem).items['text/plain'];
    expect(await blob.text()).toBe('the prompt');
    expect(writeText).not.toHaveBeenCalled();
  });

  it('copies nothing and reports not-ready when ready resolves false', async () => {
    const ready = deferred();
    const result = writeTextWhenReady('the prompt', ready.promise);
    ready.resolve(false);
    expect(await result).toBe('not-ready');
    expect(writeText).not.toHaveBeenCalled();
  });

  it('falls back to writeText when the clipboard refuses a promised item', async () => {
    write.mockRejectedValueOnce(new TypeError('promises not supported'));
    expect(await writeTextWhenReady('the prompt', Promise.resolve(true))).toBe('copied');
    expect(writeText).toHaveBeenCalledWith('the prompt');
  });

  it('reports failed when the clipboard refuses both writes', async () => {
    write.mockRejectedValueOnce(new DOMException('denied', 'NotAllowedError'));
    writeText.mockRejectedValueOnce(new DOMException('denied', 'NotAllowedError'));
    expect(await writeTextWhenReady('the prompt', Promise.resolve(true))).toBe('failed');
  });

  // An engine that resolves the write before reading the item must not turn
  // a failed save into a copy.
  it('reports not-ready when the write resolved but ready resolves false', async () => {
    write.mockResolvedValueOnce(undefined);
    expect(await writeTextWhenReady('the prompt', Promise.resolve(false))).toBe('not-ready');
  });

  // The clipboard can refuse before it reads the content; a save that then
  // fails has its own toast, so it is not also a copy error.
  it('reports not-ready when the clipboard refused early and ready then resolves false', async () => {
    write.mockRejectedValueOnce(new DOMException('denied', 'NotAllowedError'));
    const ready = deferred();
    const result = writeTextWhenReady('the prompt', ready.promise);
    ready.resolve(false);
    expect(await result).toBe('not-ready');
  });

  it('falls back to writeText after ready where ClipboardItem is missing', async () => {
    vi.stubGlobal('ClipboardItem', undefined);
    const ready = deferred();
    const result = writeTextWhenReady('the prompt', ready.promise);
    expect(writeText).not.toHaveBeenCalled();
    ready.resolve(true);
    expect(await result).toBe('copied');
    expect(writeText).toHaveBeenCalledWith('the prompt');
  });

  it('skips the fallback write when ready resolves false', async () => {
    vi.stubGlobal('ClipboardItem', undefined);
    expect(await writeTextWhenReady('the prompt', Promise.resolve(false))).toBe('not-ready');
    expect(writeText).not.toHaveBeenCalled();
  });
});
