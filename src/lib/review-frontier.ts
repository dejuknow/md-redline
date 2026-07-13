export interface FrontierAdvanceInput {
  /** The resolve feature (settings.enableResolve). Auto-advance only when on. */
  resolveEnabled: boolean;
  /** Whether the active file currently has a diff reference. */
  hasReference: boolean;
  /** Active file's open-comment count on the previous evaluation. */
  prevOpenCount: number;
  /** Active file's open-comment count now. */
  openCount: number;
  /** Whether this episode already advanced (Undo/re-fire guard). */
  alreadyAdvanced: boolean;
  /** Whether the active file changed since the previous evaluation. */
  fileChanged: boolean;
  /**
   * Whether the resolve setting changed since the previous evaluation; the
   * open-count is not comparable across it (resolve OFF counts ALL comments,
   * ON counts only non-resolved ones).
   */
  resolveEnabledChanged: boolean;
}

/**
 * Decide whether the diff reference should advance to the current content.
 * True only on a genuine open-comment ">0 then 0" crossing for the same file,
 * with a reference present, the resolve feature on, and not already advanced.
 */
export function shouldAdvanceFrontier(input: FrontierAdvanceInput): boolean {
  if (input.fileChanged) return false;
  if (input.resolveEnabledChanged) return false;
  if (!input.resolveEnabled) return false;
  if (!input.hasReference) return false;
  if (input.openCount > 0) return false;
  if (input.alreadyAdvanced) return false;
  return input.prevOpenCount > 0;
}

/** Human label for the diff reference, e.g. "Since last handoff, 3:14 PM". */
export function formatReferenceLabel(ref: {
  origin: 'handoff' | 'review';
  capturedAt: number;
}): string {
  const time = new Date(ref.capturedAt).toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  });
  const what = ref.origin === 'handoff' ? 'Since last handoff' : 'Since last review';
  return `${what}, ${time}`;
}
