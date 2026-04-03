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
  // When the target is an Element (not a Text node), the offset refers to
  // the Nth child node.  Resolve to the corresponding text node so the
  // walker can match it.
  let resolvedNode = targetNode;
  let resolvedOffset = offset;
  if (targetNode.nodeType !== Node.TEXT_NODE && targetNode.childNodes.length > 0) {
    if (offset < targetNode.childNodes.length) {
      resolvedNode = targetNode.childNodes[offset];
      resolvedOffset = 0;
    } else {
      // offset === childNodes.length means "after last child" — point to end of last text node
      const last = targetNode.childNodes[targetNode.childNodes.length - 1];
      resolvedNode = last;
      resolvedOffset = last.textContent?.length ?? 0;
    }
    // If we landed on another element, descend to its first text node
    while (resolvedNode.nodeType !== Node.TEXT_NODE && resolvedNode.firstChild) {
      resolvedNode = resolvedNode.firstChild;
      resolvedOffset = 0;
    }
  }

  let total = 0;
  const walker = createVisibleTextWalker(root);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    if (node === resolvedNode) {
      return total + resolvedOffset;
    }
    total += node.textContent?.length || 0;
  }
  return total;
}
