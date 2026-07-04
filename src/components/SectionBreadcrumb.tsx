import { useEffect, useState } from 'react';
import type { TocHeading } from './MarkdownViewer';

interface Props {
  chain: TocHeading[];
  containerRef: React.RefObject<HTMLElement | null>;
  onJump: (id: string) => void;
  /** Test hook: start visible without scrolling (jsdom cannot scroll). */
  initialVisible?: boolean;
}

/**
 * Floating breadcrumb naming the current section once the reader scrolls past
 * the first heading. Content comes from headingChain; this component only owns
 * the scrolled visibility check and rendering.
 */
export function SectionBreadcrumb({ chain, containerRef, onJump, initialVisible = false }: Props) {
  const [scrolled, setScrolled] = useState(initialVisible);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const first = el.querySelector('h1, h2, h3, h4, h5, h6');
        if (!first) {
          setScrolled(false);
          return;
        }
        const containerTop = el.getBoundingClientRect().top;
        const firstBottom = first.getBoundingClientRect().bottom - containerTop;
        setScrolled(firstBottom < 0);
      });
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => {
      el.removeEventListener('scroll', onScroll);
      cancelAnimationFrame(raf);
    };
  }, [containerRef]);

  if (!scrolled || chain.length === 0) return null;

  return (
    <div
      data-section-breadcrumb
      className="breadcrumb-enter absolute top-2 left-1/2 -translate-x-1/2 z-10 flex items-center gap-1 px-3 py-1 rounded-full border border-border bg-surface-secondary/90 backdrop-blur shadow-sm max-w-[80%]"
    >
      {chain.map((h, i) => (
        <span key={h.id} className="flex items-center gap-1 min-w-0">
          {i > 0 && <span className="text-content-faint text-xs shrink-0">&rsaquo;</span>}
          <button
            type="button"
            onClick={() => onJump(h.id)}
            title={h.text}
            className="text-xs text-content-secondary hover:text-content truncate max-w-[28ch] cursor-pointer transition-colors"
          >
            {h.text}
          </button>
        </span>
      ))}
    </div>
  );
}
