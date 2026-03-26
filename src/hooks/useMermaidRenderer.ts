import { useState, useEffect, useRef } from 'react';
import { hasMermaidBlocks, renderMermaidBlock } from '../lib/mermaid-renderer';

export interface MermaidResult {
  svg?: string;
  error?: string;
}

/**
 * Pre-renders mermaid code blocks found in the clean markdown.
 * Returns a Map from trimmed source text → rendered SVG (or error).
 * Results are cached and only re-rendered when source or theme changes.
 */
export function useMermaidRenderer(
  cleanMarkdown: string,
  theme: string,
): Map<string, MermaidResult> {
  const [svgMap, setSvgMap] = useState<Map<string, MermaidResult>>(new Map());
  const cacheRef = useRef<Map<string, { theme: string; result: MermaidResult }>>(new Map());

  useEffect(() => {
    if (!hasMermaidBlocks(cleanMarkdown)) {
      if (svgMap.size > 0) setSvgMap(new Map());
      return;
    }

    // Extract mermaid blocks
    const blocks: string[] = [];
    const regex = /^```mermaid\s*\n([\s\S]*?)^```\s*$/gm;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(cleanMarkdown)) !== null) {
      blocks.push(match[1].trim());
    }
    if (blocks.length === 0) {
      if (svgMap.size > 0) setSvgMap(new Map());
      return;
    }

    let cancelled = false;

    async function renderAll() {
      const newMap = new Map<string, MermaidResult>();
      const cache = cacheRef.current;

      for (const source of blocks) {
        // Use cache if same theme
        const cached = cache.get(source);
        if (cached && cached.theme === theme) {
          newMap.set(source, cached.result);
          continue;
        }

        const result = await renderMermaidBlock(source, theme);
        if (cancelled) return;

        const mermaidResult: MermaidResult = 'svg' in result
          ? { svg: result.svg }
          : { error: result.error };
        newMap.set(source, mermaidResult);
        cache.set(source, { theme, result: mermaidResult });
      }

      if (!cancelled) {
        setSvgMap(newMap);
      }
    }

    renderAll();

    return () => {
      cancelled = true;
    };
  }, [cleanMarkdown, theme]);

  return svgMap;
}
