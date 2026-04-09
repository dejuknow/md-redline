import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { type DiffLine } from '../lib/diff';
import { renderMarkdown } from '../markdown/pipeline';

export type DiffSegmentType = 'same' | 'added' | 'removed';

export interface DiffSegment {
  type: DiffSegmentType;
  text: string;
  /** Index into the chunk list when type !== 'same'; otherwise undefined */
  chunkIndex?: number;
}

/**
 * Group a flat DiffLine[] into contiguous segments by type, joining the text
 * with newlines so each segment can be rendered through the markdown pipeline
 * as a self-contained block. Adjacent added+removed lines collapse into two
 * neighboring segments (one removed, one added) — never one mixed segment.
 *
 * Each non-`same` segment is assigned a sequential `chunkIndex`. Adjacent
 * removed+added segments share the same chunk index so the diff button's
 * "next change" jumps the user to a logical change boundary instead of
 * counting removed and added halves separately.
 */
export function segmentDiff(diffLines: DiffLine[]): DiffSegment[] {
  const segments: DiffSegment[] = [];
  let buf: string[] = [];
  let bufType: DiffSegmentType | null = null;

  const flush = () => {
    if (bufType === null) return;
    segments.push({ type: bufType, text: buf.join('\n') });
    buf = [];
    bufType = null;
  };

  for (const line of diffLines) {
    if (bufType === null || line.type !== bufType) {
      flush();
      bufType = line.type;
    }
    buf.push(line.text);
  }
  flush();

  // Assign chunk indices: adjacent removed+added share an index.
  let chunkIdx = -1;
  let lastWasChange = false;
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    if (s.type === 'same') {
      lastWasChange = false;
      continue;
    }
    if (!lastWasChange) chunkIdx++;
    s.chunkIndex = chunkIdx;
    lastWasChange = true;
  }

  return segments;
}

/** Number of distinct chunks (logical change boundaries) in a segment list. */
export function countChunks(segments: DiffSegment[]): number {
  let max = -1;
  for (const s of segments) {
    if (s.chunkIndex != null && s.chunkIndex > max) max = s.chunkIndex;
  }
  return max + 1;
}

interface FenceRange {
  /** 1-indexed line number of the opening fence line. */
  start: number;
  /** 1-indexed line number of the closing fence line (inclusive). */
  end: number;
}

/**
 * Find fenced-code regions in a markdown source. Returns 1-indexed inclusive
 * line ranges. Recognizes ``` and ~~~ fences (with leading indent up to 3
 * spaces, per CommonMark). An unclosed fence extends to EOF.
 *
 * Exported for unit testing.
 */
export function findFenceRanges(text: string): FenceRange[] {
  const lines = text.split('\n');
  const ranges: FenceRange[] = [];
  let openLine = -1;
  let openMarkerChar = '';
  let openMarkerLen = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(lines[i]);
    if (!m) continue;
    const marker = m[1];
    if (openLine === -1) {
      openLine = i;
      openMarkerChar = marker[0];
      openMarkerLen = marker.length;
    } else if (marker[0] === openMarkerChar && marker.length >= openMarkerLen) {
      ranges.push({ start: openLine + 1, end: i + 1 });
      openLine = -1;
    }
  }
  if (openLine !== -1) {
    ranges.push({ start: openLine + 1, end: lines.length });
  }
  return ranges;
}

function fenceContaining(
  line: number | undefined,
  ranges: FenceRange[],
): FenceRange | null {
  if (line == null) return null;
  for (const r of ranges) {
    if (line >= r.start && line <= r.end) return r;
  }
  return null;
}

function assignChunkIndices(segments: DiffSegment[]): void {
  let chunkIdx = -1;
  let lastWasChange = false;
  for (const s of segments) {
    if (s.type === 'same') {
      lastWasChange = false;
      continue;
    }
    if (!lastWasChange) chunkIdx++;
    s.chunkIndex = chunkIdx;
    lastWasChange = true;
  }
}

/**
 * Fence-aware segmenter. Like segmentDiff, but never splits a code fence
 * across segments. When any line inside a fenced block is added or removed,
 * the entire fence is emitted as a single removed segment (full old fence)
 * + a single added segment (full new fence). Without this, per-segment
 * markdown rendering produces nonsense for fences whose body changes —
 * the opening ``` line, the changed line, and the closing ``` end up as
 * three separate markdown documents and the fence never opens.
 *
 * Exported for unit testing.
 */
export function segmentDiffFenceAware(
  diffLines: DiffLine[],
  oldText: string,
  newText: string,
): DiffSegment[] {
  const oldFences = findFenceRanges(oldText);
  const newFences = findFenceRanges(newText);
  if (oldFences.length === 0 && newFences.length === 0) {
    return segmentDiff(diffLines);
  }
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');

  const segments: DiffSegment[] = [];
  let buf: string[] = [];
  let bufType: DiffSegmentType | null = null;
  const flush = () => {
    if (bufType === null) return;
    segments.push({ type: bufType, text: buf.join('\n') });
    buf = [];
    bufType = null;
  };

  let i = 0;
  while (i < diffLines.length) {
    const dl = diffLines[i];
    const oldFence = fenceContaining(dl.oldLineNo, oldFences);
    const newFence = fenceContaining(dl.newLineNo, newFences);

    if (oldFence || newFence) {
      flush();
      // Walk forward, consuming any subsequent diff lines that still belong
      // to the same old or new fence we just entered. This captures the
      // full extent of the fence in diff-line space, including interleaved
      // removed/added/same lines.
      let j = i + 1;
      while (j < diffLines.length) {
        const next = diffLines[j];
        const nextOld = fenceContaining(next.oldLineNo, oldFences);
        const nextNew = fenceContaining(next.newLineNo, newFences);
        const matchesOld = oldFence != null && nextOld != null && nextOld.start === oldFence.start;
        const matchesNew = newFence != null && nextNew != null && nextNew.start === newFence.start;
        if (matchesOld || matchesNew) {
          j++;
        } else {
          break;
        }
      }

      // Reconstruct each fence's full text from the source files. This is
      // the key insight: we ignore the per-line diff annotations within the
      // fence and re-render both the old and new fences in their entirety,
      // so the markdown pipeline always sees a balanced ```...``` block.
      const oldFenceText = oldFence
        ? oldLines.slice(oldFence.start - 1, oldFence.end).join('\n')
        : '';
      const newFenceText = newFence
        ? newLines.slice(newFence.start - 1, newFence.end).join('\n')
        : '';

      if (oldFence && newFence && oldFenceText === newFenceText) {
        // Fence touched by the diff but content is identical (e.g. only
        // surrounding lines moved). Emit as a single 'same' segment so the
        // chunk count doesn't include a phantom change.
        segments.push({ type: 'same', text: oldFenceText });
      } else {
        if (oldFenceText) segments.push({ type: 'removed', text: oldFenceText });
        if (newFenceText) segments.push({ type: 'added', text: newFenceText });
      }
      i = j;
      continue;
    }

    // Normal line — same accumulator behavior as segmentDiff.
    if (bufType === null || dl.type !== bufType) {
      flush();
      bufType = dl.type;
    }
    buf.push(dl.text);
    i++;
  }
  flush();

  assignChunkIndices(segments);
  return segments;
}

export interface RenderedDiffViewHandle {
  next: () => void;
  prev: () => void;
}

interface Props {
  rawMarkdown: string;
  diffSnapshot: string;
  /**
   * Pre-computed diff lines from the App-level useDiffLines hook so this
   * component renders the same change set the raw view sees.
   */
  diffLines: DiffLine[];
}

function escapeHtmlAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

export const RenderedDiffView = forwardRef<RenderedDiffViewHandle, Props>(
  function RenderedDiffView({ rawMarkdown, diffSnapshot, diffLines }, ref) {
    const containerRef = useRef<HTMLDivElement>(null);
    const [activeChunk, setActiveChunk] = useState(0);

    const segments = useMemo<DiffSegment[]>(
      // Fence-aware so a one-line edit inside a code fence doesn't shred
      // the fence into three malformed markdown documents (open, body,
      // close). The fence-aware path falls back to the original segmenter
      // when neither side has any fences.
      () => segmentDiffFenceAware(diffLines, diffSnapshot, rawMarkdown),
      [diffLines, diffSnapshot, rawMarkdown],
    );

    const chunkCount = useMemo(() => countChunks(segments), [segments]);
    const hasChanges = chunkCount > 0;
    // Snapshot vs current differ at the raw level but cleanMarkdown is identical:
    // the agent only edited inside comment markers (resolves, replies, edits).
    // Distinct from "snapshot is current and nothing has happened."
    const onlyCommentsChanged = !hasChanges && diffSnapshot !== rawMarkdown;

    const html = useMemo(() => {
      const parts: string[] = [];
      for (const seg of segments) {
        const inner = renderMarkdown(seg.text);
        if (seg.type === 'same') {
          parts.push(inner);
        } else {
          const cls =
            seg.type === 'added' ? 'rendered-diff-added' : 'rendered-diff-removed';
          const idx = seg.chunkIndex ?? 0;
          parts.push(
            `<div class="${cls}" data-chunk-index="${escapeHtmlAttr(String(idx))}">${inner}</div>`,
          );
        }
      }
      return parts.join('');
    }, [segments]);

    // Reset active chunk when the diff itself changes.
    useEffect(() => {
      setActiveChunk(0);
    }, [chunkCount]);

    // Manage innerHTML directly so React's reconciliation never touches it.
    useLayoutEffect(() => {
      if (!containerRef.current) return;
      containerRef.current.innerHTML = html;
    }, [html]);

    /** Find the scrollable container (descendant or ancestor). */
    const getScrollParent = useCallback((): Element | null => {
      if (!containerRef.current) return null;
      return (
        containerRef.current.querySelector('.overflow-y-auto') ??
        containerRef.current.closest('.overflow-y-auto')
      );
    }, []);

    const scrollToChunk = useCallback(
      (index: number) => {
        if (!containerRef.current) return;
        const target = containerRef.current.querySelector(
          `[data-chunk-index="${CSS.escape(String(index))}"]`,
        );
        if (!target) return;
        const scrollParent = getScrollParent();
        if (!scrollParent) {
          target.scrollIntoView({ behavior: 'smooth', block: 'start' });
          return;
        }
        const targetRect = target.getBoundingClientRect();
        const parentRect = scrollParent.getBoundingClientRect();
        scrollParent.scrollTo({
          top: scrollParent.scrollTop + targetRect.top - parentRect.top - 40,
          behavior: 'smooth',
        });
      },
      [getScrollParent],
    );

    // Auto-scroll to the first change on mount (RenderedDiffView only mounts
    // when diff is enabled, so this fires the moment the user enters diff
    // mode). Declared after scrollToChunk so the closure isn't reading a
    // forward reference.
    useEffect(() => {
      if (chunkCount === 0) return;
      const id = requestAnimationFrame(() => scrollToChunk(0));
      return () => cancelAnimationFrame(id);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const next = useCallback(() => {
      if (chunkCount === 0) return;
      const n = activeChunk < chunkCount - 1 ? activeChunk + 1 : 0;
      setActiveChunk(n);
      scrollToChunk(n);
    }, [activeChunk, chunkCount, scrollToChunk]);

    const prev = useCallback(() => {
      if (chunkCount === 0) return;
      const n = activeChunk > 0 ? activeChunk - 1 : chunkCount - 1;
      setActiveChunk(n);
      scrollToChunk(n);
    }, [activeChunk, chunkCount, scrollToChunk]);

    useImperativeHandle(ref, () => ({ next, prev }), [next, prev]);

    if (!hasChanges) {
      return (
        <div className="flex flex-col items-center justify-center py-16 text-content-muted">
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
      );
    }

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
      />
    );
  },
);
