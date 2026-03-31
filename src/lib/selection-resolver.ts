import type { SelectionInfo } from '../types';
import { getVisibleTextContent, getVisibleTextOffset } from './visible-text';

export function resolveSelection(containerEl: HTMLElement): SelectionInfo | null {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) return null;

  const text = sel.toString().trim();
  if (!text || text.length < 2) return null;

  const range = sel.getRangeAt(0);
  if (!containerEl.contains(range.commonAncestorContainer)) return null;

  // Get surrounding context from the rendered text
  const fullText = getVisibleTextContent(containerEl);
  const selStart = getVisibleTextOffset(containerEl, range.startContainer, range.startOffset);

  const contextBefore = fullText.slice(Math.max(0, selStart - 40), selStart);
  const contextAfter = fullText.slice(selStart + text.length, selStart + text.length + 40);

  const rect = range.getBoundingClientRect();

  return {
    text,
    rect,
    contextBefore,
    contextAfter,
    offset: selStart,
  };
}
