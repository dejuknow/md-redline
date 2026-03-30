import { useRef, useEffect, useLayoutEffect, useImperativeHandle, forwardRef, useCallback, useMemo, useState } from 'react';
import { highlightSearchMatches } from './MarkdownViewer';
import { COMMENT_MARKER_RE } from '../lib/comment-parser';

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
}

interface Props {
  rawMarkdown: string;
  searchQuery?: string;
  searchActiveIndex?: number;
  onSearchCount?: (count: number) => void;
  activeCommentId: string | null;
}

type Region = { start: number; end: number; className: string; id?: string };

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
  { rawMarkdown, searchQuery, searchActiveIndex, onSearchCount, activeCommentId },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const tableRef = useRef<HTMLDivElement>(null);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout>>(null);
  const [copyFeedback, setCopyFeedback] = useState(false);

  // Clean up flash timer on unmount
  useEffect(() => {
    return () => {
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    };
  }, []);

  const highlightedHtml = useMemo(() => buildHighlightedHtml(rawMarkdown), [rawMarkdown]);

  // Split the highlighted HTML into per-line segments.
  // We split the *source* into lines, build highlighted HTML for each,
  // so line numbers always match 1:1 with actual newlines.
  const lineHtmls = useMemo(() => {
    const lines = rawMarkdown.split('\n');
    const fullHtml = highlightedHtml;

    // We need to split the HTML at newline boundaries. Since we escaped \n as literal
    // text in the HTML, we can split on literal \n in the output.
    // But spans can cross line boundaries (e.g. comment markers spanning multiple lines).
    // Strategy: walk through the HTML, track open tags, and split at \n characters
    // that appear in text content (not inside tags).
    const result: string[] = [];
    let current = '';
    const openTags: string[] = []; // stack of open tag strings for re-opening
    let i = 0;

    while (i < fullHtml.length) {
      if (fullHtml[i] === '\n') {
        // Close any open tags for this line
        for (let t = openTags.length - 1; t >= 0; t--) {
          current += '</span>';
        }
        result.push(current);
        current = '';
        // Re-open tags for next line
        for (const tag of openTags) {
          current += tag;
        }
        i++;
      } else if (fullHtml[i] === '<') {
        // Parse the tag
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
    // Push the last line
    for (let t = openTags.length - 1; t >= 0; t--) {
      current += '</span>';
    }
    result.push(current);

    // Should match source line count
    while (result.length < lines.length) result.push('');

    return result;
  }, [rawMarkdown, highlightedHtml]);

  // Set innerHTML for each line cell and apply search highlights
  useLayoutEffect(() => {
    if (!tableRef.current) return;
    const codeCells = tableRef.current.querySelectorAll<HTMLElement>('.raw-line-content');
    codeCells.forEach((cell, i) => {
      cell.innerHTML = lineHtmls[i] || '';
    });

    // Apply search highlights across all content cells.
    // First pass: count matches per cell. Second pass: highlight with correct active index.
    if (searchQuery) {
      // Count matches per cell without highlighting
      const counts: number[] = [];
      codeCells.forEach(cell => {
        const count = highlightSearchMatches(cell, searchQuery, -1);
        counts.push(count);
      });
      const totalCount = counts.reduce((a, b) => a + b, 0);

      // Re-set innerHTML and highlight with correct active index
      let cumulative = 0;
      codeCells.forEach((cell, i) => {
        cell.innerHTML = lineHtmls[i] || '';
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
  }, [lineHtmls, searchQuery, searchActiveIndex, onSearchCount]);

  // Highlight active comment marker
  useLayoutEffect(() => {
    if (!tableRef.current) return;

    tableRef.current.querySelectorAll('.raw-comment-marker-active').forEach(el => {
      el.classList.remove('raw-comment-marker-active');
    });

    if (activeCommentId) {
      const marker = tableRef.current.querySelector(`[data-comment-id="${CSS.escape(activeCommentId)}"]`);
      if (marker) {
        marker.classList.add('raw-comment-marker-active');
      }
    }
  }, [activeCommentId, lineHtmls]);

  const scrollToComment = useCallback((commentId: string) => {
    if (!tableRef.current || !containerRef.current) return;
    const marker = tableRef.current.querySelector(`[data-comment-id="${CSS.escape(commentId)}"]`);
    if (!marker) return;

    const scrollParent = containerRef.current.closest('.overflow-y-auto');
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
  }, []);

  useImperativeHandle(ref, () => ({ scrollToComment }), [scrollToComment]);

  const handleCopyClean = useCallback(() => {
    COMMENT_MARKER_RE.lastIndex = 0;
    const clean = rawMarkdown.replace(COMMENT_MARKER_RE, '');
    navigator.clipboard.writeText(clean).then(
      () => {
        setCopyFeedback(true);
        setTimeout(() => setCopyFeedback(false), 2000);
      },
      () => { /* clipboard write failed */ },
    );
  }, [rawMarkdown]);

  return (
    <div ref={containerRef} className="raw-view relative">
      {/* Copy clean button */}
      <button
        onClick={handleCopyClean}
        className="raw-copy-clean-btn"
        title="Copy markdown without comment markers"
      >
        {copyFeedback ? (
          <>
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
            </svg>
            Copied
          </>
        ) : (
          <>
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.666 3.888A2.25 2.25 0 0013.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 01-.75.75H9.75a.75.75 0 01-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 01-2.25 2.25H6.75A2.25 2.25 0 014.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 011.927-.184" />
            </svg>
            Copy clean
          </>
        )}
      </button>

      <div ref={tableRef} className="raw-view-table">
        {lineHtmls.map((_, i) => (
          <div key={i} className="raw-line">
            <span className="raw-line-number">{i + 1}</span>
            <span className="raw-line-content" />
          </div>
        ))}
      </div>
    </div>
  );
});
