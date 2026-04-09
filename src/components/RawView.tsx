import {
  useRef,
  useEffect,
  useLayoutEffect,
  useImperativeHandle,
  forwardRef,
  useCallback,
  useMemo,
  useState,
  type RefObject,
} from 'react';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkFrontmatter from 'remark-frontmatter';
import remarkGfm from 'remark-gfm';
import { highlightSearchMatches } from './MarkdownViewer';
import { createCommentMarkerRegex } from '../lib/comment-parser';
import { uniqueSlugs } from '../lib/heading-slugs';
import { type DiffLine } from '../lib/diff';

// Markdown syntax highlighting patterns (order matters — first match wins per region)
interface SyntaxRule {
  pattern: RegExp;
  className: string;
}

// Comment markers are handled separately via createCommentMarkerRegex() so
// they get a fresh /g regex per call (no shared lastIndex). The other
// patterns below have no overlap risk because each rule iterates and resets
// independently within the same function scope.
const SYNTAX_RULES: SyntaxRule[] = [
  // Fenced code blocks (``` or ~~~)
  { pattern: /^(`{3,}|~{3,}).*$(?:\n[\s\S]*?)?^(\1)/gm, className: 'raw-code-block' },
  // Inline code
  { pattern: /`[^`\n]+`/g, className: 'raw-inline-code' },
  // Headings
  { pattern: /^#{1,6}\s.*$/gm, className: 'raw-heading' },
  // Bold
  { pattern: /\*\*[^*]+\*\*/g, className: 'raw-bold' },
  // Italic (but not inside bold)
  { pattern: /(?<!\*)\*[^*\n]+\*(?!\*)/g, className: 'raw-italic' },
  // Links [text](url)
  { pattern: /\[([^\]]+)\]\([^)]+\)/g, className: 'raw-link' },
  // Blockquotes
  { pattern: /^>\s.*$/gm, className: 'raw-blockquote' },
  // List markers
  { pattern: /^(\s*)([-*+]|\d+\.)\s/gm, className: 'raw-list-marker' },
  // Horizontal rules (3+ of the same character)
  { pattern: /^(-{3,}|\*{3,}|_{3,})\s*$/gm, className: 'raw-hr' },
  // Table pipes
  { pattern: /^\|.*\|$/gm, className: 'raw-table' },
  // Frontmatter — no `m` flag so ^ only matches start of string
  { pattern: /^---\n[\s\S]*?\n---/g, className: 'raw-frontmatter' },
  // HTML comments (non-@comment ones)
  { pattern: /<!--(?! @comment)[\s\S]*?-->/g, className: 'raw-html-comment' },
];

export interface RawViewHandle {
  scrollToComment: (commentId: string) => void;
  scrollToHeading: (headingId: string) => void;
  diffPrev: () => void;
  diffNext: () => void;
}

interface Props {
  rawMarkdown: string;
  searchQuery?: string;
  searchActiveIndex?: number;
  onSearchCount?: (count: number) => void;
  activeCommentId: string | null;
  diffSnapshot?: string | null;
  diffEnabled?: boolean;
  /**
   * Pre-computed diff lines from the App-level useDiffLines hook. RawView
   * no longer recomputes; this guarantees raw and rendered views see the
   * same change set and lets the panel toolbar show the chunk badge before
   * the user enters diff mode.
   */
  diffLines?: DiffLine[] | null;
  /**
   * Maps a 1-indexed clean line number (from a DiffLine's oldLineNo /
   * newLineNo, since the diff is computed on cleanMarkdown) back to a
   * 0-indexed raw line index. Without this, an edit on the body line
   * directly below a comment marker would render the marker row as the
   * changed row in raw view.
   */
  oldCleanToRawLine?: number[];
  newCleanToRawLine?: number[];
  /**
   * Ref attached to the inner scroll container. Lifted out so App-level
   * scroll-bound hooks (heading tracking, drag handles, selection) bind to
   * the actual scrolling element rather than a non-scrolling outer wrapper.
   */
  scrollContainerRef?: RefObject<HTMLDivElement | null>;
}

interface DisplayRow {
  type: 'same' | 'added' | 'removed';
  html: string;
  lineNo: number | undefined;
  sourceLineIndex?: number;
}

type Region = { start: number; end: number; className: string; id?: string };
type MarkdownAstNode = {
  type: string;
  depth?: number;
  value?: string;
  alt?: string;
  children?: MarkdownAstNode[];
  position?: {
    start?: {
      line?: number;
    };
  };
};

export interface RawHeading {
  id: string;
  text: string;
  level: number;
  lineIndex: number;
}

const rawHeadingProcessor = unified()
  .use(remarkParse)
  .use(remarkFrontmatter, ['yaml', 'toml'])
  .use(remarkGfm);

function extractNodeText(node: MarkdownAstNode): string {
  if (node.type === 'text' || node.type === 'inlineCode' || node.type === 'html') {
    return node.value ?? '';
  }
  if (node.type === 'image') {
    return node.alt ?? '';
  }
  if (node.type === 'break') {
    return ' ';
  }
  return node.children?.map(extractNodeText).join('') ?? '';
}

export function extractRawHeadings(rawMarkdown: string): RawHeading[] {
  const cleanRaw = rawMarkdown.replace(createCommentMarkerRegex(), '');
  const tree = rawHeadingProcessor.parse(cleanRaw) as MarkdownAstNode;
  const headings: Array<{ text: string; level: number; lineIndex: number }> = [];

  const visit = (node: MarkdownAstNode) => {
    if (node.type === 'heading') {
      const line = node.position?.start?.line;
      if (line != null) {
        headings.push({
          text: extractNodeText(node).trim(),
          level: node.depth ?? 1,
          lineIndex: Math.max(0, line - 1),
        });
      }
    }
    node.children?.forEach(visit);
  };

  visit(tree);

  const ids = uniqueSlugs(headings.map((heading) => heading.text));
  return headings.map((heading, index) => ({
    ...heading,
    id: ids[index],
  }));
}

/**
 * Build highlighted HTML from raw markdown text.
 * Returns the full HTML string with <span> wrappers for syntax highlighting.
 */
export function buildHighlightedHtml(raw: string): string {
  // Step 1: Collect comment marker matches first (they have absolute priority)
  const commentRegions: Region[] = [];
  const commentRe = createCommentMarkerRegex();
  let cm: RegExpExecArray | null;
  while ((cm = commentRe.exec(raw)) !== null) {
    const region: Region = {
      start: cm.index,
      end: cm.index + cm[0].length,
      className: 'raw-comment-marker',
    };
    try {
      const jsonStr = cm[0].replace(/^<!-- @comment/, '').replace(/ -->$/, '');
      const parsed = JSON.parse(jsonStr);
      if (parsed.id) region.id = parsed.id;
    } catch {
      /* ignore parse errors */
    }
    commentRegions.push(region);
  }

  // Step 2: Collect other syntax matches, skipping any that overlap comment markers.
  // SYNTAX_RULES holds module-scoped /g regexes; resetting lastIndex is essential
  // because buildHighlightedHtml is called repeatedly (every keystroke). Cloning
  // would also work but is more allocation-heavy.
  const otherRegions: Region[] = [];
  for (const rule of SYNTAX_RULES) {
    rule.pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rule.pattern.exec(raw)) !== null) {
      const start = m.index;
      const end = m.index + m[0].length;
      // Skip if this region overlaps any comment marker
      const overlapsComment = commentRegions.some((c) => start < c.end && end > c.start);
      if (!overlapsComment) {
        otherRegions.push({ start, end, className: rule.className });
      }
    }
  }

  // Step 3: Merge and sort all regions
  const allRegions = [...commentRegions, ...otherRegions];
  allRegions.sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start));

  // Step 4: Remove overlapping regions among non-comment rules (first match wins)
  const filtered: Region[] = [];
  let lastEnd = 0;
  for (const r of allRegions) {
    if (r.start >= lastEnd) {
      filtered.push(r);
      lastEnd = r.end;
    }
  }

  // Build HTML string
  const parts: string[] = [];
  let cursor = 0;

  for (const r of filtered) {
    if (r.start > cursor) {
      parts.push(escapeHtml(raw.slice(cursor, r.start)));
    }
    const idAttr = r.id ? ` data-comment-id="${escapeAttr(r.id)}"` : '';
    parts.push(
      `<span class="${r.className}"${idAttr}>${escapeHtml(raw.slice(r.start, r.end))}</span>`,
    );
    cursor = r.end;
  }

  if (cursor < raw.length) {
    parts.push(escapeHtml(raw.slice(cursor)));
  }

  return parts.join('');
}

/**
 * Split highlighted HTML into per-line segments matching the source line count.
 * Handles spans that cross line boundaries by closing/reopening tags.
 */
export function splitHighlightedHtml(raw: string, fullHtml: string): string[] {
  const lines = raw.split('\n');
  const result: string[] = [];
  let current = '';
  const openTags: string[] = [];
  let i = 0;

  while (i < fullHtml.length) {
    if (fullHtml[i] === '\n') {
      for (let t = openTags.length - 1; t >= 0; t--) {
        current += '</span>';
      }
      result.push(current);
      current = '';
      for (const tag of openTags) {
        current += tag;
      }
      i++;
    } else if (fullHtml[i] === '<') {
      const closeMatch = fullHtml.slice(i).match(/^<\/span>/);
      if (closeMatch) {
        current += closeMatch[0];
        openTags.pop();
        i += closeMatch[0].length;
      } else {
        const openMatch = fullHtml.slice(i).match(/^<span[^>]*>/);
        if (openMatch) {
          current += openMatch[0];
          openTags.push(openMatch[0]);
          i += openMatch[0].length;
        } else {
          current += fullHtml[i];
          i++;
        }
      }
    } else {
      current += fullHtml[i];
      i++;
    }
  }
  for (let t = openTags.length - 1; t >= 0; t--) {
    current += '</span>';
  }
  result.push(current);

  while (result.length < lines.length) result.push('');
  return result;
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

export const RawView = forwardRef<RawViewHandle, Props>(function RawView(
  {
    rawMarkdown,
    searchQuery,
    searchActiveIndex,
    onSearchCount,
    activeCommentId,
    diffSnapshot,
    diffEnabled,
    diffLines: diffLinesProp,
    oldCleanToRawLine,
    newCleanToRawLine,
    scrollContainerRef,
  },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const internalScrollRef = useRef<HTMLDivElement>(null);
  const scrollRef = scrollContainerRef ?? internalScrollRef;
  const tableRef = useRef<HTMLDivElement>(null);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout>>(null);
  const [activeDiffChunk, setActiveDiffChunk] = useState(0);

  // Clean up flash timer on unmount
  useEffect(() => {
    return () => {
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    };
  }, []);

  const highlightedHtml = useMemo(() => buildHighlightedHtml(rawMarkdown), [rawMarkdown]);
  const rawHeadings = useMemo(() => extractRawHeadings(rawMarkdown), [rawMarkdown]);
  const headingIdsByLine = useMemo(
    () => new Map(rawHeadings.map((heading) => [heading.lineIndex, heading.id])),
    [rawHeadings],
  );

  const lineHtmls = useMemo(
    () => splitHighlightedHtml(rawMarkdown, highlightedHtml),
    [rawMarkdown, highlightedHtml],
  );

  // Diff lines come from the App-level useDiffLines hook so the raw and
  // rendered views are guaranteed to render the same change set.
  const diffLines = diffLinesProp ?? null;

  const oldHighlightedHtml = useMemo(
    () => (diffEnabled && diffSnapshot ? buildHighlightedHtml(diffSnapshot) : ''),
    [diffEnabled, diffSnapshot],
  );

  const oldLineHtmls = useMemo(() => {
    if (!diffEnabled || !diffSnapshot) return [];
    return splitHighlightedHtml(diffSnapshot, oldHighlightedHtml);
  }, [diffEnabled, diffSnapshot, oldHighlightedHtml]);

  const displayRows = useMemo<DisplayRow[]>(() => {
    // Only switch to the diff row layout when the overlay is enabled.
    // diffLines may exist (snapshot present) without the overlay being on —
    // in that case render the normal line list so the chunk count badge
    // can show without altering what the user sees.
    if (!diffEnabled || !diffLines) {
      return lineHtmls.map((html, i) => ({
        type: 'same' as const,
        html,
        lineNo: i + 1,
        sourceLineIndex: i,
      }));
    }
    // The diff is computed on cleanMarkdown (markers stripped), so dl.oldLineNo
    // and dl.newLineNo are clean line numbers. Map them back to raw line
    // indices via the per-snapshot maps before indexing into the raw line HTML
    // arrays — otherwise an edit on a body line just below a comment marker
    // would surface the marker row in the diff overlay.
    //
    // We also re-interleave the new file's marker lines as unchanged context
    // rows so the raw view actually shows what's in the file. Markers stay
    // visible (with their normal highlight) but aren't tracked as diff
    // chunks — comment metadata changes are surfaced in the comments
    // sidebar, not the diff overlay.
    const contentRawIdxSet = new Set<number>(newCleanToRawLine ?? []);
    const totalRawLines = lineHtmls.length;
    const rows: DisplayRow[] = [];
    let nextRawIdx = 0;

    const emitMarkersUpTo = (limitRawIdx: number) => {
      while (nextRawIdx < limitRawIdx && nextRawIdx < totalRawLines) {
        if (!contentRawIdxSet.has(nextRawIdx)) {
          rows.push({
            type: 'same',
            html: lineHtmls[nextRawIdx] ?? '',
            lineNo: nextRawIdx + 1,
            sourceLineIndex: nextRawIdx,
          });
        }
        nextRawIdx++;
      }
    };

    for (const dl of diffLines) {
      if (dl.type === 'removed') {
        const cleanIdx = (dl.oldLineNo ?? 1) - 1;
        const oldIdx = oldCleanToRawLine?.[cleanIdx] ?? cleanIdx;
        rows.push({
          type: 'removed',
          html: oldLineHtmls[oldIdx] ?? '',
          lineNo: oldIdx + 1,
          sourceLineIndex: undefined,
        });
        // removed lines live in old line space, so don't advance the new-file cursor
        continue;
      }
      const cleanIdx = (dl.newLineNo ?? 1) - 1;
      const newIdx = newCleanToRawLine?.[cleanIdx] ?? cleanIdx;
      // Emit any marker lines that sit between the previous content line and
      // this one in the new raw markdown.
      emitMarkersUpTo(newIdx);
      rows.push({
        type: dl.type,
        html: lineHtmls[newIdx] ?? '',
        lineNo: newIdx + 1,
        sourceLineIndex: newIdx,
      });
      nextRawIdx = newIdx + 1;
    }

    // Trailing marker lines after the last content row.
    emitMarkersUpTo(totalRawLines);

    return rows;
  }, [diffEnabled, diffLines, lineHtmls, oldLineHtmls, oldCleanToRawLine, newCleanToRawLine]);

  // Diff chunks: contiguous groups of changed (added/removed) rows. Computed
  // from displayRows (not diffLines) because we now interleave unchanged
  // marker rows into the display, so the row indices used by prev/next
  // navigation and scroll-to-chunk must reflect the rendered row positions,
  // not the position of changes within the original diff line list.
  const diffChunks = useMemo(() => {
    const chunks: { startRow: number; endRow: number }[] = [];
    let inChunk = false;
    let start = 0;
    for (let i = 0; i < displayRows.length; i++) {
      const changed = displayRows[i].type !== 'same';
      if (changed && !inChunk) {
        inChunk = true;
        start = i;
      } else if (!changed && inChunk) {
        inChunk = false;
        chunks.push({ startRow: start, endRow: i - 1 });
      }
    }
    if (inChunk) chunks.push({ startRow: start, endRow: displayRows.length - 1 });
    return chunks;
  }, [displayRows]);

  // Reset active chunk when diff changes
  useEffect(() => {
    setActiveDiffChunk(0);
  }, [diffChunks.length]);

  // When the user enables the diff overlay, jump to the first change so they
  // land where the action is instead of having to hunt for it. Two RAFs let
  // the new diff rows render before we measure for scroll. We track both RAF
  // handles in a single ref so the effect cleanup can cancel either one.
  useEffect(() => {
    if (!diffEnabled || diffChunks.length === 0) return;
    let outerHandle = 0;
    let innerHandle = 0;
    outerHandle = requestAnimationFrame(() => {
      innerHandle = requestAnimationFrame(() => {
        const chunk = diffChunks[0];
        if (!chunk || !tableRef.current || !scrollRef.current) return;
        const rows = tableRef.current.querySelectorAll('.raw-line');
        const targetRow = rows[chunk.startRow];
        if (!targetRow) return;
        const rowRect = targetRow.getBoundingClientRect();
        const parentRect = scrollRef.current.getBoundingClientRect();
        scrollRef.current.scrollTo({
          top: scrollRef.current.scrollTop + rowRect.top - parentRect.top - 40,
          behavior: 'smooth',
        });
      });
    });
    return () => {
      cancelAnimationFrame(outerHandle);
      cancelAnimationFrame(innerHandle);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [diffEnabled, diffChunks.length]);

  const scrollToDiffChunk = useCallback(
    (index: number) => {
      const chunk = diffChunks[index];
      if (!chunk || !tableRef.current) return;
      const scrollParent = scrollRef.current;
      if (!scrollParent) return;
      const rows = tableRef.current.querySelectorAll('.raw-line');
      const targetRow = rows[chunk.startRow];
      if (!targetRow) return;
      const rowRect = targetRow.getBoundingClientRect();
      const parentRect = scrollParent.getBoundingClientRect();
      scrollParent.scrollTo({
        top: scrollParent.scrollTop + rowRect.top - parentRect.top - 40,
        behavior: 'smooth',
      });
    },
    [diffChunks, scrollRef],
  );

  const handleDiffPrev = useCallback(() => {
    const next = activeDiffChunk > 0 ? activeDiffChunk - 1 : diffChunks.length - 1;
    setActiveDiffChunk(next);
    scrollToDiffChunk(next);
  }, [activeDiffChunk, diffChunks.length, scrollToDiffChunk]);

  const handleDiffNext = useCallback(() => {
    const next = activeDiffChunk < diffChunks.length - 1 ? activeDiffChunk + 1 : 0;
    setActiveDiffChunk(next);
    scrollToDiffChunk(next);
  }, [activeDiffChunk, diffChunks.length, scrollToDiffChunk]);

  // Set innerHTML for each line cell and apply search highlights
  useLayoutEffect(() => {
    if (!tableRef.current) return;
    const codeCells = tableRef.current.querySelectorAll<HTMLElement>('.raw-line-content');
    codeCells.forEach((cell, i) => {
      cell.innerHTML = displayRows[i]?.html || '';
    });

    // Apply search highlights across all content cells (skip removed lines).
    if (searchQuery) {
      const counts: number[] = [];
      codeCells.forEach((cell, i) => {
        if (displayRows[i]?.type === 'removed') {
          counts.push(0);
          return;
        }
        const count = highlightSearchMatches(cell, searchQuery, -1);
        counts.push(count);
      });
      const totalCount = counts.reduce((a, b) => a + b, 0);

      let cumulative = 0;
      codeCells.forEach((cell, i) => {
        if (displayRows[i]?.type === 'removed') return;
        cell.innerHTML = displayRows[i]?.html || '';
        const activeGlobal = searchActiveIndex ?? 0;
        const localActive =
          activeGlobal >= cumulative && activeGlobal < cumulative + counts[i]
            ? activeGlobal - cumulative
            : -1;
        highlightSearchMatches(cell, searchQuery, localActive);
        cumulative += counts[i];
      });
      onSearchCount?.(totalCount);
    } else {
      onSearchCount?.(0);
    }
  }, [displayRows, searchQuery, searchActiveIndex, onSearchCount]);

  // Highlight active comment marker (only in current content, not removed lines)
  useLayoutEffect(() => {
    if (!tableRef.current) return;

    tableRef.current.querySelectorAll('.raw-comment-marker-active').forEach((el) => {
      el.classList.remove('raw-comment-marker-active');
    });

    if (activeCommentId) {
      const markers = tableRef.current.querySelectorAll(
        `[data-comment-id="${CSS.escape(activeCommentId)}"]`,
      );
      for (const marker of markers) {
        if (!marker.closest('.raw-line-diff-removed')) {
          marker.classList.add('raw-comment-marker-active');
          break;
        }
      }
    }
  }, [activeCommentId, displayRows]);

  /** The inner scroll container (sibling of the toolbar in pinned-toolbar layout). */
  const getScrollParent = useCallback((): Element | null => scrollRef.current, [scrollRef]);

  const scrollToComment = useCallback(
    (commentId: string) => {
      if (!tableRef.current || !containerRef.current) return;

      // Defer scroll to next frame so layout is settled
      requestAnimationFrame(() => {
        if (!tableRef.current) return;
        const marker = tableRef.current.querySelector(
          `[data-comment-id="${CSS.escape(commentId)}"]`,
        );
        if (!marker) return;

        const scrollParent = getScrollParent();
        if (scrollParent) {
          const markerRect = marker.getBoundingClientRect();
          const parentRect = scrollParent.getBoundingClientRect();
          const offset = markerRect.top - parentRect.top - parentRect.height / 3;
          scrollParent.scrollTop += offset;
        }

        // Clear previous flash animation
        if (flashTimerRef.current) {
          clearTimeout(flashTimerRef.current);
          tableRef.current?.querySelectorAll('.raw-comment-marker-flash').forEach((el) => {
            el.classList.remove('raw-comment-marker-flash');
          });
        }
        marker.classList.add('raw-comment-marker-flash');
        flashTimerRef.current = setTimeout(
          () => marker.classList.remove('raw-comment-marker-flash'),
          1500,
        );
      });
    },
    [getScrollParent],
  );

  const scrollToHeading = useCallback(
    (headingId: string) => {
      if (!tableRef.current) return;
      const headingLine = tableRef.current.querySelector(
        `.raw-line[data-heading-id="${CSS.escape(headingId)}"]`,
      );
      if (!headingLine) return;

      const scrollParent = getScrollParent();
      if (scrollParent) {
        const lineRect = headingLine.getBoundingClientRect();
        const parentRect = scrollParent.getBoundingClientRect();
        scrollParent.scrollTo({
          top: scrollParent.scrollTop + lineRect.top - parentRect.top,
          behavior: 'smooth',
        });
        return;
      }

      headingLine.scrollIntoView({ behavior: 'smooth', block: 'start' });
    },
    [getScrollParent],
  );

  useImperativeHandle(
    ref,
    () => ({
      scrollToComment,
      scrollToHeading,
      diffPrev: handleDiffPrev,
      diffNext: handleDiffNext,
    }),
    [scrollToComment, scrollToHeading, handleDiffPrev, handleDiffNext],
  );

  const hasChanges = diffLines ? diffLines.some((l) => l.type !== 'same') : true;
  const onlyCommentsChanged =
    diffEnabled && diffLines && !hasChanges && diffSnapshot !== rawMarkdown;

  // flex-1 min-h-0 (not h-full): RawView is now a flex sibling of the panel
  // toolbar, so it must shrink to fill the remaining space rather than claim
  // the full parent height — otherwise the bottom of the scroll container
  // overflows by exactly the toolbar's height and bleeds into the footer.
  const outerClass = 'raw-view flex flex-col flex-1 min-h-0';
  const scrollClass = 'flex-1 overflow-y-auto px-8 pt-4 pb-[50vh] lg:px-12 xl:px-16';

  if (diffEnabled && diffLines && !hasChanges) {
    return (
      <div ref={containerRef} className={outerClass}>
        <div ref={scrollRef} className={scrollClass}>
          <div className="flex flex-col items-center justify-center text-content-muted py-16">
            <svg
              className="w-12 h-12 mb-3 text-content-faint"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={1.5}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
            {onlyCommentsChanged ? (
              <>
                <p className="text-sm font-medium text-content-secondary mb-1">
                  No content changes
                </p>
                <p className="text-xs text-center leading-relaxed max-w-xs">
                  Comment threads were updated since your snapshot.
                  <br />
                  Open the comments sidebar to review.
                </p>
              </>
            ) : (
              <>
                <p className="text-sm font-medium text-content-secondary mb-1">No changes yet</p>
                <p className="text-xs text-center leading-relaxed max-w-xs">
                  This view updates automatically when the file is modified.
                  <br />
                  Hand off to an agent and changes will appear here.
                </p>
              </>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div ref={containerRef} className={outerClass}>
      <div ref={scrollRef} className={scrollClass}>
        <div className="max-w-3xl mx-auto">
          <div ref={tableRef} className="raw-view-table">
            {displayRows.map((row, i) => {
              const diffClass =
                row.type === 'added'
                  ? 'raw-line-diff-added'
                  : row.type === 'removed'
                    ? 'raw-line-diff-removed'
                    : '';
              return (
                <div
                  key={i}
                  className={`raw-line ${diffClass}`}
                  data-heading-id={
                    row.sourceLineIndex != null
                      ? headingIdsByLine.get(row.sourceLineIndex)
                      : undefined
                  }
                >
                  <span className="raw-line-number">{row.lineNo}</span>
                  <span className="raw-line-content" />
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
});
