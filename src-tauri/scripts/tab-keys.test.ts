// @vitest-environment jsdom
import { readFileSync } from 'fs';
import { join } from 'path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// The desktop shell injects this script on every platform, with MENU_KEYS
// filled in: true on macOS (its menus carry most keys), false on Windows and
// Linux. Each mode runs once in jsdom against a document of its own (the
// script only adds a listener) and is driven with real key events.
const SOURCE = readFileSync(join(__dirname, 'tab-keys.js'), 'utf8');

function install(menuKeys: boolean): Document {
  const doc = document.implementation.createHTMLDocument('mdr');
  new Function('document', SOURCE.replace('__MDR_MENU_KEYS__', String(menuKeys)))(doc);
  return doc;
}

const hooks = {
  __mdrNewTab: vi.fn(),
  __mdrCloseActiveTab: vi.fn(() => true),
  __mdrReopenClosedTab: vi.fn(() => true),
  __mdrSwitchTab: vi.fn(() => true),
  __mdrSelectTab: vi.fn(() => true),
};

function withHooks() {
  Object.assign(window, hooks);
}

afterEach(() => {
  for (const [name, fn] of Object.entries(hooks)) {
    fn.mockClear();
    delete (window as unknown as Record<string, unknown>)[name];
  }
});

function calls() {
  return Object.fromEntries(
    Object.entries(hooks)
      .filter(([, fn]) => fn.mock.calls.length > 0)
      .map(([name, fn]) => [name, fn.mock.calls]),
  );
}

describe('desktop shell tab keys (Windows, Linux)', () => {
  let doc: Document;
  const press = (init: KeyboardEventInit) => {
    const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
    doc.body.dispatchEvent(event);
    return event;
  };

  beforeAll(() => {
    doc = install(false);
  });

  it('Ctrl+T opens a new tab', () => {
    withHooks();
    const event = press({ key: 't', ctrlKey: true });
    expect(calls()).toEqual({ __mdrNewTab: [[]] });
    expect(event.defaultPrevented).toBe(true);
  });

  it('Ctrl+W closes the active tab', () => {
    withHooks();
    const event = press({ key: 'w', ctrlKey: true });
    expect(calls()).toEqual({ __mdrCloseActiveTab: [[]] });
    expect(event.defaultPrevented).toBe(true);
  });

  it('Ctrl+Shift+T reopens the last closed tab', () => {
    withHooks();
    const event = press({ key: 'T', ctrlKey: true, shiftKey: true });
    expect(calls()).toEqual({ __mdrReopenClosedTab: [[]] });
    expect(event.defaultPrevented).toBe(true);
  });

  it('Ctrl+Tab and Ctrl+Shift+Tab switch to the next and previous tab', () => {
    withHooks();
    expect(press({ key: 'Tab', ctrlKey: true }).defaultPrevented).toBe(true);
    expect(press({ key: 'Tab', ctrlKey: true, shiftKey: true }).defaultPrevented).toBe(true);
    expect(calls()).toEqual({ __mdrSwitchTab: [[1], [-1]] });
  });

  it('Ctrl+1 to Ctrl+9 go to a tab by position, by key position too', () => {
    withHooks();
    expect(press({ key: '1', code: 'Digit1', ctrlKey: true }).defaultPrevented).toBe(true);
    press({ key: '9', code: 'Digit9', ctrlKey: true });
    // AZERTY: the Digit3 key types '"' without Shift.
    press({ key: '"', code: 'Digit3', ctrlKey: true });
    expect(calls()).toEqual({ __mdrSelectTab: [[1], [9], [3]] });
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
      { key: 'Tab' },
      { key: 'Tab', altKey: true, ctrlKey: true },
      { key: '0', code: 'Digit0', ctrlKey: true },
      { key: '!', code: 'Digit1', ctrlKey: true, shiftKey: true },
      { key: '1', code: 'Digit1', metaKey: true },
    ]) {
      expect(press(init).defaultPrevented).toBe(false);
    }
    expect(calls()).toEqual({});
  });

  it('does not throw while the app is not loaded', () => {
    expect(() => press({ key: 't', ctrlKey: true })).not.toThrow();
    expect(() => press({ key: 'w', ctrlKey: true })).not.toThrow();
    expect(() => press({ key: 'T', ctrlKey: true, shiftKey: true })).not.toThrow();
    expect(() => press({ key: 'Tab', ctrlKey: true })).not.toThrow();
    expect(() => press({ key: '1', code: 'Digit1', ctrlKey: true })).not.toThrow();
  });
});

describe('desktop shell tab keys (macOS)', () => {
  let doc: Document;
  const press = (init: KeyboardEventInit) => {
    const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
    doc.body.dispatchEvent(event);
    return event;
  };

  beforeAll(() => {
    doc = install(true);
  });

  it('reads Ctrl+Tab, which never reaches the Go menu', () => {
    withHooks();
    expect(press({ key: 'Tab', ctrlKey: true }).defaultPrevented).toBe(true);
    expect(press({ key: 'Tab', ctrlKey: true, shiftKey: true }).defaultPrevented).toBe(true);
    expect(calls()).toEqual({ __mdrSwitchTab: [[1], [-1]] });
  });

  it('leaves the keys the menus carry, and Ctrl+T (transpose in a text field), alone', () => {
    withHooks();
    for (const init of [
      { key: 't', ctrlKey: true },
      { key: 'w', ctrlKey: true },
      { key: 'T', ctrlKey: true, shiftKey: true },
      { key: '1', code: 'Digit1', ctrlKey: true },
      { key: '1', code: 'Digit1', metaKey: true },
    ]) {
      expect(press(init).defaultPrevented).toBe(false);
    }
    expect(calls()).toEqual({});
  });
});
