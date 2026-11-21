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
