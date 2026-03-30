import { useState, useEffect, useRef, type RefObject, type MutableRefObject } from 'react';
import type { MarkdownViewerHandle, TocHeading } from '../components/MarkdownViewer';

export function useHeadingTracking(
  containerRef: RefObject<HTMLDivElement | null>,
  viewerRef: RefObject<MarkdownViewerHandle | null>,
  html: string,
): {
  tocHeadings: TocHeading[];
  activeHeadingId: string | null;
  setActiveHeadingId: (id: string | null) => void;
  spyDisabledRef: MutableRefObject<boolean>;
  scrollSpyRafRef: MutableRefObject<number>;
} {
  const [tocHeadings, setTocHeadings] = useState<TocHeading[]>([]);
  const [activeHeadingId, setActiveHeadingId] = useState<string | null>(null);
  const spyDisabledRef = useRef(false);
  const scrollSpyRafRef = useRef(0);

  // Extract headings from rendered HTML
  useEffect(() => {
    const headings = viewerRef.current?.getHeadings() ?? [];
    setTocHeadings(headings);
  }, [html, viewerRef]);

  // Track active heading based on scroll position
  useEffect(() => {
    const scrollEl = containerRef.current;
    if (!scrollEl || tocHeadings.length === 0) return;
    const ids = tocHeadings.map((h) => h.id);

    const runSpy = () => {
      cancelAnimationFrame(scrollSpyRafRef.current);
      scrollSpyRafRef.current = requestAnimationFrame(() => {
        const containerTop = scrollEl.getBoundingClientRect().top;
        const firstVisibleThreshold = scrollEl.clientHeight * 0.6;

        let lastAboveFoldId: string | null = null;
        let firstVisibleId: string | null = null;
        let firstVisibleTop = Infinity;
        for (const id of ids) {
          const el = scrollEl.querySelector(`#${CSS.escape(id)}`) as HTMLElement | null;
          if (!el) continue;
          const elTop = el.getBoundingClientRect().top - containerTop;
          if (elTop <= 0) {
            lastAboveFoldId = id;
          } else if (elTop < firstVisibleTop) {
            firstVisibleTop = elTop;
            firstVisibleId = id;
          }
        }

        const activeId =
          firstVisibleId !== null && firstVisibleTop < firstVisibleThreshold
            ? firstVisibleId
            : (lastAboveFoldId ?? firstVisibleId);
        setActiveHeadingId(activeId);
      });
    };

    const onScroll = () => {
      cancelAnimationFrame(scrollSpyRafRef.current);
      if (spyDisabledRef.current) return;
      runSpy();
    };

    const onManualScroll = () => {
      spyDisabledRef.current = false;
    };

    scrollEl.addEventListener('scroll', onScroll, { passive: true });
    scrollEl.addEventListener('wheel', onManualScroll, { passive: true });
    scrollEl.addEventListener('touchstart', onManualScroll, { passive: true });
    runSpy();
    return () => {
      scrollEl.removeEventListener('scroll', onScroll);
      scrollEl.removeEventListener('wheel', onManualScroll);
      scrollEl.removeEventListener('touchstart', onManualScroll);
      cancelAnimationFrame(scrollSpyRafRef.current);
    };
  }, [tocHeadings, containerRef]);

  return { tocHeadings, activeHeadingId, setActiveHeadingId, spyDisabledRef, scrollSpyRafRef };
}
