export type DeferredCopyResult = 'copied' | 'not-ready' | 'failed';

/**
 * Write `text` to the clipboard once `ready` resolves true, starting the write
 * now. Safari refuses a clipboard write that begins after an await, outside the
 * click's own task (#226), so the write starts at the click with a
 * `ClipboardItem` whose content is a promise that settles once `ready` does.
 *
 * - `'copied'`: the text reached the clipboard.
 * - `'not-ready'`: `ready` resolved false, so nothing was copied. Whoever
 *   resolved it false has already said why.
 * - `'failed'`: the clipboard refused the write.
 *
 * Where `ClipboardItem` is missing, this waits for `ready` and falls back to
 * `writeText`, which browsers without it accept after a short wait.
 */
export async function writeTextWhenReady(
  text: string,
  ready: Promise<boolean>,
): Promise<DeferredCopyResult> {
  const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
  if (typeof ClipboardItem === 'undefined' || typeof clipboard?.write !== 'function') {
    let ok: boolean;
    try {
      ok = await ready;
    } catch {
      return 'failed';
    }
    if (!ok) return 'not-ready';
    try {
      await clipboard?.writeText(text);
      return clipboard ? 'copied' : 'failed';
    } catch {
      return 'failed';
    }
  }

  const blob = ready.then((ok) => {
    if (!ok) throw new Error('not ready');
    return new Blob([text], { type: 'text/plain' });
  });
  // The clipboard may reject before it reads the blob; that rejection is
  // reported below, not left unhandled.
  blob.catch(() => {});
  let written = true;
  try {
    await clipboard.write([new ClipboardItem({ 'text/plain': blob })]);
  } catch {
    written = false;
  }
  // The write can settle before `ready` does, so wait for it: a save that
  // failed is 'not-ready' (its toast already said why), not a copy.
  let ok: boolean;
  try {
    ok = await ready;
  } catch {
    return 'failed';
  }
  if (!ok) return 'not-ready';
  if (written) return 'copied';
  // A browser that has ClipboardItem but refuses a promise for its content
  // may still take plain text now that the wait is over.
  try {
    await clipboard.writeText(text);
    return 'copied';
  } catch {
    return 'failed';
  }
}
