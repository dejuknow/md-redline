import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import panzoom, { type PanZoom } from 'panzoom';

export interface MermaidPanZoomCanvasHandle {
  fitToScreen: () => void;
  zoomBy: (factor: number) => void;
  panBy: (dx: number, dy: number) => void;
  panToElement: (el: SVGElement) => void;
  pulseElement: (el: SVGElement) => void;
}

export interface MermaidPanZoomCanvasProps {
  svgHtml: string;
  /** Re-render when this changes (e.g., source edited). */
  contentKey: string;
}

export const MermaidPanZoomCanvas = forwardRef<
  MermaidPanZoomCanvasHandle,
  MermaidPanZoomCanvasProps
>(function MermaidPanZoomCanvas({ svgHtml, contentKey }, ref) {
  const containerRef = useRef<HTMLDivElement>(null);
  const panzoomRef = useRef<PanZoom | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    container.innerHTML = svgHtml;
    const svg = container.querySelector('svg');
    if (!svg) return;

    svg.style.maxWidth = 'none';
    svg.style.height = '100%';
    svg.style.width = '100%';

    const instance = panzoom(svg, {
      maxZoom: 10,
      minZoom: 0.1,
      bounds: false,
      smoothScroll: false,
      // Disable double-click zoom: it conflicts with double-click-to-select-word.
      zoomDoubleClickSpeed: 1,
      // Returning true skips panning so the browser handles the event natively —
      // here, that means a click-drag on a node label does text selection
      // instead of panning the diagram.
      beforeMouseDown: (e) => {
        const target = e.target as Element | null;
        if (!target) return false;
        return target.tagName === 'text' || target.closest('text') !== null;
      },
    });
    panzoomRef.current = instance;

    // Fit-to-screen on first paint. We wait one frame for the SVG to lay out
    // (otherwise getBoundingClientRect() returns zeros and the math collapses
    // to "scale 1, top-left origin", which leaves large diagrams jammed in the
    // corner instead of centred).
    const fitFrame = window.requestAnimationFrame(() => {
      const svgRect = svg.getBoundingClientRect();
      const containerRect = container.getBoundingClientRect();
      if (svgRect.width === 0 || containerRect.width === 0) return;
      const scaleX = containerRect.width / svgRect.width;
      const scaleY = containerRect.height / svgRect.height;
      const scale = Math.min(scaleX, scaleY, 1);
      instance.zoomAbs(0, 0, scale);
      instance.moveTo(
        (containerRect.width - svgRect.width * scale) / 2,
        (containerRect.height - svgRect.height * scale) / 2,
      );
    });

    return () => {
      window.cancelAnimationFrame(fitFrame);
      instance.dispose();
      panzoomRef.current = null;
    };
  }, [svgHtml, contentKey]);

  useImperativeHandle(ref, () => ({
    fitToScreen: () => {
      const container = containerRef.current;
      const instance = panzoomRef.current;
      if (!container || !instance) return;
      const svg = container.querySelector('svg');
      if (!svg) return;
      // Reset to identity first so getBoundingClientRect reflects the SVG's
      // intrinsic rendered size — without this step, fitting after the user
      // has zoomed/panned would derive a scale from the already-transformed
      // dimensions and over-shrink (or mis-centre) the diagram.
      instance.zoomAbs(0, 0, 1);
      instance.moveTo(0, 0);
      const svgRect = svg.getBoundingClientRect();
      const containerRect = container.getBoundingClientRect();
      if (svgRect.width === 0 || svgRect.height === 0) return;
      const scaleX = containerRect.width / svgRect.width;
      const scaleY = containerRect.height / svgRect.height;
      const scale = Math.min(scaleX, scaleY, 1); // never blow up beyond natural size
      instance.zoomAbs(0, 0, scale);
      instance.moveTo(
        (containerRect.width - svgRect.width * scale) / 2,
        (containerRect.height - svgRect.height * scale) / 2,
      );
    },
    zoomBy: (factor: number) => {
      const container = containerRef.current;
      const instance = panzoomRef.current;
      if (!container || !instance) return;
      const rect = container.getBoundingClientRect();
      instance.smoothZoom(rect.width / 2, rect.height / 2, factor);
    },
    panBy: (dx: number, dy: number) => {
      const instance = panzoomRef.current;
      if (!instance) return;
      const t = instance.getTransform();
      instance.moveTo(t.x + dx, t.y + dy);
    },
    panToElement: (el: SVGElement) => {
      const instance = panzoomRef.current;
      const container = containerRef.current;
      if (!instance || !container) return;
      const elRect = el.getBoundingClientRect();
      const containerRect = container.getBoundingClientRect();
      const dx = containerRect.width / 2 - (elRect.left + elRect.width / 2 - containerRect.left);
      const dy = containerRect.height / 2 - (elRect.top + elRect.height / 2 - containerRect.top);
      const transform = instance.getTransform();
      instance.moveTo(transform.x + dx, transform.y + dy);
    },
    pulseElement: (el: SVGElement) => {
      el.classList.add('mermaid-fullscreen-pulse');
      window.setTimeout(() => el.classList.remove('mermaid-fullscreen-pulse'), 1200);
    },
  }));

  return (
    <div className="mermaid-fullscreen-canvas">
      <div ref={containerRef} className="mermaid-fullscreen-canvas-inner" />
    </div>
  );
});
