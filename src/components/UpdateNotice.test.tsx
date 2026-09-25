// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { UpdateNotice, UPGRADE_COMMAND } from './UpdateNotice';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('UpdateNotice', () => {
  it('renders nothing when latest is null', () => {
    render(
      <UpdateNotice latest={null} reloadReady={false} onDismiss={vi.fn()} showToast={vi.fn()} />,
    );
    expect(document.querySelector('[data-update-notice]')).toBeNull();
  });

  it('shows the version and the exact upgrade command', () => {
    const { getByText } = render(
      <UpdateNotice latest="0.7.0" reloadReady={false} onDismiss={vi.fn()} showToast={vi.fn()} />,
    );
    expect(getByText('mdr 0.7.0 is available')).toBeTruthy();
    expect(getByText(UPGRADE_COMMAND)).toBeTruthy();
    expect(UPGRADE_COMMAND).toBe('npm install -g md-redline@latest');
  });

  it('copies the command and confirms via toast', async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    const showToast = vi.fn();
    const { getByRole } = render(
      <UpdateNotice latest="0.7.0" reloadReady={false} onDismiss={vi.fn()} showToast={showToast} />,
    );
    fireEvent.click(getByRole('button', { name: 'Copy' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(UPGRADE_COMMAND));
    expect(showToast).toHaveBeenCalledWith('Copied', 'success');
  });

  it('invokes onDismiss from the dismiss button', () => {
    const onDismiss = vi.fn();
    const { getByLabelText } = render(
      <UpdateNotice latest="0.7.0" reloadReady={false} onDismiss={onDismiss} showToast={vi.fn()} />,
    );
    fireEvent.click(getByLabelText('Dismiss update notice'));
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it('shows the reload note instead of the update-available pill when both are true', () => {
    const { getByText, queryByText } = render(
      <UpdateNotice latest="0.7.0" reloadReady={true} onDismiss={vi.fn()} showToast={vi.fn()} />,
    );
    expect(getByText('mdr was updated. Reload to get the new version.')).toBeTruthy();
    expect(queryByText('mdr 0.7.0 is available')).toBeNull();
    expect(document.querySelector('[data-reload-notice]')).toBeTruthy();
    expect(document.querySelector('[data-update-notice]')).toBeNull();
  });

  it('reloads the page from the Reload button', () => {
    const reload = vi.fn();
    const originalLocation = window.location;
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...originalLocation, reload },
    });

    const { getByRole } = render(
      <UpdateNotice latest={null} reloadReady={true} onDismiss={vi.fn()} showToast={vi.fn()} />,
    );
    fireEvent.click(getByRole('button', { name: 'Reload' }));
    expect(reload).toHaveBeenCalledOnce();

    Object.defineProperty(window, 'location', {
      configurable: true,
      value: originalLocation,
    });
  });
});
