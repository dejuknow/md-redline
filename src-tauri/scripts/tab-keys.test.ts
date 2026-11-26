// @vitest-environment jsdom
import { readFileSync } from 'fs';
import { join } from 'path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// The desktop shell injects this script on Windows and Linux. Run it once in
// jsdom (it only adds a listener) and drive it with real key events.
const SCRIPT = readFileSync(join(__dirname, 'tab-keys.js'), 'utf8');

function press(init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  document.body.dispatchEvent(event);
  return event;
}

describe('desktop shell tab keys (Windows, Linux)', () => {
  const newTab = vi.fn();
  const close = vi.fn(() => true);
  const reopen = vi.fn(() => true);

  beforeAll(() => {
    new Function(SCRIPT)();
  });

  afterEach(() => {
    newTab.mockClear();
    close.mockClear();
    reopen.mockClear();
    delete window.__mdrNewTab;
    delete window.__mdrCloseActiveTab;
    delete window.__mdrReopenClosedTab;
  });

  function withHooks() {
    window.__mdrNewTab = newTab;
    window.__mdrCloseActiveTab = close;
    window.__mdrReopenClosedTab = reopen;
  }

  it('Ctrl+T opens a new tab', () => {
    withHooks();
    const event = press({ key: 't', ctrlKey: true });
    expect(newTab).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();
    expect(reopen).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
  });

  it('Ctrl+W closes the active tab', () => {
    withHooks();
    const event = press({ key: 'w', ctrlKey: true });
    expect(close).toHaveBeenCalledOnce();
    expect(reopen).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
  });

  it('Ctrl+Shift+T reopens the last closed tab', () => {
    withHooks();
    const event = press({ key: 'T', ctrlKey: true, shiftKey: true });
    expect(reopen).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();
    expect(newTab).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
  });

  it('leaves other combinations alone', () => {
    withHooks();
    for (const init of [
      { key: 't', metaKey: true },
      { key: 't', ctrlKey: true, altKey: true },
      { key: 'W', ctrlKey: true, shiftKey: true },
      { key: 'w', metaKey: true },
      { key: 'w', ctrlKey: true, altKey: true },
      { key: 'T', ctrlKey: true, shiftKey: true, metaKey: true },
      { key: 'w' },
    ]) {
      expect(press(init).defaultPrevented).toBe(false);
    }
    expect(newTab).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    expect(reopen).not.toHaveBeenCalled();
  });

  it('does not throw while the app is not loaded', () => {
    expect(() => press({ key: 't', ctrlKey: true })).not.toThrow();
    expect(() => press({ key: 'w', ctrlKey: true })).not.toThrow();
    expect(() => press({ key: 'T', ctrlKey: true, shiftKey: true })).not.toThrow();
  });
});
