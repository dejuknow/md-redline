// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

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
