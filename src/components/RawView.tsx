import { useRef, useEffect, useLayoutEffect, useImperativeHandle, forwardRef, useCallback, useMemo, useState } from 'react';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkFrontmatter from 'remark-frontmatter';
import remarkGfm from 'remark-gfm';
import { highlightSearchMatches } from './MarkdownViewer';
import { COMMENT_MARKER_RE, parseComments } from '../lib/comment-parser';
import { uniqueSlugs } from '../lib/heading-slugs';
import { computeDiff, type DiffLine } from '../lib/diff';
import { SplitIconButton } from './SplitIconButton';

// Markdown syntax highlighting patterns (order matters — first match wins per region)
interface SyntaxRule {
  pattern: RegExp;
  className: string;
}

const SYNTAX_RULES: SyntaxRule[] = [
  // Comment markers — highest priority
  { pattern: COMMENT_MARKER_RE, className: 'raw-comment-marker' },
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
}

interface Props {
  rawMarkdown: string;
  searchQuery?: string;
  searchActiveIndex?: number;
  onSearchCount?: (count: number) => void;
  activeCommentId: string | null;
  diffSnapshot?: string | null;
  diffEnabled?: boolean;
  onDiffToggle?: () => void;
  onClearSnapshot?: () => void;
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
  COMMENT_MARKER_RE.lastIndex = 0;
  const cleanRaw = rawMarkdown.replace(COMMENT_MARKER_RE, '');
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
  COMMENT_MARKER_RE.lastIndex = 0;
  let cm: RegExpExecArray | null;
  while ((cm = COMMENT_MARKER_RE.exec(raw)) !== null) {
    const region: Region = {
      start: cm.index,
      end: cm.index + cm[0].length,
      className: 'raw-comment-marker',
    };
    try {
      const jsonStr = cm[0].replace(/^<!-- @comment/, '').replace(/ -->$/, '');
      const parsed = JSON.parse(jsonStr);
      if (parsed.id) region.id = parsed.id;
    } catch { /* ignore parse errors */ }
    commentRegions.push(region);
  }

  // Step 2: Collect other syntax matches, skipping any that overlap comment markers
  const otherRegions: Region[] = [];
  for (const rule of SYNTAX_RULES) {
    if (rule.className === 'raw-comment-marker') continue;
    rule.pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rule.pattern.exec(raw)) !== null) {
      const start = m.index;
      const end = m.index + m[0].length;
      // Skip if this region overlaps any comment marker
      const overlapsComment = commentRegions.some(c => start < c.end && end > c.start);
      if (!overlapsComment) {
        otherRegions.push({ start, end, className: rule.className });
      }
    }
  }

  // Step 3: Merge and sort all regions
  const allRegions = [...commentRegions, ...otherRegions];
  allRegions.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));

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
    parts.push(`<span class="${r.className}"${idAttr}>${escapeHtml(raw.slice(r.start, r.end))}</span>`);
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
  { rawMarkdown, searchQuery, searchActiveIndex, onSearchCount, activeCommentId, diffSnapshot, diffEnabled, onDiffToggle, onClearSnapshot },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const tableRef = useRef<HTMLDivElement>(null);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout>>(null);
  const [copyFeedback, setCopyFeedback] = useState(false);
  const [showComments, setShowComments] = useState(true);

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

  // Diff computation — compare clean markdown (without comment markers) so that
  // marker additions/removals don't appear as content changes
  const diffLines = useMemo<DiffLine[] | null>(() => {
    if (!diffEnabled || !diffSnapshot) return null;
    const { cleanMarkdown: oldClean } = parseComments(diffSnapshot);
    const { cleanMarkdown: newClean } = parseComments(rawMarkdown);
    return computeDiff(oldClean, newClean);
  }, [diffEnabled, diffSnapshot, rawMarkdown]);

  const oldHighlightedHtml = useMemo(
    () => (diffEnabled && diffSnapshot ? buildHighlightedHtml(diffSnapshot) : ''),
    [diffEnabled, diffSnapshot],
  );

  const oldLineHtmls = useMemo(() => {
    if (!diffEnabled || !diffSnapshot) return [];
    return splitHighlightedHtml(diffSnapshot, oldHighlightedHtml);
  }, [diffEnabled, diffSnapshot, oldHighlightedHtml]);

  const displayRows = useMemo<DisplayRow[]>(() => {
    if (!diffLines) {
      return lineHtmls.map((html, i) => ({
        type: 'same' as const,
        html,
        lineNo: i + 1,
        sourceLineIndex: i,
      }));
    }
    return diffLines.map((dl) => {
      if (dl.type === 'removed') {
        const oldIdx = (dl.oldLineNo ?? 1) - 1;
        return {
          type: 'removed' as const,
          html: oldLineHtmls[oldIdx] ?? '',
          lineNo: dl.oldLineNo,
          sourceLineIndex: undefined,
        };
      }
      const newIdx = (dl.newLineNo ?? 1) - 1;
      return {
        type: dl.type,
        html: lineHtmls[newIdx] ?? '',
        lineNo: dl.newLineNo,
        sourceLineIndex: newIdx,
      };
    });
  }, [diffLines, lineHtmls, oldLineHtmls]);

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
        const localActive = (activeGlobal >= cumulative && activeGlobal < cumulative + counts[i])
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

    tableRef.current.querySelectorAll('.raw-comment-marker-active').forEach(el => {
      el.classList.remove('raw-comment-marker-active');
    });

    if (activeCommentId) {
      const markers = tableRef.current.querySelectorAll(`[data-comment-id="${CSS.escape(activeCommentId)}"]`);
      for (const marker of markers) {
        if (!marker.closest('.raw-line-diff-removed')) {
          marker.classList.add('raw-comment-marker-active');
          break;
        }
      }
    }
  }, [activeCommentId, displayRows]);

  /** Find the scrollable container (descendant or ancestor). */
  const getScrollParent = useCallback((): Element | null => {
    if (!containerRef.current) return null;
    // The scroll container is a descendant (flex-1 overflow-y-auto) in pinned toolbar layout
    return containerRef.current.querySelector('.overflow-y-auto')
      ?? containerRef.current.closest('.overflow-y-auto');
  }, []);

  const scrollToComment = useCallback((commentId: string) => {
    if (!tableRef.current || !containerRef.current) return;

    // Re-enable comment markers if hidden so the marker is visible
    setShowComments(true);

    // Defer scroll to next frame so display:none is removed first
    requestAnimationFrame(() => {
      if (!tableRef.current) return;
      const marker = tableRef.current.querySelector(`[data-comment-id="${CSS.escape(commentId)}"]`);
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
        tableRef.current?.querySelectorAll('.raw-comment-marker-flash').forEach(el => {
          el.classList.remove('raw-comment-marker-flash');
        });
      }
      marker.classList.add('raw-comment-marker-flash');
      flashTimerRef.current = setTimeout(() => marker.classList.remove('raw-comment-marker-flash'), 1500);
    });
  }, [getScrollParent]);

  const scrollToHeading = useCallback((headingId: string) => {
    if (!tableRef.current) return;
    const headingLine = tableRef.current.querySelector(`.raw-line[data-heading-id="${CSS.escape(headingId)}"]`);
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
  }, [getScrollParent]);

  useImperativeHandle(ref, () => ({ scrollToComment, scrollToHeading }), [scrollToComment, scrollToHeading]);

  const copyTimerRef = useRef<ReturnType<typeof setTimeout>>(null);
  useEffect(() => {
    return () => { if (copyTimerRef.current) clearTimeout(copyTimerRef.current); };
  }, []);

  const showCopyFeedback = useCallback(() => {
    setCopyFeedback(true);
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    copyTimerRef.current = setTimeout(() => setCopyFeedback(false), 2000);
  }, []);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(rawMarkdown).then(showCopyFeedback, () => {});
  }, [rawMarkdown, showCopyFeedback]);

  const handleCopyWithoutComments = useCallback(() => {
    COMMENT_MARKER_RE.lastIndex = 0;
    const clean = rawMarkdown.replace(COMMENT_MARKER_RE, '');
    navigator.clipboard.writeText(clean).then(showCopyFeedback, () => {});
  }, [rawMarkdown, showCopyFeedback]);

  const hasChanges = diffLines ? diffLines.some((l) => l.type !== 'same') : true;
  const hasDiffSnapshot = diffSnapshot != null;

  const toggleClass = (active: boolean) =>
    `text-[11px] px-2 py-0.5 rounded-md font-medium transition-colors ${
      active
        ? 'bg-primary-bg-strong text-primary-text'
        : 'text-content-secondary hover:bg-tint'
    }`;

  const actionClass = 'text-[11px] rounded px-2 py-0.5 transition-colors text-content-secondary hover:text-content hover:bg-tint';

  const toolbar = (
    <div className="raw-toolbar">
      <div className="raw-toolbar-left">
        <button
          className={toggleClass(showComments)}
          onClick={() => setShowComments((v) => !v)}
          title={showComments ? 'Hide comment markers' : 'Show comment markers'}
        >
          Comments
        </button>
        {hasDiffSnapshot && onDiffToggle && (
          <button
            className={toggleClass(!!diffEnabled)}
            onClick={onDiffToggle}
            title={diffEnabled ? 'Hide diff overlay' : 'Show diff since snapshot'}
          >
            Diff
          </button>
        )}
      </div>
      <div className="raw-toolbar-right">
        {hasDiffSnapshot && onClearSnapshot && (
          <button
            className={actionClass}
            onClick={onClearSnapshot}
            title="Clear diff snapshot"
          >
            Clear snapshot
          </button>
        )}
        <SplitIconButton
          icon={
            copyFeedback ? (
              <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
              </svg>
            ) : (
              <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15.666 3.888A2.25 2.25 0 0013.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 01-.75.75H9.75a.75.75 0 01-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 01-2.25 2.25H6.75A2.25 2.25 0 014.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 011.927-.184" />
              </svg>
            )
          }
          onClick={handleCopy}
          title={copyFeedback ? 'Copied!' : 'Copy document'}
          chevronTitle="Copy options"
          menu={[
            { label: 'Copy without comments', onClick: handleCopyWithoutComments },
          ]}
        />
      </div>
    </div>
  );

  const containerClass = `raw-view flex flex-col h-full${showComments ? '' : ' raw-view-comments-hidden'}`;

  if (diffEnabled && diffLines && !hasChanges) {
    return (
      <div ref={containerRef} className={containerClass}>
        {toolbar}
        <div className="flex flex-col items-center justify-center flex-1 text-content-muted px-6">
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
          <p className="text-sm font-medium text-content-secondary mb-1">No changes yet</p>
          <p className="text-xs text-center leading-relaxed max-w-xs">
            This view updates automatically when the file is modified.
            <br />
            Hand off to an agent and changes will appear here.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div ref={containerRef} className={containerClass}>
      {toolbar}

      <div className="flex-1 overflow-y-auto px-8 pt-4 pb-[50vh] lg:px-12 xl:px-16">
        <div className="max-w-3xl mx-auto">
          <div ref={tableRef} className="raw-view-table">
            {displayRows.map((row, i) => {
              const diffClass = row.type === 'added'
                ? 'raw-line-diff-added'
                : row.type === 'removed'
                  ? 'raw-line-diff-removed'
                  : '';
              return (
                <div
                  key={i}
                  className={`raw-line ${diffClass}`}
                  data-heading-id={row.sourceLineIndex != null ? headingIdsByLine.get(row.sourceLineIndex) : undefined}
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
