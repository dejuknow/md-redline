import { useState, useEffect, useRef } from 'react';
import { getMermaidTheme, hasMermaidBlocks, renderMermaidBlock } from '../lib/mermaid-renderer';

export interface MermaidResult {
  svg?: string;
  error?: string;
}

const MERMAID_RENDER_DEBOUNCE_MS = 80;

/**
 * The one definition of what counts as a fenced Mermaid block this renderer
 * will ever produce an SVG for: a ```mermaid fence that opens at column 0
 * with nothing else on that line, and closes the same way. A fence inside a
 * blockquote or list item, a ~~~ fence, four backticks, a fence with trailing
 * text after "mermaid", or one left unclosed never matches, and MarkdownViewer
 * needs this exact list too: it renders those as plain code blocks, whose
 * text the comment painter already searches directly, so they must not be
 * treated as "waiting for a diagram to load" (see #99 follow-up).
 */
export function extractMermaidSources(cleanMarkdown: string): string[] {
  const sources: string[] = [];
  const regex = /^```mermaid\s*\n([\s\S]*?)^```\s*$/gm;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(cleanMarkdown)) !== null) {
    sources.push(match[1].trim());
  }
  return sources;
}

/**
 * Pre-renders mermaid code blocks found in the clean markdown.
 * Returns a Map from trimmed source text → rendered SVG (or error).
 * Results are cached and only re-rendered when source or theme changes.
 */
export function useMermaidRenderer(
  cleanMarkdown: string,
  theme: string,
  enabled = true,
): Map<string, MermaidResult> {
  const [svgMap, setSvgMap] = useState<Map<string, MermaidResult>>(new Map());
  const cacheRef = useRef<Map<string, { theme: string; result: MermaidResult }>>(new Map());
  const mermaidTheme = getMermaidTheme(theme);

  useEffect(() => {
    if (!enabled) {
      setSvgMap((prev) => (prev.size > 0 ? new Map() : prev));
      return;
    }

    if (!hasMermaidBlocks(cleanMarkdown)) {
      setSvgMap((prev) => (prev.size > 0 ? new Map() : prev));
      return;
    }

    const blocks = extractMermaidSources(cleanMarkdown);
    if (blocks.length === 0) {
      setSvgMap((prev) => (prev.size > 0 ? new Map() : prev));
      return;
    }

    let cancelled = false;
    let timeoutId: number | null = null;

    async function renderAll() {
      const newMap = new Map<string, MermaidResult>();
      const cache = cacheRef.current;

      for (const source of blocks) {
        // Use cache if same theme
        const cached = cache.get(source);
        if (cached && cached.theme === mermaidTheme) {
          newMap.set(source, cached.result);
          continue;
        }

        const result = await renderMermaidBlock(source, mermaidTheme);
        if (cancelled) return;

        const mermaidResult: MermaidResult =
          'svg' in result ? { svg: result.svg } : { error: result.error };
        newMap.set(source, mermaidResult);
        cache.set(source, { theme: mermaidTheme, result: mermaidResult });
      }

      if (!cancelled) {
        setSvgMap(newMap);
      }
    }

    timeoutId = window.setTimeout(() => {
      void renderAll();
    }, MERMAID_RENDER_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }
    };
  }, [cleanMarkdown, enabled, mermaidTheme]);

  return svgMap;
}
