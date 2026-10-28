// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { SelectionInfo } from '../types';

const fetchPreferences = vi.fn();
vi.mock('../lib/preferences-client', () => ({
  fetchPreferences: (...args: unknown[]) => fetchPreferences(...args),
  savePreferencesToDisk: vi.fn(),
}));

// The pan-zoom library needs real layout; the modal only needs its SVG in the page.
vi.mock('panzoom', () => ({
  default: () => ({
    dispose: vi.fn(),
    zoomAbs: vi.fn(),
    moveTo: vi.fn(),
    getTransform: () => ({ x: 0, y: 0, scale: 1 }),
  }),
}));

// jsdom has no layout, so a DOM range cannot be measured. The modal's
// selection hook reads the resolved selection from here.
vi.mock('../lib/selection-resolver', () => ({ resolveSelection: vi.fn() }));

import { resolveSelection } from '../lib/selection-resolver';
import { SettingsProvider, useSettings } from '../contexts/SettingsContext';
import { MermaidFullscreenModal, type MermaidFullscreenModalProps } from './MermaidFullscreenModal';

const SELECTION: SelectionInfo = {
  text: 'Dashboard',
  rect: new DOMRect(100, 100, 60, 16),
  contextBefore: '',
  contextAfter: '',
  offset: 0,
};

function Hydrated(props: MermaidFullscreenModalProps) {
  const { hydrated } = useSettings();
  return hydrated ? <MermaidFullscreenModal {...props} /> : null;
}

function renderModal(overrides: Partial<MermaidFullscreenModalProps>) {
  const props: MermaidFullscreenModalProps = {
    open: true,
    source: 'flowchart TD\n  Login --> Dashboard',
    blockIndex: 0,
    svgHtml: '<svg><text>Dashboard</text></svg>',
    cleanMarkdown: '```mermaid\nflowchart TD\n  Login --> Dashboard\n```\n',
    comments: [],
    activeCommentId: null,
    onClose: vi.fn(),
    canPlace: () => true,
    onAddComment: vi.fn(),
    onReply: vi.fn(),
    onDelete: vi.fn(),
    onEdit: vi.fn(),
    onEditReply: vi.fn(),
    onDeleteReply: vi.fn(),
    onActivateComment: vi.fn(),
    panelWidth: 320,
    onPanelResizeStart: vi.fn(),
    isResizing: false,
    ...overrides,
  };
  const tree = (p: MermaidFullscreenModalProps) => (
    <SettingsProvider>
      <Hydrated {...p} />
    </SettingsProvider>
  );
  const view = render(tree(props));
  return {
    update: (next: Partial<MermaidFullscreenModalProps>) =>
      view.rerender(tree({ ...props, ...next })),
  };
}

/** Select the label the way a mouse does: press, then release on the canvas. */
function selectLabel() {
  const label = document.querySelector('.mermaid-fullscreen-canvas-inner text');
  if (!label) throw new Error('label not rendered');
  act(() => {
    const down = new Event('pointerdown', { bubbles: true });
    Object.defineProperty(down, 'pointerType', { value: 'mouse' });
    label.dispatchEvent(down);
    label.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
  });
}

beforeEach(() => {
  fetchPreferences.mockReset();
  fetchPreferences.mockResolvedValue({ settings: {} });
  vi.mocked(resolveSelection).mockReturnValue(SELECTION);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('MermaidFullscreenModal composer', () => {
  it('keeps the draft when the file stops placing the label before Comment (#191)', async () => {
    const onAddComment = vi.fn(() => false);
    const { update } = renderModal({ onAddComment });
    await screen.findByRole('dialog', { name: 'Diagram fullscreen view' });
    selectLabel();

    fireEvent.click(await screen.findByRole('button', { name: /Comment/ }));
    const draft = 'A long comment the reader should not have to type twice';
    const textarea = (await screen.findByPlaceholderText(
      'Add your comment...',
    )) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: draft } });

    // The file changed under the open form and no longer has the label text.
    update({ canPlace: () => false });
    fireEvent.click(screen.getByRole('button', { name: 'Comment' }));

    expect(onAddComment).toHaveBeenCalledWith('Dashboard', draft, '', '', 0);
    expect((screen.getByPlaceholderText('Add your comment...') as HTMLTextAreaElement).value).toBe(
      draft,
    );
    expect(screen.getByRole('alert').textContent).toContain('find this text in the file');
  });

  it('checks a selection once, not on every render', async () => {
    const canPlace = vi.fn(() => true);
    const { update } = renderModal({ canPlace });
    await screen.findByRole('dialog', { name: 'Diagram fullscreen view' });
    selectLabel();
    await screen.findByRole('button', { name: /Comment/ });
    const calls = canPlace.mock.calls.length;
    expect(calls).toBeGreaterThan(0);

    update({ panelWidth: 400 });
    update({ isResizing: true });
    expect(canPlace).toHaveBeenCalledTimes(calls);
  });
});
