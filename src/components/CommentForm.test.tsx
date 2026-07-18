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
