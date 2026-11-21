// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react';

// Mock preferences-client so SettingsContext doesn't hit the network
const fetchPreferences = vi.fn();
const savePreferencesToDisk = vi.fn();

vi.mock('../lib/preferences-client', () => ({
  fetchPreferences: (...args: unknown[]) => fetchPreferences(...args),
  savePreferencesToDisk: (...args: unknown[]) => savePreferencesToDisk(...args),
}));

import { SettingsProvider, useSettings } from '../contexts/SettingsContext';
import { CommentForm } from './CommentForm';
import type { SelectionInfo } from '../types';

// The app only ever mounts CommentForm after settings hydration (selection
// happens long after startup). Mirror that: gate the form on hydrated so
// tests exercise the real post-hydration initial state.
function HydratedForm(props: Parameters<typeof CommentForm>[0]) {
  const { hydrated } = useSettings();
  if (!hydrated) return null;
  return <CommentForm {...props} />;
}

// Custom fixtures; deliberately not the shipped defaults so assertions are
// content-independent.
const TEMPLATES_3 = [
  { label: 'Rewrite this', text: 'Please rewrite this section.' },
  { label: 'Too vague', text: 'Be more specific here.' },
  { label: 'Remove', text: 'Remove this part.' },
];

const selection: SelectionInfo = {
  text: 'valid credentials',
  rect: {
    top: 200,
    left: 150,
    bottom: 220,
    right: 300,
    width: 150,
    height: 20,
  } as DOMRect,
  contextBefore: 'Users must provide ',
  contextAfter: ' to access the application',
  offset: 42,
};

function renderForm(props: Partial<Parameters<typeof CommentForm>[0]> = {}) {
  const defaults: Parameters<typeof CommentForm>[0] = {
    selection,
    onSubmit: vi.fn(),
    onCancel: vi.fn(),
    onLock: vi.fn(),
  };
  return render(
    <SettingsProvider>
      <HydratedForm {...defaults} {...props} />
    </SettingsProvider>,
  );
}

// Like renderForm, but props can change afterwards on the same mounted form,
// the way App re-renders it when the file or the selection changes.
function renderControlledForm(props: Partial<Parameters<typeof CommentForm>[0]> = {}) {
  const base: Parameters<typeof CommentForm>[0] = {
    selection,
    onSubmit: vi.fn(),
    onCancel: vi.fn(),
    onLock: vi.fn(),
    ...props,
  };
  const tree = (p: Parameters<typeof CommentForm>[0]) => (
    <SettingsProvider>
      <HydratedForm {...p} />
    </SettingsProvider>
  );
  const view = render(tree(base));
  return {
    ...view,
    props: base,
    update: (next: Partial<Parameters<typeof CommentForm>[0]>) =>
      view.rerender(tree({ ...base, ...next })),
  };
}

const UNPLACEABLE_HEADLINE = 'Can’t comment on this text.';
const UNPLACEABLE_DETAIL =
  'Part of it is written differently in the file. Try a shorter selection.';

beforeEach(() => {
  fetchPreferences.mockReset();
  savePreferencesToDisk.mockReset();
});

afterEach(() => {
  cleanup();
});

describe('CommentForm selection pill', () => {
  it('renders Comment, the first two templates, and the overflow button', async () => {
    fetchPreferences.mockResolvedValue({ settings: { templates: TEMPLATES_3 } });
    renderForm();

    expect(await screen.findByText('Rewrite this')).toBeTruthy();
    expect(screen.getByText('Too vague')).toBeTruthy();
    expect(screen.queryByText('Remove')).toBeNull();
    expect(screen.getByRole('button', { name: /Comment/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'More templates' })).toBeTruthy();
    expect(screen.queryByPlaceholderText('Add your comment...')).toBeNull();
  });

  it('hides the overflow button when there are two or fewer templates', async () => {
    fetchPreferences.mockResolvedValue({
      settings: { templates: TEMPLATES_3.slice(0, 2) },
    });
    renderForm();

    await screen.findByText('Rewrite this');
    expect(screen.queryByRole('button', { name: 'More templates' })).toBeNull();
  });

  it('template tap expands prefilled with the grid hidden and locks the selection', async () => {
    fetchPreferences.mockResolvedValue({
      settings: { templates: TEMPLATES_3, showTemplatesByDefault: true },
    });
    const onLock = vi.fn();
    renderForm({ onLock });

    fireEvent.click(await screen.findByText('Rewrite this'));

    const textarea = (await screen.findByPlaceholderText(
      'Add your comment...',
    )) as HTMLTextAreaElement;
    expect(textarea.value).toBe('Please rewrite this section.');
    expect(screen.queryByText('Quick templates:')).toBeNull();
    expect(onLock).toHaveBeenCalled();
  });

  it('overflow tap lists the remaining templates in place; picking one prefills the form', async () => {
    fetchPreferences.mockResolvedValue({ settings: { templates: TEMPLATES_3 } });
    renderForm();

    fireEvent.click(await screen.findByRole('button', { name: 'More templates' }));

    // The menu lists only templates beyond the two inline pill slots and
    // does not open the form by itself.
    const menuItem = await screen.findByRole('button', { name: 'Remove' });
    expect(document.querySelector('[data-pill-template-menu]')).toBeTruthy();
    expect(screen.queryByPlaceholderText('Add your comment...')).toBeNull();

    fireEvent.click(menuItem);
    const textarea = (await screen.findByPlaceholderText(
      'Add your comment...',
    )) as HTMLTextAreaElement;
    expect(textarea.value).not.toBe('');
    expect(document.querySelector('[data-pill-template-menu]')).toBeNull();
  });

  it('Comment tap expands empty with the grid hidden even when showTemplatesByDefault is on', async () => {
    fetchPreferences.mockResolvedValue({
      settings: { templates: TEMPLATES_3, showTemplatesByDefault: true },
    });
    renderForm();

    fireEvent.click(await screen.findByRole('button', { name: /Comment/ }));

    const textarea = (await screen.findByPlaceholderText(
      'Add your comment...',
    )) as HTMLTextAreaElement;
    expect(textarea.value).toBe('');
    expect(screen.queryByText('Quick templates:')).toBeNull();
  });

  it('Escape clears an untouched template prefill instead of closing the form', async () => {
    fetchPreferences.mockResolvedValue({ settings: { templates: TEMPLATES_3 } });
    const onCancel = vi.fn();
    renderForm({ onCancel });

    fireEvent.click(await screen.findByText('Rewrite this'));

    const textarea = (await screen.findByPlaceholderText(
      'Add your comment...',
    )) as HTMLTextAreaElement;
    expect(textarea.value).toBe('Please rewrite this section.');

    fireEvent.keyDown(textarea, { key: 'Escape' });
    expect(textarea.value).toBe('');
    expect(onCancel).not.toHaveBeenCalled();

    fireEvent.keyDown(textarea, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('typing after a prefill makes Escape close the form as before', async () => {
    fetchPreferences.mockResolvedValue({ settings: { templates: TEMPLATES_3 } });
    const onCancel = vi.fn();
    renderForm({ onCancel });

    fireEvent.click(await screen.findByText('Rewrite this'));

    const textarea = (await screen.findByPlaceholderText(
      'Add your comment...',
    )) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: textarea.value + ' now' } });
    fireEvent.keyDown(textarea, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('keeps the draft and says why when the comment cannot be placed', async () => {
    // The file could not place the comment. Dropping the draft here threw away
    // everything the reader had typed (#191).
    fetchPreferences.mockResolvedValue({ settings: { templates: TEMPLATES_3 } });
    const onSubmit = vi.fn(() => false);
    renderForm({ onSubmit });

    fireEvent.click(await screen.findByRole('button', { name: /Comment/ }));
    const textarea = (await screen.findByPlaceholderText(
      'Add your comment...',
    )) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'A long comment worth keeping' } });
    expect(screen.getByText(/\+Enter$/)).toBeTruthy();
    fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true });

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect((screen.getByPlaceholderText('Add your comment...') as HTMLTextAreaElement).value).toBe(
      'A long comment worth keeping',
    );
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toMatch(/Can.t find this text in the file/);
    expect(alert.textContent).toContain(
      'Your draft is still here. Copy it, cancel, and select nearby text to try again.',
    );
    expect(textarea.getAttribute('aria-describedby')).toBe(alert.id);
    // Comment is off, so its shortcut hint goes too.
    expect(screen.queryByText(/\+Enter$/)).toBeNull();
  });

  it('keeps a failed template draft on Escape and refocuses it after a click', async () => {
    fetchPreferences.mockResolvedValue({ settings: { templates: TEMPLATES_3 } });
    const onCancel = vi.fn();
    renderForm({ onSubmit: vi.fn(() => false), onCancel });

    fireEvent.click(await screen.findByText('Rewrite this'));
    const textarea = (await screen.findByPlaceholderText(
      'Add your comment...',
    )) as HTMLTextAreaElement;
    const comment = screen.getByRole('button', { name: 'Comment' });
    comment.focus();
    fireEvent.click(comment);

    expect(document.activeElement).toBe(textarea);
    // The untouched prefill is now the draft the alert promised to keep, so
    // Escape cancels instead of clearing it.
    fireEvent.keyDown(textarea, { key: 'Escape' });
    expect(textarea.value).toBe('Please rewrite this section.');
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('clears the draft when the comment is placed', async () => {
    fetchPreferences.mockResolvedValue({ settings: { templates: TEMPLATES_3 } });
    const onSubmit = vi.fn(() => true);
    renderForm({ onSubmit });

    fireEvent.click(await screen.findByRole('button', { name: /Comment/ }));
    const textarea = (await screen.findByPlaceholderText(
      'Add your comment...',
    )) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'Placed fine' } });
    fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true });

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(screen.queryByPlaceholderText('Add your comment...')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('blocks a retry on the selection the file could not place', async () => {
    // The same selection fails the same way, so Comment stays off until the
    // reader picks other text.
    fetchPreferences.mockResolvedValue({ settings: { templates: TEMPLATES_3 } });
    const onSubmit = vi.fn(() => false);
    renderForm({ onSubmit });

    fireEvent.click(await screen.findByRole('button', { name: /Comment/ }));
    const textarea = await screen.findByPlaceholderText('Add your comment...');
    fireEvent.change(textarea, { target: { value: 'Second try' } });
    fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true });
    fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true });

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect((screen.getByRole('button', { name: 'Comment' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it('closes the templates when the comment cannot be placed', async () => {
    fetchPreferences.mockResolvedValue({
      settings: { templates: TEMPLATES_3, quickComment: true, showTemplatesByDefault: true },
    });
    renderForm({ onSubmit: vi.fn(() => false) });

    const textarea = await screen.findByPlaceholderText('Add your comment...');
    expect(await screen.findByText('Quick templates:')).toBeTruthy();
    fireEvent.change(textarea, { target: { value: 'Nowhere to go' } });
    fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true });

    expect(screen.queryByText('Quick templates:')).toBeNull();
    // A template click replaces the text, so the toggle goes too: it would
    // overwrite the draft this state exists to keep.
    expect(screen.queryByTitle('Quick templates')).toBeNull();
  });

  it('quickComment bypasses the pill and honors showTemplatesByDefault', async () => {
    fetchPreferences.mockResolvedValue({
      settings: {
        templates: TEMPLATES_3,
        quickComment: true,
        showTemplatesByDefault: true,
      },
    });
    renderForm();

    expect(await screen.findByPlaceholderText('Add your comment...')).toBeTruthy();
    expect(await screen.findByText('Quick templates:')).toBeTruthy();
  });
});

describe('CommentForm on a selection the file cannot place', () => {
  it('puts the status region in the page before its message', async () => {
    fetchPreferences.mockResolvedValue({ settings: { templates: TEMPLATES_3 } });
    // Hold the frame that fills the region, so the empty state can't be missed
    // on a machine slow enough that the frame fires before the query resolves.
    const frames: FrameRequestCallback[] = [];
    const raf = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((cb: FrameRequestCallback) => frames.push(cb));
    try {
      renderForm({ placeable: false });

      // A live region inserted with its message already in it is often not
      // announced, so the region arrives empty and the message follows.
      const status = await screen.findByRole('status');
      expect(status.textContent).toBe('');
      act(() => frames.splice(0).forEach((cb) => cb(0)));
      await waitFor(() => expect(status.textContent).toContain(UNPLACEABLE_HEADLINE));
    } finally {
      raf.mockRestore();
    }
  });

  it('keeps the same status region while the pill becomes unplaceable', async () => {
    fetchPreferences.mockResolvedValue({ settings: { templates: TEMPLATES_3 } });
    const { update } = renderControlledForm({ placeable: true });

    await screen.findByRole('button', { name: /Comment/ });
    const status = screen.getByRole('status');
    expect(status.textContent).toBe('');
    update({ placeable: false });
    await waitFor(() => expect(status.textContent).toContain(UNPLACEABLE_HEADLINE));
    expect(screen.getByRole('status')).toBe(status);
    expect(status.isConnected).toBe(true);
  });

  // #212: an edit landing under a selection is not the selected text's fault.
  it('says the file changed when that is why the pill cannot comment', async () => {
    fetchPreferences.mockResolvedValue({ settings: { templates: TEMPLATES_3 } });
    const { update } = renderControlledForm({ placeable: true });

    await screen.findByRole('button', { name: /Comment/ });
    const status = screen.getByRole('status');
    update({ placeable: false, failedReason: 'changed' });
    await waitFor(() =>
      expect(status.textContent).toContain('The file changed since you selected this text.'),
    );
    expect(status.textContent).toContain('Select it again to comment.');
    expect(status.textContent).not.toContain(UNPLACEABLE_DETAIL);
  });

  it('shows why a selection cannot be commented on', async () => {
    fetchPreferences.mockResolvedValue({ settings: { templates: TEMPLATES_3 } });
    renderForm({ placeable: false });

    const status = await screen.findByRole('status');
    await waitFor(() => expect(status.textContent).toContain(UNPLACEABLE_HEADLINE));
    expect(status.textContent).toContain(UNPLACEABLE_DETAIL);
    expect(screen.queryByRole('button', { name: /Comment/ })).toBeNull();
    expect(screen.queryByText('Rewrite this')).toBeNull();
    expect(screen.queryByRole('button', { name: 'More templates' })).toBeNull();
  });

  it('quickComment does not open the form for an unplaceable selection', async () => {
    fetchPreferences.mockResolvedValue({
      settings: { templates: TEMPLATES_3, quickComment: true },
    });
    const onLock = vi.fn();
    renderForm({ placeable: false, onLock });

    await screen.findByRole('status');
    expect(screen.queryByPlaceholderText('Add your comment...')).toBeNull();
    expect(onLock).not.toHaveBeenCalled();
  });

  it('autoExpand does not open an unplaceable selection', async () => {
    fetchPreferences.mockResolvedValue({ settings: { templates: TEMPLATES_3 } });
    const onLock = vi.fn();
    renderForm({ autoExpand: true, placeable: false, onLock });

    await screen.findByRole('status');
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(onLock).not.toHaveBeenCalled();
  });

  it('ignores taps and clicks on the status of a pending selection', async () => {
    fetchPreferences.mockResolvedValue({ settings: { templates: TEMPLATES_3 } });
    const onLock = vi.fn();
    renderForm({ isPending: true, placeable: false, onLock });

    const status = await screen.findByRole('status');
    fireEvent.touchEnd(status);
    fireEvent.click(status);

    expect(onLock).not.toHaveBeenCalled();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByRole('status')).toBeTruthy();
  });

  it('clears the failed state when the selection becomes placeable again', async () => {
    fetchPreferences.mockResolvedValue({ settings: { templates: TEMPLATES_3 } });
    const { update } = renderControlledForm({ placeable: true, onSubmit: vi.fn(() => false) });

    fireEvent.click(await screen.findByRole('button', { name: /Comment/ }));
    const textarea = (await screen.findByPlaceholderText(
      'Add your comment...',
    )) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'Worth keeping' } });
    fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true });
    expect(screen.getByRole('alert')).toBeTruthy();

    // The file changed under the open form: first still unplaceable, then
    // placeable again.
    update({ placeable: false });
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.queryByRole('status')).toBeNull();
    update({ placeable: true });

    expect(screen.queryByRole('alert')).toBeNull();
    expect((screen.getByRole('button', { name: 'Comment' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    expect((screen.getByPlaceholderText('Add your comment...') as HTMLTextAreaElement).value).toBe(
      'Worth keeping',
    );
  });

  it('never opens a collapsed pill when availability changes', async () => {
    fetchPreferences.mockResolvedValue({ settings: { templates: TEMPLATES_3 } });
    const onLock = vi.fn();
    const { update } = renderControlledForm({ placeable: true, onLock });

    await screen.findByRole('button', { name: /Comment/ });
    update({ placeable: false });
    expect(screen.getByRole('status')).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
    update({ placeable: true });
    expect(screen.getByRole('button', { name: /Comment/ })).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(onLock).not.toHaveBeenCalled();
  });

  it('quickComment opens the next selection once the file can place it', async () => {
    // The pill for an unplaceable selection is never locked, so the next drag
    // reaches the same mounted form with a new selection.
    fetchPreferences.mockResolvedValue({
      settings: { templates: TEMPLATES_3, quickComment: true },
    });
    const onLock = vi.fn();
    const { update } = renderControlledForm({ placeable: false, onLock });

    await screen.findByRole('status');
    update({
      placeable: true,
      selection: { ...selection, text: 'access the application', offset: 70 },
    });

    expect(await screen.findByPlaceholderText('Add your comment...')).toBeTruthy();
    expect(onLock).toHaveBeenCalledTimes(1);
  });

  it('releases an empty quickComment form when its selection widens to unplaceable text', async () => {
    // A triple-click widens the word quick comment opened (and locked) to its
    // line. With nothing typed there is no draft to keep, so the form gives
    // way to the status, and the lock goes with it so the next drag lands.
    fetchPreferences.mockResolvedValue({
      settings: { templates: TEMPLATES_3, quickComment: true },
    });
    const onLock = vi.fn();
    const onUnlock = vi.fn();
    const { update } = renderControlledForm({ placeable: true, onLock, onUnlock });

    await screen.findByPlaceholderText('Add your comment...');
    update({
      placeable: false,
      selection: { ...selection, text: 'Users must provide valid credentials', offset: 23 },
    });

    expect(screen.getByRole('status')).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(onUnlock).toHaveBeenCalledTimes(1);
    expect(onLock).toHaveBeenCalledTimes(1);
  });

  // #212: an edit makes the open, empty form unplaceable and it gives way.
  // Selecting the same words again has the same key, so only the change back
  // to placeable can reopen it.
  it('reopens a quickComment form when the same words are selected again after an edit', async () => {
    fetchPreferences.mockResolvedValue({
      settings: { templates: TEMPLATES_3, quickComment: true },
    });
    const onLock = vi.fn();
    const onUnlock = vi.fn();
    const { update } = renderControlledForm({ placeable: true, onLock, onUnlock });

    await screen.findByPlaceholderText('Add your comment...');
    update({ placeable: false, failedReason: 'changed' });
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(onUnlock).toHaveBeenCalledTimes(1);

    update({ placeable: true, failedReason: undefined, selection: { ...selection } });
    expect(await screen.findByPlaceholderText('Add your comment...')).toBeTruthy();
    expect(onLock).toHaveBeenCalledTimes(2);
  });

  it('does not reopen a quickComment form when the file merely goes back', async () => {
    fetchPreferences.mockResolvedValue({
      settings: { templates: TEMPLATES_3, quickComment: true },
    });
    const onLock = vi.fn();
    const { update } = renderControlledForm({ placeable: true, onLock });

    await screen.findByPlaceholderText('Add your comment...');
    update({ placeable: false, failedReason: 'changed' });
    // The same selection object: no new gesture, only the file reverting.
    update({ placeable: true, failedReason: undefined });
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(onLock).toHaveBeenCalledTimes(1);
  });

  it('shows why at once when the file changes under a typed draft', async () => {
    fetchPreferences.mockResolvedValue({
      settings: { templates: TEMPLATES_3, quickComment: true },
    });
    const { update } = renderControlledForm({ placeable: true });

    const field = await screen.findByPlaceholderText('Add your comment...');
    fireEvent.change(field, { target: { value: 'half a thought' } });
    update({ placeable: false, failedReason: 'changed' });

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/The file changed since you selected this text/);
    expect(screen.getByRole('button', { name: 'Comment' })).toHaveProperty('disabled', true);
    expect((field as HTMLTextAreaElement).value).toBe('half a thought');

    // The file going back makes it postable again.
    update({ placeable: true, failedReason: undefined });
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(screen.getByRole('button', { name: 'Comment' })).toHaveProperty('disabled', false);
  });

  it('keeps a typed draft open when its selection widens to unplaceable text', async () => {
    fetchPreferences.mockResolvedValue({
      settings: { templates: TEMPLATES_3, quickComment: true },
    });
    const onUnlock = vi.fn();
    const { update } = renderControlledForm({ placeable: true, onUnlock });

    const textarea = await screen.findByPlaceholderText('Add your comment...');
    fireEvent.change(textarea, { target: { value: 'Already typing' } });
    update({
      placeable: false,
      selection: { ...selection, text: 'Users must provide valid credentials', offset: 23 },
    });

    expect((screen.getByPlaceholderText('Add your comment...') as HTMLTextAreaElement).value).toBe(
      'Already typing',
    );
    expect(screen.queryByRole('status')).toBeNull();
    expect(onUnlock).not.toHaveBeenCalled();
  });

  it('releases an empty open form when the file stops placing its selection', async () => {
    fetchPreferences.mockResolvedValue({
      settings: { templates: TEMPLATES_3, quickComment: true },
    });
    const onUnlock = vi.fn();
    const { update } = renderControlledForm({ placeable: true, onUnlock });

    await screen.findByPlaceholderText('Add your comment...');
    update({ placeable: false });

    expect(screen.getByRole('status')).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(onUnlock).toHaveBeenCalledTimes(1);
  });

  it('keeps a typed draft open when the file stops placing its selection', async () => {
    fetchPreferences.mockResolvedValue({
      settings: { templates: TEMPLATES_3, quickComment: true },
    });
    const onUnlock = vi.fn();
    const { update } = renderControlledForm({ placeable: true, onUnlock });

    const textarea = (await screen.findByPlaceholderText(
      'Add your comment...',
    )) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'Already typing' } });
    update({ placeable: false });

    expect(textarea.value).toBe('Already typing');
    expect(screen.queryByRole('status')).toBeNull();
    expect(onUnlock).not.toHaveBeenCalled();
  });
});

describe('CommentForm on a draft handed back to it (#196)', () => {
  const draft = { text: 'Half a thought', prefillPristine: false };

  it('opens on the draft with the caret in it', async () => {
    fetchPreferences.mockResolvedValue({ settings: { templates: TEMPLATES_3 } });
    renderForm({ initialDraft: draft });

    const textarea = (await screen.findByPlaceholderText(
      'Add your comment...',
    )) as HTMLTextAreaElement;
    expect(textarea.value).toBe('Half a thought');
    expect(document.activeElement).toBe(textarea);
    expect(screen.queryByRole('alert')).toBeNull();
    expect((screen.getByRole('button', { name: 'Comment' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it('comes back failed after a submit that failed, though the file places it', async () => {
    fetchPreferences.mockResolvedValue({ settings: { templates: TEMPLATES_3 } });
    renderForm({ initialDraft: { ...draft, failed: true }, placeable: true });

    await screen.findByRole('alert');
    expect((screen.getByRole('button', { name: 'Comment' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    // A template click would replace the draft.
    expect(screen.queryByRole('button', { name: /templates/i })).toBeNull();
  });

  it('says the file changed, rather than blaming the text, for a draft on an old version', async () => {
    fetchPreferences.mockResolvedValue({ settings: { templates: TEMPLATES_3 } });
    renderForm({ initialDraft: draft, placeable: false, failedReason: 'changed' });

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/The file changed since you selected this text/);
    expect(alert.textContent).not.toMatch(/Symbols like/);
  });

  it('says the text was selected in the diff view for a draft from there', async () => {
    fetchPreferences.mockResolvedValue({ settings: { templates: TEMPLATES_3 } });
    renderForm({ initialDraft: draft, placeable: false, failedReason: 'diff' });

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/selected in the diff view/);
    expect(alert.textContent).not.toMatch(/Symbols like/);
  });

  it('opens saying so when the file can no longer place its selection', async () => {
    fetchPreferences.mockResolvedValue({ settings: { templates: TEMPLATES_3 } });
    renderForm({ initialDraft: draft, placeable: false });

    const textarea = (await screen.findByPlaceholderText(
      'Add your comment...',
    )) as HTMLTextAreaElement;
    expect(textarea.value).toBe('Half a thought');
    expect(screen.getByRole('alert').textContent).toMatch(/Can.t find this text in the file/);
    expect((screen.getByRole('button', { name: 'Comment' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    // Not the pill's status, which is for a selection with nothing typed on it.
    expect(screen.queryByText(UNPLACEABLE_HEADLINE)).toBeNull();
  });

  it('takes the comment again once the file can place its selection', async () => {
    fetchPreferences.mockResolvedValue({ settings: { templates: TEMPLATES_3 } });
    const { update } = renderControlledForm({ initialDraft: draft, placeable: false });

    await screen.findByRole('alert');
    update({ placeable: true });

    expect(screen.queryByRole('alert')).toBeNull();
    expect((screen.getByRole('button', { name: 'Comment' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it('keeps the templates closed, which would replace the draft', async () => {
    fetchPreferences.mockResolvedValue({
      settings: { templates: TEMPLATES_3, quickComment: true, showTemplatesByDefault: true },
    });
    renderForm({ initialDraft: draft });

    await screen.findByPlaceholderText('Add your comment...');
    expect(screen.queryByText('Quick templates:')).toBeNull();
  });

  it('still lets Escape clear a template prefill nobody touched', async () => {
    fetchPreferences.mockResolvedValue({ settings: { templates: TEMPLATES_3 } });
    const onCancel = vi.fn();
    renderForm({
      initialDraft: { text: 'Please rewrite this section.', prefillPristine: true },
      onCancel,
    });

    const textarea = (await screen.findByPlaceholderText(
      'Add your comment...',
    )) as HTMLTextAreaElement;
    fireEvent.keyDown(textarea, { key: 'Escape' });

    expect(textarea.value).toBe('');
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('leaves the keyboard with an open overlay and takes it when that closes', async () => {
    fetchPreferences.mockResolvedValue({ settings: { templates: TEMPLATES_3 } });
    const { update } = renderControlledForm({ initialDraft: draft, overlayOpen: true });

    const textarea = await screen.findByPlaceholderText('Add your comment...');
    expect(document.activeElement).not.toBe(textarea);

    update({ overlayOpen: false });
    expect(document.activeElement).toBe(textarea);
  });
});

describe('CommentForm reporting its draft', () => {
  it('reports the text with the selection it is on as the reader types', async () => {
    fetchPreferences.mockResolvedValue({ settings: { templates: TEMPLATES_3 } });
    const onDraftChange = vi.fn();
    renderForm({ onDraftChange });

    fireEvent.click(await screen.findByRole('button', { name: /Comment/ }));
    const textarea = await screen.findByPlaceholderText('Add your comment...');
    fireEvent.change(textarea, { target: { value: 'Typed so far' } });

    expect(onDraftChange).toHaveBeenLastCalledWith({
      selection,
      text: 'Typed so far',
      prefillPristine: false,
      failed: false,
    });
  });

  it('reports a template prefill as untouched', async () => {
    fetchPreferences.mockResolvedValue({ settings: { templates: TEMPLATES_3 } });
    const onDraftChange = vi.fn();
    renderForm({ onDraftChange });

    fireEvent.click(await screen.findByText('Rewrite this'));
    await screen.findByPlaceholderText('Add your comment...');

    expect(onDraftChange).toHaveBeenLastCalledWith({
      selection,
      text: 'Please rewrite this section.',
      prefillPristine: true,
      failed: false,
    });
  });

  it('reports nothing typed once the comment is posted', async () => {
    fetchPreferences.mockResolvedValue({ settings: { templates: TEMPLATES_3 } });
    const onDraftChange = vi.fn();
    renderForm({ onDraftChange, onSubmit: vi.fn(() => true) });

    fireEvent.click(await screen.findByRole('button', { name: /Comment/ }));
    const textarea = await screen.findByPlaceholderText('Add your comment...');
    fireEvent.change(textarea, { target: { value: 'Posted' } });
    fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true });

    expect(onDraftChange).toHaveBeenLastCalledWith({
      selection,
      text: '',
      prefillPristine: false,
      failed: false,
    });
  });
});

describe('CommentForm on a draft handed back for text the file lost', () => {
  it('keeps a template prefill on Escape, as after a failed submit', async () => {
    fetchPreferences.mockResolvedValue({ settings: { templates: TEMPLATES_3 } });
    const onCancel = vi.fn();
    renderForm({
      initialDraft: { text: 'Please rewrite this section.', prefillPristine: true },
      placeable: false,
      onCancel,
    });

    const textarea = (await screen.findByPlaceholderText(
      'Add your comment...',
    )) as HTMLTextAreaElement;
    fireEvent.keyDown(textarea, { key: 'Escape' });

    expect(textarea.value).toBe('Please rewrite this section.');
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('locks its selection like any open form', async () => {
    fetchPreferences.mockResolvedValue({ settings: { templates: TEMPLATES_3 } });
    const onLock = vi.fn();
    renderForm({
      initialDraft: { text: 'Half a thought', prefillPristine: false },
      placeable: false,
      onLock,
    });

    await screen.findByPlaceholderText('Add your comment...');
    expect(onLock).toHaveBeenCalled();
  });
});

describe('CommentForm whose selection is outside the window', () => {
  // The rect is a snapshot from when the text was selected. Far below a
  // jsdom window, which is 768 tall.
  const offscreen: SelectionInfo = {
    ...selection,
    rect: { top: 2000, left: 150, bottom: 2020, right: 300, width: 150, height: 20 } as DOMRect,
  };
  const formRoot = () => document.querySelector('[data-comment-form]') as HTMLElement;

  it('hides the pill, which follows its text back into view', async () => {
    fetchPreferences.mockResolvedValue({ settings: { templates: TEMPLATES_3 } });
    renderForm({ selection: offscreen });

    // Hidden from the accessibility tree too, so not findable by role.
    await screen.findByTestId('pending-selection-commit');
    expect(formRoot().style.visibility).toBe('hidden');
  });

  it('shows a draft handed back in a window shorter than the one it was written in', async () => {
    fetchPreferences.mockResolvedValue({ settings: { templates: TEMPLATES_3 } });
    renderForm({
      selection: offscreen,
      initialDraft: { text: 'Half a thought', prefillPristine: false },
    });

    const textarea = await screen.findByPlaceholderText('Add your comment...');
    expect(formRoot().style.visibility).not.toBe('hidden');
    // Inside the window, not at the snapshot's place below it.
    expect(parseFloat(formRoot().style.top)).toBeLessThan(window.innerHeight);
    expect(document.activeElement).toBe(textarea);
  });

  it('shows the form the keyboard opens on a selection scrolled out of view', async () => {
    fetchPreferences.mockResolvedValue({ settings: { templates: TEMPLATES_3 } });
    const { update } = renderControlledForm({ selection: offscreen });

    await screen.findByTestId('pending-selection-commit');
    update({ autoExpand: true });

    await screen.findByPlaceholderText('Add your comment...');
    expect(formRoot().style.visibility).not.toBe('hidden');
  });
});
