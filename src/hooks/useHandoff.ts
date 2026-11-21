import { useCallback, type RefObject } from 'react';
import { getPathBasename } from '../lib/path-utils';
import type { SaveState } from './useTabs';
import type { ShowToast } from './useToast';

export type { SaveState };

export interface UseHandoffParams {
  activeFilePath: string | null;
  /** The active tab's latest text; its tab entry can lag a render behind. */
  rawMarkdownRef: RefObject<string | undefined>;
  tabs: ReadonlyArray<{ filePath: string; rawMarkdown: string }>;
  getSaveState: (path: string) => SaveState;
  /** Settles once every write queued so far has finished. */
  whenSaved: () => Promise<void>;
  copyAgentPrompt: (filePaths: string[]) => Promise<boolean>;
  captureReferences: (entries: ReadonlyMap<string, string>, origin: 'handoff') => void;
  showToast: ShowToast;
}

/**
 * The Hand off button's flow, and the save check the review banner shares.
 *
 * An agent reads the files on disk, not the tabs, so a handoff waits for any
 * write still out on the files it names, and refuses if one failed (a
 * conflict, a server error). The diff reference for each handed-off file
 * is its text at the click, recorded only once the clipboard write succeeds:
 * a failed copy hands nothing off, and a file the picker left out (even the
 * active one) keeps its reference.
 */
export function useHandoff({
  activeFilePath,
  rawMarkdownRef,
  tabs,
  getSaveState,
  whenSaved,
  copyAgentPrompt,
  captureReferences,
  showToast,
}: UseHandoffParams) {
  const ensureSaved = useCallback(
    async (filePaths: string[]): Promise<boolean> => {
      // Saves are local and usually land in milliseconds, so wait rather than
      // make the reviewer click again. The clipboard write then runs after an
      // await, which Safari can refuse outside the click's own task; that only
      // happens on this rare path and surfaces as the usual copy error.
      if (filePaths.some((path) => getSaveState(path) === 'saving')) await whenSaved();
      // Only a failure refuses. A write queued after the wait began is an edit
      // made after the click, not part of what is being handed off.
      const failed = filePaths.find((path) => getSaveState(path) === 'failed');
      if (failed === undefined) return true;
      showToast(
        `${getPathBasename(failed)} didn't save, so an agent would miss your latest comments.`,
        'error',
      );
      return false;
    },
    [getSaveState, whenSaved, showToast],
  );

  /** The current text of each named file that is open in a tab. */
  const contentsOf = useCallback(
    (filePaths: string[]): Map<string, string> => {
      const contents = new Map<string, string>();
      for (const path of filePaths) {
        const content =
          path === activeFilePath
            ? rawMarkdownRef.current
            : tabs.find((t) => t.filePath === path)?.rawMarkdown;
        if (content !== undefined) contents.set(path, content);
      }
      return contents;
    },
    [activeFilePath, rawMarkdownRef, tabs],
  );

  /** Resolves true when the prompt reached the clipboard. */
  const handOff = useCallback(
    async (filePaths: string[]): Promise<boolean> => {
      if (filePaths.length === 0) return false;
      // Read before waiting: the text at the click is what is being handed
      // off, and the pending write is that same text on its way to disk.
      const atClick = contentsOf(filePaths);
      if (!(await ensureSaved(filePaths))) return false;
      if (!(await copyAgentPrompt(filePaths))) return false;
      captureReferences(atClick, 'handoff');
      return true;
    },
    [ensureSaved, contentsOf, copyAgentPrompt, captureReferences],
  );

  /**
   * Record a banner Send. The session names its files, which need not
   * include the active tab, so only those files' references move.
   */
  const recordSent = useCallback(
    (filePaths: string[]) => captureReferences(contentsOf(filePaths), 'handoff'),
    [contentsOf, captureReferences],
  );

  return { handOff, ensureSaved, recordSent };
}
