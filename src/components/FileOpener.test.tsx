// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import { FileOpener } from './FileOpener';
import type { RecentFile } from '../hooks/useRecentFiles';

const RECENT: RecentFile[] = [
  { path: '/docs/alpha-plan.md', name: 'alpha-plan.md', openedAt: '2026-11-25T10:00:00Z' },
  { path: '/docs/beta-notes.md', name: 'beta-notes.md', openedAt: '2026-11-25T09:00:00Z' },
  { path: '/docs/alpha-review.md', name: 'alpha-review.md', openedAt: '2026-11-25T08:00:00Z' },
];

function setup() {
  const onOpenFile = vi.fn();
  const onClose = vi.fn();
  const fetchMock = vi.fn<(input: RequestInfo | URL) => Promise<Response>>(
    async () => new Response(JSON.stringify({}), { status: 200 }),
  );
  vi.stubGlobal('fetch', fetchMock);
  const utils = render(
    <FileOpener
      open
      onClose={onClose}
      onOpenFile={onOpenFile}
      recentFiles={RECENT}
      activeFilePath={null}
      onClearRecent={() => {}}
    />,
  );
  const input = utils.getByPlaceholderText('File path or name...');
  const type = (value: string) => fireEvent.change(input, { target: { value } });
  const press = (key: string) => fireEvent.keyDown(input, { key });
  const selectedText = () =>
    utils.container.querySelector('[data-selected="true"]')?.textContent ?? '';
  const pickerCalls = () =>
    fetchMock.mock.calls.filter(([url]) => String(url).includes('/api/pick-file')).length;
  return { onOpenFile, input, type, press, selectedText, pickerCalls };
}

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => setTimeout(cb, 0));
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('FileOpener Enter', () => {
  it('opens the best matching recent file when the query matches', () => {
    const { onOpenFile, type, press, selectedText, pickerCalls } = setup();
    type('beta');
    expect(selectedText()).toContain('beta-notes.md');
    press('Enter');
    expect(onOpenFile).toHaveBeenCalledWith('/docs/beta-notes.md');
    expect(pickerCalls()).toBe(0);
  });

  it('picks the first match in recent order when several match', () => {
    const { onOpenFile, type, press } = setup();
    type('alpha');
    press('Enter');
    expect(onOpenFile).toHaveBeenCalledWith('/docs/alpha-plan.md');
  });

  it('keeps the system picker selected with an empty query', () => {
    const { onOpenFile, press, selectedText, pickerCalls } = setup();
    expect(selectedText()).toContain('System file picker');
    press('Enter');
    expect(onOpenFile).not.toHaveBeenCalled();
    expect(pickerCalls()).toBe(1);
  });

  it('keeps the system picker selected when nothing matches', () => {
    const { onOpenFile, type, press, selectedText, pickerCalls } = setup();
    type('zzz-nothing');
    expect(selectedText()).toContain('System file picker');
    press('Enter');
    expect(onOpenFile).not.toHaveBeenCalled();
    expect(pickerCalls()).toBe(1);
  });

  it('opens a typed path directly even when it matches a recent file', () => {
    const { onOpenFile, type, press, selectedText, pickerCalls } = setup();
    type('/docs/alpha');
    expect(selectedText()).toContain('System file picker');
    press('Enter');
    expect(onOpenFile).toHaveBeenCalledWith('/docs/alpha');
    expect(pickerCalls()).toBe(0);
  });

  it('lets arrow keys move off the best match, and typing again re-selects it', () => {
    const { onOpenFile, type, press, selectedText } = setup();
    type('alpha');
    press('ArrowDown');
    expect(selectedText()).toContain('alpha-review.md');
    press('ArrowUp');
    press('ArrowUp');
    expect(selectedText()).toContain('System file picker');
    type('alpha-');
    expect(selectedText()).toContain('alpha-plan.md');
    press('Enter');
    expect(onOpenFile).toHaveBeenCalledWith('/docs/alpha-plan.md');
  });
});
