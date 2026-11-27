// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { HandOffButton } from './HandOffButton';

afterEach(cleanup);

function openPicker() {
  fireEvent.click(screen.getByTitle('Hand off other open files too'));
}

describe('HandOffButton picker', () => {
  it('drops a file whose last comment went away while the picker was open', async () => {
    const onCopy = vi.fn(() => Promise.resolve(true));
    const { rerender } = render(
      <HandOffButton
        activeFilePath="/a.md"
        commentCounts={
          new Map([
            ['/a.md', 1],
            ['/b.md', 1],
            ['/c.md', 1],
          ])
        }
        onCopyAgentPrompt={onCopy}
      />,
    );
    openPicker();
    fireEvent.click(screen.getByTitle('/b.md'));
    expect(screen.getByText('Copy handoff for 2 files')).toBeTruthy();

    // An agent resolves b.md's only comment while the picker is open.
    rerender(
      <HandOffButton
        activeFilePath="/a.md"
        commentCounts={
          new Map([
            ['/a.md', 1],
            ['/b.md', 0],
            ['/c.md', 1],
          ])
        }
        onCopyAgentPrompt={onCopy}
      />,
    );
    fireEvent.click(screen.getByText('Copy handoff for 1 file'));

    await waitFor(() => expect(onCopy).toHaveBeenCalledWith(['/a.md']));
  });

  it('keeps the picker open with its selection when the handoff is refused', async () => {
    const onCopy = vi.fn(() => Promise.resolve(false));
    render(
      <HandOffButton
        activeFilePath="/a.md"
        commentCounts={
          new Map([
            ['/a.md', 1],
            ['/b.md', 1],
          ])
        }
        onCopyAgentPrompt={onCopy}
      />,
    );
    openPicker();
    fireEvent.click(screen.getByTitle('/b.md'));
    fireEvent.click(screen.getByText('Copy handoff for 2 files'));

    await waitFor(() => expect(onCopy).toHaveBeenCalledWith(['/a.md', '/b.md']));
    expect(screen.getByText('Copy handoff for 2 files')).toBeTruthy();
  });
});

describe('HandOffButton look', () => {
  it('is the filled crimson primary at 13px when enabled, both segments alike', () => {
    render(
      <HandOffButton
        activeFilePath="/a.md"
        commentCounts={
          new Map([
            ['/a.md', 1],
            ['/b.md', 1],
          ])
        }
        onCopyAgentPrompt={vi.fn()}
      />,
    );
    for (const el of [
      screen.getByTestId('handoff-button'),
      screen.getByTestId('handoff-chevron'),
    ]) {
      expect(el.className).toMatch(/\bbg-primary\b/);
      expect(el.className).toMatch(/\btext-on-primary\b/);
      expect(el.className).not.toMatch(/\bbg-primary-bg\b/);
    }
    expect(screen.getByTestId('handoff-button').className).toMatch(/\btext-\[13px\]/);
  });

  it('shows the labeled button outlined and faded when disabled', () => {
    render(
      <HandOffButton
        activeFilePath="/a.md"
        commentCounts={new Map([['/a.md', 0]])}
        onCopyAgentPrompt={vi.fn()}
      />,
    );
    const button = screen.getByTestId('handoff-button');
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(button.className).not.toMatch(/\bbg-primary\b/);
    expect(button.className).toMatch(/\bring-border\b/);
    expect(button.className).toMatch(/\btext-content-muted\b/);
    expect(button.className).toMatch(/\bopacity-40\b/);
    // The visible label, with no count: the "1" belongs to the hidden width copy.
    const visible = Array.from(button.children).find((el) => !el.hasAttribute('aria-hidden'));
    expect(visible?.textContent).toBe('Hand off');
  });
});
