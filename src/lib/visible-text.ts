const HIDDEN_TEXT_ANCESTOR_TAGS = new Set([
  'STYLE',
  'SCRIPT',
  'NOSCRIPT',
  'TEMPLATE',
  'TITLE',
  'DESC',
  'DEFS',
  'METADATA',
]);

function shouldIgnoreTextNode(node: Text): boolean {
  let el = node.parentElement;
  while (el) {
    if (HIDDEN_TEXT_ANCESTOR_TAGS.has(el.tagName.toUpperCase())) return true;
    el = el.parentElement;
  }
  return false;
}

export function createVisibleTextWalker(root: Node): TreeWalker {
  return document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      shouldIgnoreTextNode(node as Text) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  });
}

export function collectVisibleTextNodes(root: Node): Text[] {
  const walker = createVisibleTextWalker(root);
  const textNodes: Text[] = [];
  let node: Text | null;
  while ((node = walker.nextNode() as Text | null)) {
    textNodes.push(node);
  }
  return textNodes;
}

export function getVisibleTextContent(root: Node): string {
  return collectVisibleTextNodes(root)
    .map((node) => node.textContent || '')
    .join('');
}

export function getVisibleTextOffset(root: Node, targetNode: Node, offset: number): number {
  let total = 0;
  const walker = createVisibleTextWalker(root);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    if (node === targetNode) {
      return total + offset;
    }
    total += node.textContent?.length || 0;
  }
  return total;
}
