import type { SelectionInfo } from '../types';
import { getVisibleTextContent, getVisibleTextOffset } from './visible-text';

export function resolveSelection(containerEl: HTMLElement): SelectionInfo | null {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) return null;

  const rawText = sel.toString();
  const text = rawText.trim();
  if (!text || text.length < 2) return null;

  const range = sel.getRangeAt(0);
  if (!containerEl.contains(range.commonAncestorContainer)) return null;

  // Get surrounding context from the rendered text
  const fullText = getVisibleTextContent(containerEl);
  const selStart = getVisibleTextOffset(containerEl, range.startContainer, range.startOffset);

  // Adjust for leading whitespace that trim() removed so context windows
  // align with the trimmed anchor text, not the raw selection boundaries.
  const leadingTrim = rawText.length - rawText.trimStart().length;
  const adjustedStart = selStart + leadingTrim;
  const selEnd = adjustedStart + text.length;

  const contextBefore = fullText.slice(Math.max(0, adjustedStart - 40), adjustedStart);
  const contextAfter = fullText.slice(selEnd, selEnd + 40);

  const rect = range.getBoundingClientRect();

  return {
    text,
    rect,
    contextBefore,
    contextAfter,
    offset: adjustedStart,
  };
}
