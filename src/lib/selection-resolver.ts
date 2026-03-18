import type { SelectionInfo } from '../types';

export function resolveSelection(
  containerEl: HTMLElement
): SelectionInfo | null {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) return null;

  const text = sel.toString().trim();
  if (!text || text.length < 2) return null;

  const range = sel.getRangeAt(0);
  if (!containerEl.contains(range.commonAncestorContainer)) return null;

  // Get surrounding context from the rendered text
  const fullText = containerEl.textContent || '';
  const selStart = getTextOffset(
    containerEl,
    range.startContainer,
    range.startOffset
  );

  const contextBefore = fullText.slice(Math.max(0, selStart - 40), selStart);
  const contextAfter = fullText.slice(
    selStart + text.length,
    selStart + text.length + 40
  );

  const rect = range.getBoundingClientRect();

  return {
    text,
    rect,
    contextBefore,
    contextAfter,
  };
}

function getTextOffset(
  root: Node,
  targetNode: Node,
  offset: number
): number {
  let total = 0;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    if (node === targetNode) {
      return total + offset;
    }
    total += node.textContent?.length || 0;
  }
  return total;
}
