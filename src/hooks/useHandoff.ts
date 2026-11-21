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
  copyAgentPrompt: (filePaths: string[]) => Promise<boolean>;
  captureReferences: (entries: ReadonlyMap<string, string>, origin: 'handoff') => void;
  showToast: ShowToast;
}

/**
 * The Hand off button's flow, and the save check the review banner shares.
 *
 * An agent reads the files on disk, not the tabs, so a handoff waits until
 * every file it names has saved. The diff reference for each handed-off file
 * is its text at the click, recorded only once the clipboard write succeeds:
 * a failed copy hands nothing off, and a file the picker left out (even the
 * active one) keeps its reference.
 */
export function useHandoff({
  activeFilePath,
  rawMarkdownRef,
  tabs,
  getSaveState,
  copyAgentPrompt,
  captureReferences,
  showToast,
}: UseHandoffParams) {
  const ensureSaved = useCallback(
    (filePaths: string[]): boolean => {
      for (const path of filePaths) {
        const state = getSaveState(path);
        if (state === 'saving') {
          showToast('Still saving your comments. Try again in a moment.', 'error');
          return false;
        }
        if (state === 'failed') {
          showToast(
            `${getPathBasename(path)} didn't save, so an agent would miss your latest comments.`,
            'error',
          );
          return false;
        }
      }
      return true;
    },
    [getSaveState, showToast],
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

  const handOff = useCallback(
    async (filePaths: string[]): Promise<void> => {
      if (filePaths.length === 0 || !ensureSaved(filePaths)) return;
      const atClick = contentsOf(filePaths);
      if (await copyAgentPrompt(filePaths)) captureReferences(atClick, 'handoff');
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
