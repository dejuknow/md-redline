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

function isHiddenTextContainer(el: Element): boolean {
  // SVG tag names keep their case (`desc`, `defs`), HTML ones are upper case.
  return HIDDEN_TEXT_ANCESTOR_TAGS.has(el.tagName.toUpperCase());
}

/** Whether `node` is, or sits inside, an element whose text never shows. */
function inHiddenTextContainer(node: Node): boolean {
  let el: Element | null =
    node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  while (el) {
    if (isHiddenTextContainer(el)) return true;
    el = el.parentElement;
  }
  return false;
}

/**
 * Walks the text nodes under `root` a reader can see. A hidden container
 * (`<style>`, SVG `<defs>`) is rejected as an element, which skips its whole
 * subtree, so a walk costs one visit per node. Testing each text node's
 * ancestors instead cost a climb to the root per node, and the comment
 * highlight pass walks the document once per comment: on a long document with
 * many comments that climb was most of the time it took to show the document.
 */
export function createVisibleTextWalker(root: Node): TreeWalker {
  // Hidden ancestors above the root hide everything in it; checked once.
  const rootHidden = inHiddenTextContainer(root);
  return document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      if (rootHidden) return NodeFilter.FILTER_REJECT;
      if (node.nodeType === Node.TEXT_NODE) return NodeFilter.FILTER_ACCEPT;
      return isHiddenTextContainer(node as Element)
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_SKIP;
    },
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
    // A target that holds no text of its own (a horizontal rule, an image, an
    // empty element) is never yielded by this walker, and falling out of the
    // loop would report the whole container's length: the END of the document
    // for a selection that starts at its beginning. The first text node after
    // it in document order marks the same position.
    if (
      resolvedNode.nodeType !== Node.TEXT_NODE &&
      resolvedNode.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING
    ) {
      return total;
    }
    total += node.textContent?.length || 0;
  }
  return total;
}
