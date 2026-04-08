import { memo, useRef, useLayoutEffect, forwardRef, useImperativeHandle, useMemo } from 'react';
import DOMPurify from 'dompurify';
import type { MdComment } from '../types';
import { getEffectiveStatus } from '../types';
import { stripInlineFormatting } from '../lib/comment-parser';
import { assignHeadingIds } from '../lib/heading-slugs';
import { useMermaidRenderer } from '../hooks/useMermaidRenderer';
import { collectVisibleTextNodes } from '../lib/visible-text';
import {
  applyMermaidHighlightStyles,
  getMermaidHighlightTheme,
  scheduleMermaidLayoutStabilization,
} from '../lib/mermaid-highlights';

export interface ViewerContextMenuInfo {
  /** 'selection' when user right-clicks on selected text; 'highlight' when on a comment mark */
  type: 'selection' | 'highlight';
  /** Comment IDs (only for 'highlight' type) */
  commentIds?: string[];
  /** Screen coordinates for the menu */
  x: number;
  y: number;
}

interface Props {
  html: string;
  cleanMarkdown: string;
  comments: MdComment[];
  activeCommentId: string | null;
  selectionText: string | null;
  selectionOffset: number | null;
  onHighlightClick: (commentId: string) => void;
  onLocalLinkClick?: (path: string, fragment?: string) => void;
  onContextMenu?: (info: ViewerContextMenuInfo) => void;
  enableResolve?: boolean;
  searchQuery?: string;
  searchActiveIndex?: number;
  onSearchCount?: (count: number) => void;
  theme?: string;
}

export interface TocHeading {
  id: string;
  text: string;
  level: number; // 1-6
}

export interface MarkdownViewerHandle {
  getContainer: () => HTMLElement | null;
  scrollToComment: (commentId: string) => void;
  getActiveMark: () => HTMLElement | null;
  getActiveMarks: () => HTMLElement[];
  getHeadings: () => TocHeading[];
}

// React.memo prevents re-renders from parent state changes that don't affect our props.
// Combined with ref-based innerHTML (no dangerouslySetInnerHTML), React never touches
// the container's children — our useLayoutEffect is the sole DOM manager.
export const MarkdownViewer = memo(
  forwardRef<MarkdownViewerHandle, Props>(function MarkdownViewer(
    {
      html,
      cleanMarkdown,
      comments,
      activeCommentId,
      selectionText,
      selectionOffset,
      onHighlightClick,
      onLocalLinkClick,
      onContextMenu: onCtxMenu,
      enableResolve,
      searchQuery,
      searchActiveIndex,
      onSearchCount,
      theme,
    },
    ref,
  ) {
    const containerRef = useRef<HTMLDivElement>(null);
    const activeMarkRef = useRef<HTMLElement | null>(null);
    const searchCountCb = useRef(onSearchCount);
    searchCountCb.current = onSearchCount;

    // Mermaid rendering
    const mermaidSvgMap = useMermaidRenderer(cleanMarkdown, theme || 'light');

    // Build a mapping from clean markdown offsets to rendered/plain text offsets.
    // cleanOffset lives in clean-markdown space (with ** ## etc), but DOM text is
    // in rendered space (formatting stripped). We need to convert before matching.
    const toPlainOffset = useMemo(
      () => stripInlineFormatting(cleanMarkdown).toPlainOffset,
      [cleanMarkdown],
    );

    useImperativeHandle(ref, () => ({
      getContainer: () => containerRef.current,
      scrollToComment: (commentId: string) => {
        if (!containerRef.current) return;
        const marks = containerRef.current.querySelectorAll(
          '.comment-highlight, .mermaid-comment-highlight',
        );
        const mark = Array.from(marks).find((m) =>
          (m as HTMLElement).dataset.commentIds?.split(',').includes(commentId),
        );
        if (mark) {
          mark.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      },
      getActiveMark: () => activeMarkRef.current,
      getActiveMarks: () => {
        if (!containerRef.current) return [];
        return Array.from(
          containerRef.current.querySelectorAll(
            '.comment-highlight-active, .mermaid-comment-highlight-active',
          ),
        ) as HTMLElement[];
      },
      getHeadings: () => {
        if (!containerRef.current) return [];
        const els = containerRef.current.querySelectorAll('h1, h2, h3, h4, h5, h6');
        return Array.from(els).map((el) => ({
          id: el.id,
          text: el.textContent?.trim() || '',
          level: parseInt(el.tagName[1], 10),
        }));
      },
    }));

    // Set innerHTML and apply highlights after React commits.
    // We manage innerHTML ourselves (no dangerouslySetInnerHTML) so React's
    // reconciliation never interferes with our DOM modifications.
    useLayoutEffect(() => {
      const container = containerRef.current;
      if (!container) return;

      // Set innerHTML from scratch — guarantees a clean starting state
      // Defense-in-depth: rehype-sanitize is the primary sanitizer, but
      // DOMPurify provides a second layer in case of a remark/rehype bypass.
      container.innerHTML = DOMPurify.sanitize(html, {
        USE_PROFILES: { html: true },
        ADD_TAGS: ['mark'],
        ADD_ATTR: ['data-comment-ids', 'data-mdr-local-md', 'data-mdr-fragment'],
      });

      // --- Heading IDs ---
      assignHeadingIds(container);

      // --- Mermaid blocks ---
      const mermaidPres = container.querySelectorAll('pre');
      for (const pre of mermaidPres) {
        const code = pre.querySelector('code.language-mermaid');
        if (!code) continue;

        const source = (code.textContent || '').trim();
        if (!source) continue;

        const result = mermaidSvgMap.get(source);
        if (result?.svg) {
          const wrapper = document.createElement('div');
          wrapper.className = 'mermaid-block';
          const svgDiv = document.createElement('div');
          svgDiv.className = 'mermaid-svg';
          // SVG is already sanitized via DOMPurify in mermaid-renderer.ts
          svgDiv.innerHTML = result.svg;
          wrapper.appendChild(svgDiv);
          pre.replaceWith(wrapper);
        } else if (result?.error) {
          const errDiv = document.createElement('div');
          errDiv.className = 'mermaid-block mermaid-error';
          errDiv.textContent = `Mermaid error: ${result.error}`;
          pre.replaceWith(errDiv);
        }
        // If no result yet (loading), leave the code block as-is until SVGs are ready
      }

      // --- Comment highlights ---
      // Group comments that share the same anchor AND cleanOffset (exact same highlight).
      // Convert cleanOffset (clean markdown space) → plainOffset (rendered text space)
      // so wrapText can correctly match against DOM text node positions.
      const highlightGroups = new Map<
        string,
        {
          ids: string[];
          anchor: string;
          plainOffset?: number;
          contextBefore?: string;
          contextAfter?: string;
        }
      >();
      for (const comment of comments) {
        if (enableResolve && getEffectiveStatus(comment) === 'resolved') continue;
        const plainOffset =
          comment.cleanOffset != null ? toPlainOffset(comment.cleanOffset) : undefined;
        const key = `${comment.cleanOffset ?? ''}:${comment.anchor}`;
        const group = highlightGroups.get(key) || {
          ids: [],
          anchor: comment.anchor,
          plainOffset,
          contextBefore: comment.contextBefore,
          contextAfter: comment.contextAfter,
        };
        group.ids.push(comment.id);
        highlightGroups.set(key, group);
      }

      for (const {
        anchor,
        ids,
        plainOffset,
        contextBefore,
        contextAfter,
      } of highlightGroups.values()) {
        wrapText(
          container,
          anchor,
          (mark) => {
            mark.className = 'comment-highlight';
            mark.dataset.commentIds = ids.join(',');
            if (ids.includes(activeCommentId || '')) {
              mark.classList.add('comment-highlight-active');
            }
          },
          plainOffset,
          contextBefore,
          contextAfter,
        );
      }

      // IMPORTANT: Mermaid highlight quirks (do NOT refactor to class-based styles):
      // 1. Chrome ignores class-based background-color on inline elements inside
      //    SVG foreignObject — only inline style="..." works.
      // 2. CSS text-decoration on <mark> prevents text wrapping inside foreignObject.
      // 3. CSS background shorthand (e.g. linear-gradient) also prevents wrapping.
      // 4. Headless Chromium does NOT reproduce these issues — can't verify headlessly.
      // Solution: keep the <mark> but swap class styles for inline styles.
      const mermaidTheme = getMermaidHighlightTheme(getComputedStyle(document.documentElement));
      for (const mark of container.querySelectorAll(
        '.mermaid-block mark.comment-highlight, .mermaid-block mark.comment-highlight-active',
      )) {
        const el = mark as HTMLElement;
        const isActive = el.classList.contains('comment-highlight-active');
        el.classList.remove('comment-highlight', 'comment-highlight-active');
        el.classList.add('mermaid-comment-highlight');
        if (isActive) {
          el.classList.add('mermaid-comment-highlight-active');
        }
        applyMermaidHighlightStyles(el, mermaidTheme, isActive);
      }
      const cleanupMermaidLayout = scheduleMermaidLayoutStabilization(container);

      // --- Selection highlight ---
      if (selectionText) {
        wrapText(
          container,
          selectionText,
          (mark) => {
            mark.className = 'selection-highlight';
          },
          selectionOffset ?? undefined,
        );
      }

      // --- Search highlights ---
      if (searchQuery) {
        const count = highlightSearchMatches(container, searchQuery, searchActiveIndex ?? 0);
        searchCountCb.current?.(count);
      } else {
        searchCountCb.current?.(0);
      }

      // Store reference to the active mark for drag handles
      activeMarkRef.current = container.querySelector(
        '.comment-highlight-active, .mermaid-comment-highlight-active',
      ) as HTMLElement | null;

      return cleanupMermaidLayout;
    }, [
      html,
      comments,
      activeCommentId,
      selectionText,
      selectionOffset,
      toPlainOffset,
      enableResolve,
      searchQuery,
      searchActiveIndex,
      mermaidSvgMap,
    ]);

    const handleClick = (e: React.MouseEvent) => {
      const link = (e.target as HTMLElement).closest(
        'a[data-mdr-local-md]',
      ) as HTMLAnchorElement | null;
      if (link) {
        e.preventDefault();
        const path = link.dataset.mdrLocalMd;
        if (path) {
          onLocalLinkClick?.(path, link.dataset.mdrFragment);
        }
        return;
      }

      const mark = (e.target as HTMLElement).closest(
        '.comment-highlight, .mermaid-comment-highlight',
      ) as HTMLElement | null;
      if (mark?.dataset.commentIds) {
        const ids = mark.dataset.commentIds.split(',');
        onHighlightClick(ids[0]);
      }
    };

    const handleContextMenu = (e: React.MouseEvent) => {
      if (!onCtxMenu) return;

      // Check if right-click is on a comment highlight
      const mark = (e.target as HTMLElement).closest(
        '.comment-highlight, .mermaid-comment-highlight',
      ) as HTMLElement | null;
      if (mark?.dataset.commentIds) {
        e.preventDefault();
        const ids = mark.dataset.commentIds.split(',');
        onCtxMenu({ type: 'highlight', commentIds: ids, x: e.clientX, y: e.clientY });
        return;
      }

      // Check if there is a text selection within the container
      const sel = window.getSelection();
      if (
        sel &&
        sel.toString().trim().length > 0 &&
        containerRef.current?.contains(sel.anchorNode)
      ) {
        e.preventDefault();
        onCtxMenu({ type: 'selection', x: e.clientX, y: e.clientY });
        return;
      }
    };

    return (
      <div
        ref={containerRef}
        className="prose max-w-none prose-headings:scroll-mt-4
          prose-h1:text-2xl prose-h1:font-bold prose-h1:border-b prose-h1:pb-2
          prose-h2:text-xl prose-h2:font-semibold prose-h2:mt-8
          prose-h3:text-lg prose-h3:font-medium
          prose-p:leading-relaxed
          prose-table:text-sm
          prose-th:font-semibold
          prose-code:rounded prose-code:px-1 prose-code:py-0.5 prose-code:text-sm prose-code:font-normal prose-code:before:content-none prose-code:after:content-none"
        onClick={handleClick}
        onContextMenu={handleContextMenu}
      />
    );
  }),
);

/** Find an occurrence of `text` in the container's text nodes and wrap it in <mark> elements.
 *  When `hintOffset` is provided (in rendered/plain-text space), uses it to disambiguate
 *  duplicate anchor text. When `contextBefore`/`contextAfter` are provided, uses them as
 *  primary disambiguation (more reliable than offset across coordinate spaces).
 *  Handles text that spans multiple DOM elements. */
function wrapText(
  container: HTMLElement,
  text: string,
  configure: (mark: HTMLElement) => void,
  hintOffset?: number,
  contextBefore?: string,
  contextAfter?: string,
) {
  // Collect ALL text nodes — include those inside marks to support overlapping highlights
  const allTextNodes = collectVisibleTextNodes(container);
  if (allTextNodes.length === 0) return;

  // Build concatenated text with position tracking (all nodes, for offset-based matching)
  const allNodeInfo: { node: Text; globalStart: number; length: number }[] = [];
  let allPos = 0;
  for (const tn of allTextNodes) {
    const len = tn.textContent?.length || 0;
    allNodeInfo.push({ node: tn, globalStart: allPos, length: len });
    allPos += len;
  }
  const fullText = allTextNodes.map((n) => n.textContent || '').join('');

  // Find the match
  let matchStart: number;
  let matchEnd: number;

  if (hintOffset != null) {
    // Collect ALL occurrences to support context-based disambiguation
    const allOccs: number[] = [];
    let sf = 0;
    while (sf < fullText.length) {
      const idx = fullText.indexOf(text, sf);
      if (idx === -1) break;
      allOccs.push(idx);
      sf = idx + 1;
    }

    if (allOccs.length > 0) {
      let best: number;
      if (allOccs.length === 1) {
        best = allOccs[0];
      } else if (contextBefore || contextAfter) {
        // Context-based disambiguation: context strings are from the same
        // DOM textContent space as fullText, so compare directly (no normalization).
        let bestScore = -1;
        let bestDist = Infinity;
        best = allOccs[0];
        for (const occ of allOccs) {
          let score = 0;
          if (contextBefore) {
            const before = fullText.slice(Math.max(0, occ - contextBefore.length), occ);
            for (let j = 1; j <= Math.min(before.length, contextBefore.length); j++) {
              if (before[before.length - j] === contextBefore[contextBefore.length - j]) score++;
              else break;
            }
          }
          if (contextAfter) {
            const after = fullText.slice(
              occ + text.length,
              occ + text.length + contextAfter.length,
            );
            for (let j = 0; j < Math.min(after.length, contextAfter.length); j++) {
              if (after[j] === contextAfter[j]) score++;
              else break;
            }
          }
          const dist = Math.abs(occ - hintOffset);
          if (score > bestScore || (score === bestScore && dist < bestDist)) {
            bestScore = score;
            best = occ;
            bestDist = dist;
          }
        }
      } else {
        // No context — use the existing hintOffset proximity with search window.
        // When the anchor is drag-expanded backwards, it can start well before
        // the hint (the marker stays put but the anchor grows leftward).
        const searchWindow = Math.max(20, text.length);
        const exactIdx = fullText.indexOf(text, Math.max(0, hintOffset - searchWindow));
        if (exactIdx !== -1 && exactIdx <= hintOffset + 20) {
          best = exactIdx;
        } else {
          best = allOccs.reduce((b, idx) =>
            Math.abs(idx - hintOffset) < Math.abs(b - hintOffset) ? idx : b,
          );
        }
      }
      matchStart = best;
      matchEnd = best + text.length;
    } else {
      // No exact match — try flexible whitespace search
      const result = flexibleSearch(fullText, text);
      if (!result) return;
      matchStart = result.start;
      matchEnd = result.end;
    }
  } else {
    // No offset — first occurrence (used for selection highlights)
    const exactIdx = fullText.indexOf(text);
    if (exactIdx !== -1) {
      matchStart = exactIdx;
      matchEnd = exactIdx + text.length;
    } else {
      const result = flexibleSearch(fullText, text);
      if (!result) return;
      matchStart = result.start;
      matchEnd = result.end;
    }
  }

  // Determine which text nodes the match spans and their local offsets
  const wraps: { node: Text; start: number; end: number }[] = [];
  for (const info of allNodeInfo) {
    const nodeEnd = info.globalStart + info.length;
    if (nodeEnd <= matchStart || info.globalStart >= matchEnd) continue;
    const localStart = Math.max(0, matchStart - info.globalStart);
    const localEnd = Math.min(info.length, matchEnd - info.globalStart);
    if (localStart < localEnd) {
      wraps.push({ node: info.node, start: localStart, end: localEnd });
    }
  }
  if (wraps.length === 0) return;

  // Filter out whitespace-only portions
  const visibleWraps = wraps.filter(({ node: tn, start, end }) => {
    const slice = tn.textContent?.slice(start, end) || '';
    return slice.trim().length > 0;
  });
  if (visibleWraps.length === 0) return;

  // Group wraps by block parent so we merge wraps within the same block
  // (e.g. text nodes split by <strong>) into a single <mark>, while creating
  // separate marks for wraps in different blocks (e.g. different <li>s).
  const groups: { node: Text; start: number; end: number }[][] = [];
  let currentGroup: (typeof groups)[0] = [];
  let currentBlock: Element | null = null;

  for (const w of visibleWraps) {
    const block = getBlockParent(w.node);
    if (block !== currentBlock && currentGroup.length > 0) {
      groups.push(currentGroup);
      currentGroup = [];
    }
    currentBlock = block;
    currentGroup.push(w);
  }
  if (currentGroup.length > 0) groups.push(currentGroup);

  // Process each group in reverse to avoid invalidating earlier positions
  for (let g = groups.length - 1; g >= 0; g--) {
    const group = groups[g];
    if (group.length > 1) {
      // Multiple wraps in the same block — use Range to wrap them in a single
      // <mark>.  extractContents() splits partially-selected inline elements
      // (e.g. <strong>), preserving formatting while producing one mark (no seam).
      const mark = document.createElement('mark');
      configure(mark);

      const firstWrap = group[0];
      const lastWrap = group[group.length - 1];
      const range = document.createRange();
      range.setStart(firstWrap.node, firstWrap.start);
      range.setEnd(lastWrap.node, lastWrap.end);

      try {
        const fragment = range.extractContents();
        mark.appendChild(fragment);
        range.insertNode(mark);
      } catch {
        // Skip if extraction fails
      }
    } else {
      // Single wrap in this block — use surroundContents
      const { node: tn, start, end } = group[0];
      const range = document.createRange();
      range.setStart(tn, start);
      range.setEnd(tn, end);
      const mark = document.createElement('mark');
      configure(mark);
      try {
        range.surroundContents(mark);
      } catch {
        try {
          const fragment = range.extractContents();
          mark.appendChild(fragment);
          range.insertNode(mark);
        } catch {
          // Skip if all wrapping fails
        }
      }
    }
  }
}

const BLOCK_TAGS = new Set([
  'P',
  'LI',
  'DIV',
  'BLOCKQUOTE',
  'TD',
  'TH',
  'DD',
  'DT',
  'PRE',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'SECTION',
  'ARTICLE',
]);

function getBlockParent(node: Node): Element | null {
  let el = node.parentElement;
  while (el) {
    if (BLOCK_TAGS.has(el.tagName)) return el;
    el = el.parentElement;
  }
  return null;
}

/**
 * Search for `needle` in `haystack` with flexible whitespace matching.
 * Whitespace runs in the needle can match zero or more whitespace chars in the haystack,
 * handling cross-element selections where sel.toString() adds newlines that aren't in text nodes.
 */
function flexibleSearch(
  haystack: string,
  needle: string,
  startFrom: number = 0,
): { start: number; end: number } | null {
  const parts = needle.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;
  if (parts.length === 1) {
    const idx = haystack.indexOf(parts[0], startFrom);
    return idx === -1 ? null : { start: idx, end: idx + parts[0].length };
  }

  let searchFrom = startFrom;
  while (searchFrom < haystack.length) {
    const firstIdx = haystack.indexOf(parts[0], searchFrom);
    if (firstIdx === -1) return null;

    let pos = firstIdx + parts[0].length;
    let matched = true;
    for (let i = 1; i < parts.length; i++) {
      // Skip optional whitespace between segments
      while (pos < haystack.length && /\s/.test(haystack[pos])) pos++;
      if (haystack.startsWith(parts[i], pos)) {
        pos += parts[i].length;
      } else {
        matched = false;
        break;
      }
    }
    if (matched) return { start: firstIdx, end: pos };
    searchFrom = firstIdx + 1;
  }
  return null;
}

/** Find all case-insensitive occurrences of `query` in the container's text and wrap them
 *  in <mark class="search-highlight"> elements. The match at `activeIndex` gets an additional
 *  `search-highlight-active` class and is scrolled into view. */
export function highlightSearchMatches(
  container: HTMLElement,
  query: string,
  activeIndex: number,
): number {
  const textNodes = collectVisibleTextNodes(container);
  if (textNodes.length === 0) return 0;

  const nodeInfo: { node: Text; globalStart: number; length: number }[] = [];
  let pos = 0;
  for (const n of textNodes) {
    const len = n.textContent?.length || 0;
    nodeInfo.push({ node: n, globalStart: pos, length: len });
    pos += len;
  }
  const fullText = textNodes.map((n) => n.textContent || '').join('');
  const lowerFull = fullText.toLowerCase();
  const lowerQuery = query.toLowerCase();

  // Find all non-overlapping match positions
  const matches: { start: number; end: number }[] = [];
  let searchPos = 0;
  while (searchPos < lowerFull.length) {
    const idx = lowerFull.indexOf(lowerQuery, searchPos);
    if (idx === -1) break;
    matches.push({ start: idx, end: idx + query.length });
    searchPos = idx + query.length;
  }
  if (matches.length === 0) return 0;

  // Process matches in reverse to preserve earlier text node positions
  for (let i = matches.length - 1; i >= 0; i--) {
    const match = matches[i];
    const isActive = i === activeIndex;

    // Collect text node portions spanning this match
    const wraps: { node: Text; start: number; end: number }[] = [];
    for (const info of nodeInfo) {
      const nodeEnd = info.globalStart + info.length;
      if (nodeEnd <= match.start || info.globalStart >= match.end) continue;
      const localStart = Math.max(0, match.start - info.globalStart);
      const localEnd = Math.min(info.length, match.end - info.globalStart);
      if (localStart < localEnd) wraps.push({ node: info.node, start: localStart, end: localEnd });
    }

    // Wrap each portion in reverse order within this match
    for (let w = wraps.length - 1; w >= 0; w--) {
      const { node: wn, start, end } = wraps[w];
      const range = document.createRange();
      range.setStart(wn, start);
      range.setEnd(wn, end);
      const mark = document.createElement('mark');
      mark.className = isActive ? 'search-highlight search-highlight-active' : 'search-highlight';
      if (isActive) mark.dataset.searchActive = 'true';
      try {
        range.surroundContents(mark);
      } catch {
        try {
          const fragment = range.extractContents();
          mark.appendChild(fragment);
          range.insertNode(mark);
        } catch {
          /* skip */
        }
      }
    }
  }

  // Scroll active match into view
  const activeMark = container.querySelector('mark[data-search-active]');
  if (activeMark) {
    activeMark.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  return matches.length;
}
